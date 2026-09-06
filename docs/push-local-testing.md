# Testing driver offer push locally

How to prove an offer reaches a driver's phone **without deploying anything and
without touching the production Supabase or Firebase projects.**

Everything here uses throwaway projects you own. The client's `ingo-92d5f`
Firebase project and their production Supabase are never involved. When the
loop works end to end, hand the client's developer the deployment note at the
bottom.

## What you are proving

Push has two halves, and they fail independently:

| Half | Owner | Proved by |
|---|---|---|
| **Device can receive** — token obtained, channel exists, permission granted, notification renders, tap opens the app | the app | `scripts/send-test-offer.js` to one token |
| **Server sends to the right drivers** — picks online drivers, reads their tokens, builds the message | `driver-offer-push` edge function | a real order in a Supabase project you own |

Do the first half first. It needs only Firebase. If the device cannot receive,
nothing the server does matters.

## Part 1 — device receives (Firebase only, ~15 min)

### One-time setup

1. **Create your own Firebase project.** `console.firebase.google.com` → Add
   project → any name, e.g. `ingo-local-test`. Not the client's.
2. **Add an Android app** to it with package name exactly `com.kigatta.ingo`.
   Download `google-services.json` and put it at `android/app/google-services.json`.
   It is gitignored — it is a test-project file and must never be committed.
3. **Generate a sender key.** Project settings → Service accounts → *Generate new
   private key* → save as `.secrets/fcm-service-account.json`. Also gitignored.
4. Rebuild, because the Gradle google-services plugin only applies when the
   JSON is present:
   ```bash
   npm run build && npx cap sync android
   cd android && ./gradlew assembleDebug && cd ..
   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
   ```

### Get a device token

Token registration runs on driver sign-in. Until Part 2 gives you a driver
account, seed a session directly in the WebView so the registration path runs.
This writes to the phone's own storage only.

```bash
# find the WebView and forward its debugger
PID=$(adb shell pidof com.kigatta.ingo | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
```

Open `chrome://inspect` in desktop Chrome, pick the InGo WebView, and in its
console:

```js
sessionStorage.setItem('ingo_driver_signed_in','1');
sessionStorage.setItem('ingo_driver_profile', JSON.stringify({
  id:'00000000-0000-4000-8000-000000000000', full_name:'Local Test',
  email:'local@test.invalid', status:'approved', account_mode:'solo'
}));
location.reload();
```

Then read the outcome — this is the line that tells you whether the device half
works at all:

```bash
adb logcat -d | grep -E "push token (stored|NOT stored)"
```

- `push token stored {"platform":"android"}` → copy the token from the
  `driver_push_tokens` upsert, or add a temporary `console.info(token)` next to
  the upsert in `src/lib/driverPush.js` while testing.
- `push token NOT stored {...}` → the `error` field says why. Permission denied,
  no google-services, registration timed out. Fix that before going further.

**Expect this seeded session to be bounced to `/driver/login` by
`DriverApprovalGate`** — it checks the driver against the database, and there
is no such driver. That is fine. Token registration runs in the bootstrap
*before* the gate, which is the only reason this shortcut works.

### Send an offer to the device

```bash
node scripts/send-test-offer.js <token>          # ring
node scripts/send-test-offer.js <token> --stop   # cancel it
```

The script sends the **byte-identical** FCM v1 message the edge function sends.
If you change the message shape in
`supabase/functions/driver-offer-push/index.ts`, change it here too or you are
no longer testing the real thing.

### What to check, in this order

1. **App in foreground.** Logcat shows `[driverPush] payload received {...}` and
   the in-app ring fires.
2. **App backgrounded, screen off.** A notification appears with sound. Logcat
   shows **nothing** from `driverPush` — that is correct and expected: the OS
   renders a message that carries a `notification` block, no app code runs. See
   `docs/adr/0001`.
3. **Tap the notification.** App comes to front; logcat shows
   `[driverPush] offer tapped {...}` then `[DriverOffers] routing to tapped offer`.
4. **App killed (swiped away).** State honestly what happens. Some OEMs drop
   delivery entirely for a killed app without a foreground service.
5. **`--stop`.** The notification is withdrawn.

## Part 2 — server sends to the right drivers (needs a Supabase project you own)

The edge function picks online drivers, reads their tokens and sends. Testing
that needs a database with a real approved driver in it — a fake session will
not pass `DriverApprovalGate`.

1. Create a free Supabase project of your own.
2. Open its **SQL editor** and paste the whole of
   **`supabase/bundle/all-in-order.sql`** — all 69 migration files in dependency
   order, generated by `scripts/build-migration-bundle.js`. Run it once.
   The seed for the test driver (`testdriver@bykea.test` / `TestDriver123!`,
   approved, deposit paid) is the clearly marked **optional last block**; keep it
   in for a throwaway project, delete it for anything else.
   If Postgres says `relation "x" does not exist`, the manifest at the top of the
   bundle names which file created what — fix the order in the generator, not
   by hand, and re-run it.
3. Point the app at it in `.env.local`:
   ```
   REACT_APP_SUPABASE_URL=https://<your-ref>.supabase.co
   REACT_APP_SUPABASE_ANON_KEY=<your anon key>
   ```
4. Deploy `driver-offer-push` **to your project**, with secrets from **your**
   Firebase service account. `npx supabase` works as-is — verified here,
   CLI 2.116.0 — but the **first run downloads the binary and can take several
   minutes with no output**. Do not assume it hung. If you would rather have it
   installed: `scoop install supabase` (Windows) or `npm install --save-dev supabase`.
   One command does deploy + secrets, non-interactively (no browser login):
   ```bash
   # Dashboard → avatar → Account → Access Tokens → generate. Account-wide; rotate after.
   SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/deploy-push-sender.sh <your-ref>
   ```
   It reads `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` from
   `.secrets/fcm-service-account.json` — the exact names the function reads.
   `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.

   **It deploys with `--no-verify-jwt`, and that is not optional on a project using
   new-format API keys.** The app invokes this function with the public key and no
   user session. The legacy `anon` key is a JWT and passed the gateway's default
   verification by accident; `sb_publishable_…` keys are not JWTs, so with
   verification on every call is rejected with 401 before the function runs.
   `supabase/config.toml` records the same setting. If the client's production
   project ever moves to new-format keys, **every** function the app calls from the
   browser needs this — see the security notes for why that is the wrong long-term
   answer (the functions authenticate nothing themselves).
5. Sign in as the test driver on the device, go online, then place an order from
   the customer side against the same project. The driver's phone should ring.

Nothing in Part 2 reaches the client's infrastructure. Their developer
reproduces the same steps against production when they deploy.

## Handover note for the client's developer

When the loop above works, these are the production steps. All of them are
console actions or deploys on infrastructure the client owns:

1. **Firebase `ingo-92d5f`:** add an Android app with package `com.kigatta.ingo`
   (or whatever package the shipped app actually uses — check the store listing),
   download `google-services.json`, place it in the Android project that builds
   the store app.
2. **Manifest:** ensure `android.permission.POST_NOTIFICATIONS` is declared, as in
   `android/app/src/main/AndroidManifest.xml` here.
3. **Deploy** the edited `supabase/functions/driver-offer-push/index.ts`. The
   only changes are `ttl` and `collapse_key` on the ring message.
4. **Ship the app update.** Everything in `src/lib/driverPush.js`,
   `src/lib/driverPushBootstrap.js`, `src/lib/driverSession.js`, `src/index.js`
   and `src/components/driver/DriverOffersProvider.js`.
5. **Verify on one real driver's phone** before announcing it. Then run
   `select count(*) from driver_push_tokens` — if it is still zero a week later,
   registration is not running in the shipped build.

## `invalid_grant` means the key is gone, not the code

If the deployed sender answers `Google auth failed: invalid_grant`, or
`send-test-offer.js` prints `invalid_grant: Invalid JWT Signature`, the
service-account private key has been deleted or rotated in the Firebase
console. Nothing in the app or the function is wrong. Generate a new key
(Project settings → Service accounts → Generate new private key), save it as
`.secrets/fcm-service-account.json`, and re-set the function secret with
`scripts/deploy-push-sender.sh`. Seen 2026-09-06 after the 2026-09-03 key was
revoked as planned.

## The crash you must know about

**Driver sign-in crashes the app if `google-services.json` is missing.** Not
"push fails" — the process dies. Observed on device 2026-09-02:

```
FATAL EXCEPTION: CapacitorPlugins
IllegalStateException: Default FirebaseApp is not initialized in this process
  at PushNotificationsPlugin.register(PushNotificationsPlugin.java:103)
```

It is thrown on the native plugin thread inside the reflective call, so no JS
`try/catch` can reach it. There is no runtime guard that works. The only real
protection is at build time, so `android/app/build.gradle` now **refuses to
produce a release build without the file**, with a message naming this crash.
Debug builds still succeed (with a `warn`), which is how local work proceeds.

Before this session the same code path failed *earlier*, in JS, on a
`.then()` call against a non-Promise (`t.addListener(...).then is not a
function`). That bug hid the crash. Fixing the JS bug exposed the native one.
Both are fixed in this branch; the order they were found in is the reason the
Gradle guard exists.

## Part 3 — Accept / Decline on the notification itself (Android)

Since 2026-09-03 the Android leg of the offer message is **data-only** and the
app draws the notification natively (`OfferMessagingService.java`, ADR 0002).
Two action buttons, Accept and Decline, run the same code the in-app card runs.

What to check, in this order:

1. `adb logcat -s IngoOfferPush` shows
   `message type=offer_ring … hasNotificationBlock=false` then `posted tag=…`.
   If `hasNotificationBlock=true`, an old sender is deployed: the buttons will
   not exist because Android rendered the banner itself.
2. The notification shows **Accept** and **Decline**. Android shows action
   buttons only on the *expanded* row. A fresh arrival is expanded; once the
   shade has been touched the row collapses and the buttons sit behind the
   chevron. That is Android, not a defect.
3. Press Accept with the app backgrounded, killed, or on the lock screen. The
   app opens (this is deliberate; the accept needs the app's Supabase client)
   and the log shows, in order:
   `[driverPush] offer tapped {… "action":"accept"}` →
   `[DriverOffers] notification button accept -> <table>:<id>` →
   `[DriverOffers] accept result {"ok":true,…}`.
   Then the order row is `assigned`, the notification is withdrawn, and the app
   is on `/driver/active-delivery` (shop / instant-claim) or shows "Offer sent.
   Waiting for the customer to choose you." (parcel / taxi / tuk bids).
4. Press Decline on another offer: `[DriverOffers] decline result {"ok":true}`,
   the driver's id appears in the order's `rejected_driver_ids`, the
   notification is withdrawn, and the app shows "Declined."
5. Press a button on an offer another driver already took: the app shows
   "Order already accepted" (or "no longer available" after a 20 s wait if the
   poll no longer returns it) and withdraws the notification. The payload is
   never trusted for the offer itself.

`scripts/send-test-offer.js` sends the same data-only shape, so Part 1 can be
run without a Supabase project and still shows the buttons.
With `OFFER_KEY=<table>:<uuid>` (2026-09-06) the buttons act on a real row in
whichever project the app is pointed at, so Accept can be proven against the
database without deploying the sender.

Two things this pass fixed on the way, both worth knowing:

- `DriverApprovalGate` used to sign the driver out whenever the approval check
  *failed* (network error), not only when it said "not approved". A cold start
  from a notification on a weak connection hit exactly that. The check is now
  tri-state and the gate only clears on an explicit "no".
- The Supabase client ran an unused auth session machinery whose lock stalled
  every WebView request by ~5 s. It is switched off (`supabaseClient.js`).

## Known limits of this pass

- The **in-app ring is foreground-only**. Backgrounded drivers get the standard
  channel sound. A ringing, answerable lock-screen offer is a separate piece of
  work (ADR 0001 explains why).
- **No foreground service.** Aggressive battery managers may stop delivery for a
  killed app. The 2.5 s poll in `DriverOffersProvider` covers a driver who has
  the app open; nothing covers one who does not.
- **iOS** is untouched.

Update 2026-09-03: Accept / Decline buttons now exist on the Android
notification (Part 3). The ringing lock-screen takeover and a looping sound are
still not built; they need a foreground service first.
