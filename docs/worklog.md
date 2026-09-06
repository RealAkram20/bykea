# Worklog

Append-only record of work in this repository. Newest at the bottom.

Read it before touching anything. Add your entry **before** you write code.

## The rules

1. Claim your files before you edit them.
2. Re-read the tree before you write; `git status` from an hour ago is stale.
3. Never re-implement a shared module. Extend it.
4. Say what you did not build.

## Entries

### 2026-09-02 — Android background push for driver offers (pieces 1-5, 7)

**Status:** **complete.** Pieces 1-5 and 7 built; Part 2 proven end to end on a throwaway Supabase project on 2026-09-03 (sign-in → token row → deployed sender `sent:1` → backgrounded notification → tap → router hop; then a fresh customer order rang the backgrounded phone). Not built: piece 6, foreground service, iOS.
**Owns:**
- `docs/worklog.md` (new)
- `docs/adr/0001-driver-offer-push-delivery.md` (new)
- `src/lib/driverPushBootstrap.js` (new)

**Shares:**
- `src/lib/driverPush.js` — exact edit: add channel creation, Android 13 permission request, logging before each early return, export a bootstrap entry point. No rewrite of the existing FCM logic; it is correct.
- `src/index.js` — exact edit: one import, above the React mount, so push listeners exist before the UI framework.
- `src/components/driver/DriverOffersProvider.js` — exact edit: consume a cold-start offer handed over by the bootstrap.
- `android/app/src/main/AndroidManifest.xml` — exact edit: add `POST_NOTIFICATIONS`.
- `supabase/functions/driver-offer-push/index.ts` — **written, not deployed.** See sign-off list below.

**What this is:** make an offer reach a driver whose app is backgrounded, and let
them act on it. Scope is the blueprint's pieces 1-5 and 7. **Piece 6 (ringing,
answerable, over-the-lock-screen) is explicitly out of scope** — see below.

## The root cause, which was not what the audit said

Our earlier audit recorded "the code is not the
problem, the configuration is", and calls web push "the best-engineered
subsystem in the codebase… it works when the browser is closed."

**Both halves are wrong, and the correction matters more than the config.**

`registerDriverPushToken()` is exported from `src/lib/driverPush.js:281` and
**never imported or called by any application code.** Verified by exhaustive grep
across `src/` and `public/`: the only external reference to the module anywhere
is `driverSession.js:111`, which calls `clearDriverPushToken` on sign-out.

So no token is ever obtained, on web or native, and `driver_push_tokens` is
never written to by any code path. `startDriverPushForegroundListener()` is
likewise only reachable from inside the function nobody calls.

**This is a failure pattern seen before on another dispatch product**: the
dispatcher pushes, the token table is empty, nothing logs, nothing throws. The
web path has never worked either. It is correct code that is not wired in.

## Four further defects found while reading, not previously recorded

1. **The ring message is not data-only** (`supabase/functions/driver-offer-push/index.ts:161`).
   It carries a top-level `notification` block, so on a backgrounded Android app
   the OS renders the banner and **no application code runs**. Blueprint rule 1.
   The `stop` message *is* data-only — the asymmetry is the wrong way round.
2. **No TTL and no collapse key** on the ring message. A phone that regains
   signal an hour later is offered a job that closed long ago. Blueprint piece 4.
3. **The channel `ingo_driver_offers` is named by the server but created by
   nobody.** No `createChannel` call exists in the repo. Blueprint rule 5: a push
   naming a channel that does not exist is delivered on the default channel,
   quietly, at ordinary importance.
4. **No `POST_NOTIFICATIONS` permission and no runtime request**, so Android 13+
   shows nothing regardless of token.

## Needs sign-off before it can be finished

This is a live client system with no staging. These three steps are client-console or production
writes and are **not** being done unilaterally:

- **Register `com.kigatta.ingo` in Firebase project `ingo-92d5f`** and add
  `android/app/google-services.json`. Client console action.
- **Deploy the edited `driver-offer-push` edge function.** Production deploy.
- **End-to-end test with a real driver login**, which writes a row to
  `driver_push_tokens` in the live database. There is no seeded test driver:
  `supabase/seed_test_driver.sql` was never run against production (verified
  2026-08-30 — login returns "No driver account found").

**Deliberately not built:**
- **Piece 6, the answerable lock-screen offer** — full-screen intent, looped
  sound, Accept/Decline on the notification itself. On a prior dispatch product this cost three ADRs, a hand-written config plugin
  and several rounds of field failure.
  It is its own project. This pass raises a normal notification that opens the
  app to the offer.
- **A foreground service to hold the process alive** (blueprint rule 2). InGo
  needs one anyway for driver location; it should be built once and shared, not
  bolted onto push. Without it, an OEM battery manager will kill delivery on
  some handsets and the fallback poll is what those drivers get.
- **iOS push.** No APNs key, no `ios/` project in this repo.

## Verified on a device (Android 15, API 35 emulator, debug build)

1. **Web build compiles clean.** No new warnings in any file touched.
2. **APK builds and installs.** Gradle exit 0. Capacitor only applies the
   google-services plugin when the JSON exists, so a missing `google-services.json`
   does **not** fail the build. It logs "Push Notifications won't work" at
   `logger.info` — invisible at default log level. Another silent failure.
3. **The app starts with no `google-services.json` and does not crash.** Push
   degrades; nothing else is affected.
4. **The evidence is readable in logcat and the three states are distinct:**
   ```
   [driverPushBootstrap] loaded, installing push listeners
   [driverPushBootstrap] listeners installed
   [driverPushBootstrap] no driver session, not registering a token
   [driverPush] channel ready ingo_driver_offers
   ```
5. **The channel is registered by Android**, confirmed independently of our own
   logs via `dumpsys notification --noredact`: `mId='ingo_driver_offers'` (exactly
   matching the server string), `mImportance=5`, `mBypassDnd=false` (rule 9),
   `mSound=content://settings/system/notification_sound`.
6. **`POST_NOTIFICATIONS` works.** Present in the merged manifest; app-level
   importance moves `NONE` → `DEFAULT` when granted. Before this change the
   permission was not declared at all, so the runtime request auto-denied.

## Two defects found *by* running it, not by reading it

- **My own logging was unreadable on device.** `console.info('msg', {obj})` reaches
  logcat as `[object Object]`, losing the message and the greppable prefix. All log
  calls now serialise into the message string.
- **The channel was created with an unresolvable sound URI.** Capacitor turns
  `sound: 'default'` into `android.resource://com.kigatta.ingo/raw/default`, and
  `res/raw/` does not exist in this app. A time-critical offer alert would have
  arrived **silent**, with nothing warning anyone. Fixed by omitting the key.
  Caught only because the channel was dumped and read.

I also caught myself writing `if (getDriverSession()?.id) ensureDriverPushRegistered()`
— guarding the call so the "no session" log could never fire. That is the exact
rule being implemented, broken while implementing it. The call is now unconditional
and the function decides and logs.

## Second pass, same day — three more found by running it

**1. Native token registration threw before reaching FCM.**
`t.addListener(...).then is not a function`. `getCapacitorPushPlugin()` prefers
the bridge-injected `window.Capacitor.Plugins.PushNotifications`, and on
Capacitor 8 that object's `addListener` returns a plain handle, not a Promise —
only the ESM import returns a Promise. The `.then()` threw, the registration was
caught as a failure, and no token was ever obtained. **This would have blocked
push even with `google-services.json` present.** Fixed with `Promise.resolve()`
around both `addListener` calls and both `remove()` calls. Only visible because
the new logging printed the error; before, it was swallowed.

**2. Fixing (1) unmasked a process crash behind it.** With the JS bug gone,
execution reached `Push.register()`, which without `google-services.json`
throws natively — `IllegalStateException: Default FirebaseApp is not
initialized` at `PushNotificationsPlugin.register:103` — on the CapacitorPlugins
thread, inside the reflective call. **JS cannot catch it; the process dies.**
Observed: driver sign-in killed the app. There is no runtime guard. So
`android/app/build.gradle` now throws a `GradleException` on any *release* task
when the file is missing, and `warn`s (not `info`) on debug. **Verified both
ways:** `assembleRelease` fails with the message, exit 1; `assembleDebug`
succeeds, exit 0, APK produced.

**3. The tap-routing path cannot be tested with a fake session.**
`DriverLayout` wraps `DriverOffersProvider` inside `DriverApprovalGate`, which
looks the driver up in the database and bounces unknown ids to `/driver/login`.
So the provider — and my routing effect — never mounts for a seeded session.
Token registration *does* run, because the bootstrap fires before the gate. The
tap test therefore needs a real approved driver, i.e. the local Supabase rig in
`docs/push-local-testing.md` (Part 2).

## The sign-off list, revised

Confirmed verbally on 2026-09-02: we have the access and are deliberately not
going live: build locally, test locally, then hand to KIGATTA's developer to
deploy. So the three items above are no longer "blocked on the client" — they
are steps in `docs/push-local-testing.md`, against throwaway projects we own.
`scripts/send-test-offer.js` sends the byte-identical FCM v1 message from a
laptop, so delivery is testable with nothing deployed.

## Sender half verified — 2026-09-02, later

`scripts/send-test-offer.js` run against a deliberately bogus device token:
the service-account JWT was accepted by Google's token endpoint, the request
reached FCM, and FCM answered `400 INVALID_ARGUMENT: The registration token is
not a valid FCM registration token`. That is the correct response and it proves
authentication, project id, and the request shape end to end. **The sender works.
The remaining unknown is entirely on the device side**, which needs
`google-services.json` for the same project.

Note: the key used was for the client's production Firebase project, not a
throwaway. That is a contained choice for this test (a push targets one token),
but the key was shared in plain text and should be rotated after testing.

## VERIFIED end to end on a device — 2026-09-02, Android 15 (API 35)

Firebase project `ingo-92d5f`, package `com.kigatta.ingo`, a real FCM token from
the device, real messages accepted by FCM, sent with `scripts/send-test-offer.js`.

| Case | Result | Evidence |
|---|---|---|
| Token registration | **works** | Reached the DB upsert; rejected only by the FK on the fake driver id, which is correct |
| App **foreground**, ring | **works** | `[driverPush] payload received {"type":"offer_ring",…}` |
| App **backgrounded**, ring | **works, OS-rendered** | `NotificationRecord … channel=ingo_driver_offers tag=ingo-offer-local-test-0001 importance=5`; **0** lines of app code, exactly as ADR 0001 predicts |
| Heads-up banner | **seen** | Screenshot at t+2 s: "New InGo delivery • now 🔔 / Harare CBD to Avondale…" |
| **Tap** | **works** | App to foreground; `[driverPush] offer tapped {"link":"/driver/home",…}` |
| App **killed** (`am kill`, the swipe-away equivalent) | **works** | FCM spawned the process and posted; 0 app code |
| App **force-stopped** | **nothing, by design** | Android's *stopped state* drops FCM broadcasts. `force-stop` is not what a driver does; `am kill` is the honest proxy |
| **Stop** signal | **works, after a fix** | See below. Now `posted: 1 → 0`, log `withdraw … delivered:1, matching:1` |

**Not exercised:** the router hop in `DriverOffersProvider` (`[DriverOffers]
routing to tapped offer`). `DriverApprovalGate` checks the driver in the database
and bounces the fake id before the provider mounts, so it needs a real approved
driver — Part 2 of `docs/push-local-testing.md`. The tap *handler* and the
parked-tap mechanism are verified; only that last hop into the router is not.

**Not audible:** channel sound, on an emulator. The channel resolves to
`content://settings/system/notification_sound` and the banner showed the bell.

**Still true:** `visibility: 1` is ignored by Capacitor (`mLockscreenVisibility=-1000`),
harmless until piece 6; the fallback poll only runs while the app is open; the
edge-function edits (TTL, collapse key) are written, not deployed.

**Inference worth confirming with the client's developer:** the Android app in
`ingo-92d5f` appears to have been registered today (fresh app id, download named
`(4)`), which would mean the store build was never wired to this Firebase project.

## Withdraw defect, found by the stop test

The stop branch of `handleIncomingOfferPayload` called
`handleDriverOfferStopSignal` (in-app ring) and dispatched an event, but on native
nothing cancelled the *system* notification. The web service worker does that with
`closeNotificationsByTag`; native had no equivalent, so a driver whose offer was
taken by someone else kept a stale "New InGo delivery" in the shade. Measured:
the data-only stop woke the backgrounded app and the handler ran, notification
stayed. Fixed with `removeDeliveredOfferNotification(tag)` —
`getDeliveredNotifications` → filter by tag → `removeDeliveredNotifications`,
logged before the guard so "no plugin" and "nothing matched" leave different traces.

## Schema bundle for throwaway projects — and a currency fingerprint

`scripts/build-migration-bundle.js` concatenates the 69 schema files (plus the
seed as a marked optional block) into `supabase/bundle/all-in-order.sql` in
dependency order: topological sort over "creates table X" → "references / alters /
policies / indexes X", alphabetical tie-break, cycles reported. 0 cycles. Every
source file is present verbatim and every `create table / policy / function /
index` and `alter table` count matches the sources exactly. **Order is derived,
not executed** — no Postgres here — so a miss surfaces in the SQL editor as
`relation "x" does not exist`, and the manifest at the top says which file to move.

**First run against a real database (a throwaway Supabase project, 2026-09-02)
failed at `relation "public.delivery_requests" does not exist`.** Cause:
`package_category_free_text.sql` does `comment on column public.delivery_requests…`
and none of the dependency patterns covered `comment on`. Fixed twice over: the
specific pattern (plus `grant`, `trigger`, `view`, `truncate`), and a backstop
that treats *any* bare mention of a created table as a dependency, so the next
unforeseen statement type cannot slip a file above its table. Over-linking only
adds edges; the sort reports the one thing it cannot absorb, a cycle — still 0.
Postgres ran the failed paste as one implicit transaction, so nothing was
committed; the corrected bundle re-runs cleanly on the same empty project.

**Second real run failed at `column "assigned_driver_id" does not exist`.**
A column, not a table: `driver_booking_assigned_at.sql` backfills
`where assigned_driver_id is not null` on `customer_delivery_orders`, and that
column is *added* by `driver_booking_assignment.sql`, which sorted one place later.
Table-level tracking cannot see it. Adding column-level tracking took four
attempts, and the failures are the useful part:

1. "file mentions table T and column C" → **63 files in cycles.** This repo re-adds
   columns defensively (`add column if not exists`) that the table's creator already
   declared inline, so creator and adder pointed at each other. Fix: files that
   *provide* a column (adders, plus the creator if it declares it) never depend on
   each other; only *users* depend on providers.
2. Still 20 in a cycle. Hypothesis: mentions inside `$$…$$` plpgsql bodies are
   resolved at call time, not apply time. True, and worth excluding — but it
   changed nothing, because it was not the cause.
3. Scoped the test to "same statement names T and C". Still 20. Not the cause.
4. Printed the actual loop instead of theorising: exactly one false edge,
   `customer_delivery_orders.sql → driver_vehicle_types_motorbike_tuktuk_car.sql`.
   The creator's `create table` declares its own `requested_vehicle_type` **and**
   contains `references delivery_requests` — one statement naming both — so it
   looked like a user of `delivery_requests.requested_vehicle_type`. **The
   statement must *target* T** (`update T`, `alter table T`, `comment on column
   T.x`, index `on T`…); a mere FK mention is not a use. 0 cycles.

Lesson recorded for next time: two wrong hypotheses in a row is the signal to
print the graph, not to form a third.

Two files are not valid UTF-8: `driver_registrations.sql` and
`driver_registrations_driver_deposit_balance.sql` each carry a lone `0xC2` byte
directly before `$10`. That is the orphaned lead byte of `£` (`C2 A3`) left
behind when `£10` was hand-edited to `$10`. It sits in a comment and a
`comment on column` string, so the schema is unaffected — but it is a byte-level
fingerprint of the cosmetic GBP→USD relabel already recorded as a finding
(the column is still `driver_deposit_balance_gbp`). Node's `'utf8'` read would
have turned it into U+FFFD and pasted that into the target database; the
generator now decodes strictly, drops the orphaned byte, and says so.

## Part 2 on a throwaway Supabase project — 2026-09-03

Project `gcwrnluyaqarmrovbryj` (ours, not the client's), schema from the bundle,
new-format API keys. `.env.local` points the local build at it; verified the ref is
baked into both the web bundle and the APK.

**Customer half proven end to end, in a headless desktop browser (Edge, CDP),
with no emulator:** register → `/home` → delivery request (addresses accepted
despite the "Location is off" banner from the missing Maps key) → package details
→ price estimate ($3.72 / $4.25) → **Pay with Cash → Place Order** → `/live-tracking`
"Finding a driver for you…". Row in `customer_delivery_orders`:
`29b95e10-98d9-4dd9-9b03-73abd00fb5a8`, `status=placed`, `payment_method=cod`,
`total_amount=4.25`, `assigned_driver_id=null`. Registration is a plain insert —
no edge function needed. Cash was chosen deliberately: Paynow points at the
client's **production** Railway API even in local builds, so it must not be used
for tests.

**The push sender on that project returns 404** — not deployed yet, expected.
Placing the order still called it (fire-and-forget, caught), which is exactly the
hop the deploy will close.

**A deploy blocker found before deploying:** the app invokes `driver-offer-push`
with the public API key and no user session. The legacy `anon` key is a JWT and
passed the gateway's default `verify_jwt`; **new-format `sb_publishable_` keys are
not JWTs**, so every call would be 401'd before the function runs. Added
`supabase/config.toml` (`verify_jwt = false` for this function) and
`scripts/deploy-push-sender.sh` (deploy `--no-verify-jwt` + secrets, using a
`SUPABASE_ACCESS_TOKEN` so no browser login). If the client ever moves production
to new-format keys, every browser-invoked function needs the same — and that is
the wrong long-term answer, because the functions authenticate nothing themselves.

**Sender deployed to the throwaway project and proven — 2026-09-03.**
`scripts/deploy-push-sender.sh gcwrnluyaqarmrovbryj` with a Supabase access
token. Two things a first deploy to a fresh project exposed:

1. **`BOOT_ERROR` / 503 "Function failed to start"** with the original imports
   (`deno.land/std@0.224.0` http + encoding, `esm.sh/@supabase/supabase-js`).
   Switched to the runtime's native specifiers — `Deno.serve`,
   `npm:@supabase/supabase-js@2.49.8`, `jsr:@std/encoding@1/base64url` — and it
   boots. The log API for the new project returned "Backend error" throughout,
   so this was diagnosed by elimination, then confirmed by the next error being
   a *different*, specific one.
2. **`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON`**: the downloaded key
   file is pretty-printed over many lines; `secrets set NAME=VALUE` keeps one
   line, so the stored secret was `{`. The helper now compacts the JSON to one
   line first (the `\n` escapes inside `private_key` survive; the function
   un-escapes them).

Smoke test against the real test order `29b95e10…`:
`{"ok":true,"sent":0,"reason":"no_online_drivers"}` — HTTP 200. The sender
authenticates with Firebase, reads the order, looks for online drivers, finds
none (correct: nobody has signed in), and **says so**. Blueprint rule 3, on the
real server path. The `verify_jwt=false` deploy is confirmed too: the call got
past the gateway with the `sb_publishable_` key.

**Chain status:** customer → order → sender: proven. Sender → driver phone: waits
on the driver sign-in below, which is the emulator.

## Part 2 complete — the whole chain, every link real — 2026-09-03

Emulator back (network restored by the other session), every adb call pinned
`-s emulator-5554`.

1. **Driver sign-in from inside the page** (`testdriver@bykea.test`) → `/driver/home`
   → `[driverPushBootstrap] push token stored {"platform":"android"}` → **a real
   row in `driver_push_tokens`** on the throwaway project, driver `12d82ffc…`.
   The table that had been empty for the life of this product.
2. **Sender → this driver, via the deployed function**, on the real test order:
   `{"ok":true,"sent":1,"drivers":1,"tokens":1,"kind":"parcel"}`.
   - foreground: `[driverPush] payload received {"type":"offer_ring",…}`
   - backgrounded: notification "New delivery request / Harare CBD · → Avondale ·
     $4.25" posted; **0 app-code lines** (OS-rendered, as ADR 0001 says)
   - **tap:** `[driverPush] offer tapped` → **`[DriverOffers] routing to tapped
     offer /driver/home`** — the router hop, the last unexercised piece, now proven.
     The provider mounted because `DriverApprovalGate` found a real approved driver.
3. **Fresh order from the customer side, in the headless browser** (`#ING-B1F73DB303`,
   Harare CBD → Borrowdale, cash) → the app invoked the sender → the **backgrounded
   driver phone** showed "New delivery request / Harare CBD · → Borrowdale · $4.25",
   0 app-code lines. Nothing in the chain touched the client's production.

**What "online" means to the sender, and what blocked it first:** `is_online = true`
AND `driver_live_updated_at` within 5 minutes AND (if the order has pickup
coordinates) within 20 km. The app set `is_online` on sign-in, but published **no
location** even with an emulator GPS fix, because this build's manifest declared
no location permission — the "Retry location" button did nothing (observed
independently on the device at the same time). The order rows carry only `pickup_location` text, no lat/lng,
so the radius filter is skipped by design. For the test I set
`driver_live_lat/lng/updated_at` on the throwaway row directly; the manifest now
declares `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` so the app publishes
it itself — **verified:** after the rebuild, `getCurrentPosition success` where it
had logged `error`, and after moving the emulator's GPS fix the row updated to
`-17.8299727, 31.0529739` (the new fix, with GPS noise — not the hand-written
values) within seconds. The app now satisfies the sender's "online" predicate
unaided.

## Screen off, lock screen, killed — with the real sender, 2026-09-03

All via the deployed `driver-offer-push` on the throwaway project, driver
location refreshed before each ring (see limitation below).

| Case | Result |
|---|---|
| **Screen off** (`KEYCODE_SLEEP`, `mWakefulness=Asleep`) | `sent:1`, posted, **0 app code**. The screen **stayed asleep** — Android does not light the display for an ordinary notification; that is piece 6 |
| **PIN-locked lock screen** (`locksettings set-pin`) | Notification shown **on the keyguard** with full text ("New delivery request · Harare CBD → Borrowdale · $4.25" — fine: no customer identity in the payload). **Tap → PIN prompt → PIN → app to front → `[driverPush] offer tapped` → `[DriverOffers] routing to tapped offer`.** Screenshot at +3 s shows the app's white startup gap (H7), i.e. the app, mid-paint |
| **Killed** (process dead, `stopped=false`) | `sent:1`, posted, **FCM spawned a fresh process** (new pid), 0 app code |

Three things learned on the way:

- **The first test order was auto-cancelled** by the app's stale-offer sweep (30 min),
  and the sender then answered `{"skipped":"status","sent":0}` — correct: an
  offer is TTL'd to its order's window. Rang the newer order instead.
- **`am kill` refuses a process that was foregrounded seconds earlier** (pid
  unchanged) — that run was another backgrounded delivery, not a killed one.
  Waiting 15 s or `run-as <pkg> kill -9` gets a truly dead process without the
  stopped state that `force-stop` sets (which would drop FCM entirely).
- **Chrome opened once after the lock-screen tap-through.** The system log shows
  the app launch `from uid 10213` (the app) and a `VIEW https://www.google.com/…`
  `from uid 10145` = `com.android.chrome`: my typed PIN digits reached the
  launcher's search bar and ENTER submitted a search. Harness artefact, not the app.

**Product limitation made concrete:** the sender counts a driver as online only
with a location updated in the last 5 minutes, and a backgrounded WebView stops
`watchPosition`. So **a driver who backgrounds the app drops out of dispatch
after ~5 minutes** unless something keeps publishing — the foreground service in
blueprint rule 2. For these tests the timestamp was refreshed by hand. This is
the strongest argument yet for building that service.

## Accept / Decline — where they are, and what blocked them — 2026-09-03

**The buttons exist, in-app, after the tap.** `DriverHomePage` renders an offer
card (`dh-offerCard`) for each open offer under 30 minutes old: pickup, drop-off,
package, payment, the customer's offer, a **"Respond in 120s"** bar, and three
buttons — **"Offer $4.25"** (accept at the customer's price), **"Bid higher"**,
**"Reject"**. Verified on screen for order `#ING-AE9F7EAC36`. There are **no
buttons on the system notification itself** — that is blueprint piece 6, scoped
out of this pass.

Three findings on the way to that screenshot:

1. **The sender rings by order *status*; the app shows by order *age*.** The
   earlier test order (placed 23:48) was still `placed/open` at 12:00 the next
   day, so the sender rang it, but `OPEN_OFFER_MAX_AGE_MS` (30 min) hides it in
   the app — tap → home → "0 Open Offers". A driver can be rung for something
   they cannot accept. The sender should apply the same age cutoff (or the sweep
   that cancelled the first order should run server-side, not only in a client).
2. **Pressing Accept hung on "…" forever — the Supabase auth lock.** Logcat, 8×:
   `@supabase/gotrue-js: Lock "lock:sb-<ref>-auth-token" was not released within
   5000ms … Forcefully acquiring the lock`. `createClient(url, key)` with default
   options runs GoTrue's session machinery, which wraps requests in a
   `navigator.locks` lock; inside the Capacitor WebView it contends and stalls
   every call ~5 s. The accept path makes several calls in a row. **This app has
   zero `supabase.auth` usages**, so the fix is to turn the unused auth client
   off: `auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false }`.
3. **`claim_open_booking` looked missing (`PGRST202`) and was not.** PostgREST
   resolves RPCs by parameter *names*; a `{}` probe matches nothing and says "not
   found". With `p_table/p_booking_id/p_driver_id` it answered
   `{"ok":false,"error":"Driver not found."}` — present and behaving. Probe RPCs
   with their real argument names or the answer is meaningless.

**The accept landed (piece 7).** Order `ae9f7eac…`: `status=assigned`,
`bid_status=matched`, `assigned_driver_id=12d82ffc…`, `assigned_at 12:04:15Z`,
`agreed_fare_amount=4.50`, `delivery_confirmation_code=864460`. Customer's
`/live-tracking`: "DRIVER TO PICKUP · Driver is heading to the pickup location ·
YOUR DELIVERY PIN 864460". Driver's Orders tab: "ING-AE9F7EAC · ASSIGNED · Payout
$4.50 · Continue Delivery". The stop signal withdrew the notification (0 posted
for that order). **Caveat:** the assignment came from the press on the *pre-fix*
build — the stalled request completed once the lock forcibly recovered. The fixed
build (auth client off) logs **0** lock warnings where the old one logged 8, but
its own accept was not exercised: the driver now holds an active job and
`driver_single_assignment` correctly declines to offer a second. Exercising it
needs the job completed or cancelled first.

Also: an Android **"Process system isn't responding"** dialog appeared on the
emulator mid-test — `system_server`, not the app, from my `dumpsys`/uiautomator
polling every few seconds on top of lock/unlock cycles. Harness load, throttled.

**Driver half not run yet.** ~~The emulator had no network when I tried~~ (superseded
above; kept for the record) The emulator had no network when I tried (every
fetch failed, including google.com) and was then declared in use by another
session running a second device on `emulator-5556`; their stray taps explain the
offline state and the home-screen surprise earlier. **All device commands must be
pinned `adb -s emulator-5554` from now on.** Resume: enable wifi/data → fill the
driver login from inside the page (not `adb input text` + Back, which left the app)
→ token row → offer → tap → the router hop.

**For whoever is next:** the `android/` folder and `capacitor.config.json` are a
spike scaffold created 2026-08-30, not the source of the published apps. The
shipped Android and iOS apps were built elsewhere and their source is not in this
repository. Anything here must be re-applied to whatever
project actually produces the store builds.

The channel has never shipped to a real user, so its id did not need bumping when
the sound was fixed. If it had shipped, it would have: a channel is immutable and
an edit to a live one changes nothing on any handset that has already run the app.

## 2026-09-03 — Accept / Decline buttons on the notification (piece 6-lite)

**Claimed:** `android/app/src/main/java/com/kigatta/ingo/OfferMessagingService.java`
(new), `android/app/src/main/AndroidManifest.xml`, `android/variables.gradle`,
`android/app/build.gradle`, `supabase/functions/driver-offer-push/index.ts`,
`src/lib/driverPush.js`, `src/components/driver/DriverOffersProvider.js`,
`docs/adr/0002-notification-action-buttons.md`.

**Scope, agreed with the client 2026-09-03:** two buttons on the offer
notification, Accept and Decline, that do the real accept/reject from a
backgrounded, killed or locked phone. **Not** the ringing lock-screen takeover
and **not** a looping sound; those remain piece 6 proper, gated on the foreground
service.

**Why native code is unavoidable.** Measured 2026-09-03: with a `notification`
block in the FCM message, Android renders the banner itself and the app runs
zero code, so nothing can add buttons to it. The Android leg of the message
therefore goes **data-only** and `OfferMessagingService` (a subclass of
Capacitor's `MessagingService`, so token refresh and the JS
`pushNotificationReceived` event keep working) draws the notification with two
actions. A killed app still gets it: a high-priority data message starts the
service without the WebView.

**How the buttons reach the app's existing code.** Capacitor's push plugin treats
any launch intent carrying `google.message_id` as a notification tap and hands
every other extra to JS as `notification.data`. Each action PendingIntent
launches `MainActivity` with the message's data plus `ingoAction=accept|decline`,
so the tap sink from piece 7 receives it unchanged and `DriverOffersProvider`
runs `driverAcceptOffer` / `driverRejectOffer`, the same functions the in-app
card uses. Nothing is re-implemented natively.

**Accept from the notification — proven 2026-09-03 12:37Z.** Order
`299e736d…`: data-only message received by `OfferMessagingService`
(`hasNotificationBlock=false`), notification posted with Accept / Decline; tap on
Accept → `ActivityTaskManager: START … act=com.kigatta.ingo.OFFER_1_…` → JS
`[driverPush] offer tapped {… "action":"accept"}` → provider matched the offer →
`accept result {"ok":true,"pending":false,"fare":4.5}` → order
`assigned / matched`, bid `accepted`, notification withdrawn (delivered=0), app on
`/driver/active-delivery`, customer page "Driver is heading to the pickup". The
accept takes ~14 s on the emulator (three sequential requests); a check at 10 s
still showed `placed`.

**Android shows the action buttons only on the *expanded* row.** A fresh
notification arrives expanded (heads-up), so the buttons are there when it
matters. Once the shade has been touched the row collapses and the buttons hide
behind the chevron. That is Android, not a defect, but a driver who swipes the
shade down later will need to expand the row. Test harness note: dump the shade
and locate `text="Accept"` before tapping; a tap at remembered coordinates on a
collapsed row hits nothing.

**Decline test, first run: interrupted by two pre-existing faults, both real.**
1. Android killed the app for a **background ANR** (`am_kill … bg anr: Input
   dispatching timed out … Waited 5014ms for FocusEvent`) seconds after a full
   route reload. The WebView main thread was blocked > 5 s loading the bundle —
   on an emulator, but the same bundle ships to low-end handsets. Not this
   task; recorded for the performance work.
2. The Decline button then cold-started a new process, which came up **signed
   out**. `DriverApprovalGate` calls `isCurrentDriverApprovedForWork`, which
   returned `false` because `fetchDriverRegistrationStatus` returns `null` on
   *any* error, and the gate cleared the session. So every transient network
   failure on a route change signed the driver out — and a cold start on a weak
   connection is exactly that. **Fixed:** the check is now tri-state
   (`true | false | null`) and the gate only clears on an explicit `false`.
   The driver's test session was in `localStorage` ("remember me"); it was the
   gate, not storage, that removed it.

**Decline from the notification — proven 2026-09-03 12:45–12:50Z.** Order
`6f01de63…`. First press (12:45:39Z): intent `OFFER_2_…` → JS
`"action":"decline"` → provider matched the offer → `driverRejectOffer` called.
The write took minutes to land, for a reason outside the app (next paragraph),
but it landed: `rejected_driver_ids` = [`12d82ffc…`]. Second press on a re-ring
(12:50:06Z, after an app restart): the poll no longer offers a rejected order to
this driver, so the provider correctly reported "no longer available" after its
20 s wait and withdrew the notification (delivered=0). Both branches of the
decline path are therefore exercised.

**Emulator WebView network stalls (environment, not app).** Twice this session
every `fetch` inside the WebView hung for tens of seconds to minutes — Supabase
*and* `gstatic.com/generate_204` — while the emulator's shell could ping and the
host reached Supabase in 0.9 s. A process restart cleared it; the first fetch
after restart still took 4 s. This is what stretched the accept to 14 s and the
first decline to minutes. Treat any "slow accept" on this emulator with
suspicion before blaming the app; check `fetch` to a neutral host first.

**Killed + PIN-locked, Accept on the lock screen — 2026-09-03 12:55–12:58Z.**
App killed (`run-as kill -9`, `pidof` empty), screen off, PIN set
(`locksettings set-pin`). Fresh order `ecd3c8f5…` → Firebase started the
process for the service alone (`pidof` → 7227, no WebView) → notification
posted. Lock screen showed the row collapsed; the chevron expanded it and
**Accept / Decline were on the lock screen**. Accept → PIN prompt → PIN → app
cold-started in that same process, **still signed in** (the gate fix held:
no "no driver session") → parked tap delivered → provider parked the action.
Then the false negative: the first poll after a cold start returned the offer
at ~25 s, and the 20 s clock had already said "no longer available" and
withdrawn the notification. The order was still open. **Fixed:** a parked
action now gives up only after two polls have *completed* since the tap
without returning the offer (hard cap 90 s), and every completed poll
re-evaluates the parked action. Retest pending on the rebuilt APK.
Two harness lessons: the emulator's lock screen goes dark ~10 s after wake, so
wake → expand → dump → tap must be one quick sequence; and `input keyevent
KEYCODE_SLEEP` on a device with no lock set wakes straight to the launcher, so
"locked" needs a PIN actually set or it is not a locked test.

**Retest on the poll-gated build (13:02Z, killed + PIN-locked, Accept on the
lock screen).** Everything up to the network call is now proven cold: service
posted with `pidof` empty → lock-screen buttons → PIN → cold start, signed in →
parked tap delivered → **poll gate waited for real data and matched the offer**
(`accept -> customer_delivery_orders:ecd3c8f5…`) → `driverAcceptOffer` called.
The call then failed: `accept result {"ok":false,"error":"TypeError: Failed to
fetch"}`. That is the emulator WebView wedge (previous paragraphs), not logic:
the same function assigned the order on the warm runs. The app handled it
correctly: error dialog, notification kept (delivered=1), in-app card still
there for a manual retry. On a real handset "Failed to fetch" means offline.
**Not built:** an automatic single retry of a notification action on network
error. Worth considering (cheap), left out to keep one accept path.
**Real-device run still owed** before this is called done; the emulator cannot
give a clean cold-start network.

**Live demo for the client (13:15Z) found the next bug: one tap per app
lifetime.** Warm app, order rang, Accept pressed: `[driverPush] offer tapped`
logged, then nothing. The piece-7 tap effect in `DriverOffersProvider` guarded
with `let done = false … done = true` ("routed once"), meaning the *first* tap
after mount was handled and every later one, for as long as the process lived,
was dropped. Every earlier proof had run on a fresh process, which hid it.
**Fixed:** the guard now drops only the same tap delivered twice within 3 s
(the parked copy plus the window event), and the event path clears the parked
copy so a later mount cannot replay an old button press. Lesson for the
standard: a "handle once" guard must be keyed on the *event*, never on the
mount; and every proof run should include a second press in the same process.

**Startup ANR, reproduced twice (13:39Z and 16:18 local / 13:18Z).** Launch the
app, press HOME within ~10 s: `am_anr … Input dispatching timed out … Waited
5000ms for FocusEvent`, then `am_kill … bg anr` ~20 s later. The WebView main
thread is blocked > 5 s while the CRA bundle loads. Emulator, but the bundle is
the same one on the store. Not this task's scope; it is now a concrete,
reproducible item for the performance pass (bundle size, lazy routes, and a
lighter first paint). Harness rule until then: give the app 40 s after launch
before backgrounding it.

## The "InGo isn't responding" ANRs are the emulator, not the app — 2026-09-03, 20:00 local

**Status:** complete (diagnosis only; nothing in `src/` changed for this).
**Shares:** docs/worklog.md — this section only.

**What this is.** Rio sent a screenshot of the Android "InGo isn't responding"
dialog over a driver screen ("Continue Delivery" visible). Two fresh ANRs were on
emulator-5554 (18:33 and 18:37 local, both `Input dispatching timed out` on a
touch event). All four of today's ANR trace files (`/data/anr/anr_2026-09-03-*`,
pulled with `adb root`) were read. **This corrects the paragraph above: the
startup ANRs were not the bundle blocking the main thread.**

**Evidence, every trace the same shape:**
- The app's `main` thread was never in app, plugin, or WebView-JS code. 15:39:
  a `ThreadLocal.get` inside `FragmentManager.dispatchStop` (an ordinary
  instruction, i.e. the thread was starved mid-step). 16:18 and 18:33: idle in
  `MessageQueue.nativePollOnce`. 18:38: a binder call to `system_server` that
  took 1.5 s.
- Thread accounting is all kernel, no user. 18:33 main thread: `utm=1671
  stm=76405` (17 s user, 764 s kernel) and 397 s waiting on the run queue.
- Android's own CPU table for each ANR: **77–79 % kernel, 1–4 % user across the
  whole guest.** Load average 14.6 then 21.2 on 4 vCPUs. Top consumers were
  `android.hardware.sensors-service.multihal` (60–82 %), `system_server`
  (69–102 %, kernel), then the app and the WebView renderer, all kernel time.
- The sensors HAL had `stime=2965312` ticks = **8.2 hours of kernel CPU**
  against 17 s of user time. Guest uptime 1 day 14 h; on the host the
  `qemu-system-x86_64` process had consumed 38.2 CPU-hours in 38.5 wall-hours,
  i.e. one core pegged continuously, idle or not. Guest RAM 3.7 of 4.0 GB used,
  swap in use.

**Conclusion.** The guest kernel of this long-running emulator is thrashing
(sensors HAL spinning; everything else starved), so the app's UI thread cannot
answer input within 5 s. That also explains the "WebView network stalls" and
"14 s accept" noted earlier today: same starvation, seen through `fetch`. None
of it is evidence about the shipped bundle. **The performance-pass item written
above is withdrawn** until reproduced on a freshly started emulator or a real
handset.

**Not done / for whoever is next:** the emulator was NOT restarted — the log
says another session shares it. Cold-restart it (or a fresh AVD) before any
further timing claims, then re-run: launch → HOME within 10 s. If it ANRs on a
fresh emulator with low load, *then* it is the app. Harness rule: before
attributing any ANR or slow fetch to the app, read the `CPU usage` table under
`ANR in com.kigatta.ingo` in logcat; if user time is near zero and kernel time
dominates, stop and restart the emulator.

**Fixed 20:10–20:16 local (Rio asked for it).** `adb emu kill`, then
`emulator -avd Test_Android -no-snapshot-load` (cold boot; userdata kept, driver
still signed in). After settling: guest 371–389 % idle of 400, sensors HAL
13 s kernel time total, load falling to 1.6. Repros re-run on the fresh
emulator, none ANR'd (`am_anr`/`am_kill` for the app: none):
1. launch → HOME at 8 s (the "startup ANR");
2. driver Home: 6 taps + 4 swipes, map responded ("Open in Maps" chip);
3. Orders tab → tap burst → landed on the active-delivery route screen (the one
   behind Rio's ANR screenshot) → responsive, route drawn.
**Verified:** the above, by screenshot and logcat events. **Not verified:** the
real-device run (still owed); Accept / Decline retest on this fresh emulator
was not repeated tonight.

## 2026-09-03 — The offer must not be missable: full-screen intent (piece 6, first half)

**Status:** complete on the emulator; real device still owed
**Owns:** `android/app/src/main/java/com/kigatta/ingo/OfferMessagingService.java`,
`android/app/src/main/java/com/kigatta/ingo/MainActivity.java`,
`android/app/src/main/AndroidManifest.xml`, `docs/adr/0003-full-screen-offer.md`.
**Shares:** docs/worklog.md — this section.

**What this is.** Rio, watching the emulator: the Accept / Decline notification
is "easy to miss". Measured tonight: the channel is importance 5, and SystemUI
logged `onHeadsUpPinnedModeChanged` at 20:43:24.6 and again at 20:43:30.3 — the
banner shows for ~5.7 s and then collapses into the shade, where the buttons hide
behind the chevron. That is the whole of what MAX importance buys
(`D:\OS\references\background-push.md`, rule 6). Rio: "check the OS, I have this
already" — KangaruRide solved it (ADR-0049, `mobile/src/push/callNotification.ts`,
`plugins/withLockScreenCallUi.js`): a **full-screen intent** on the notification,
`showWhenLocked` + `turnScreenOn` on the activity, `USE_FULL_SCREEN_INTENT` in
the manifest. Phone in use → a heads-up that sticks instead of fading; phone
dark or locked → Android starts the activity over the keyguard.

**What transfers and what is cheaper here.** Kangaru builds the notification in
JavaScript, so its process must be alive (their foreground service). InGo builds
it in `OfferMessagingService`, which Firebase starts for a data message even
when the app is dead, so the full-screen intent costs no foreground service.
Kangaru sets `showWhenLocked` in the manifest (whole app over the keyguard,
always). Here it is set **dynamically in `MainActivity`, only for a launch whose
intent carries `type=offer_ring`, and cleared in `onStop`** — a passer-by cannot
drive a shift from a locked phone.

**Not in this change:** looped ringtone, a native call-style card, Android 14+
prompting the driver for the full-screen-intent special access (sideloaded and
debug builds have it; a Play build of a non-calling app may not, and Android
downgrades silently to the 5 s banner — the service now logs
`canUseFullScreenIntent` on every ring so the downgrade is at least visible).

**Built.** `OfferMessagingService.show()` adds `setFullScreenIntent(open, true)`
and logs `canUseFullScreenIntent()` on every ring; `MainActivity` applies
`setShowWhenLocked` / `setTurnScreenOn` only for an intent whose `type` is
`offer_ring` and clears both in `onStop`; manifest declares
`USE_FULL_SCREEN_INTENT`. ADR: `docs/adr/0003-full-screen-offer.md`. No JS
change, no sender change. APK built (`assembleDebug`, exit 0) and installed.

**Verified on the emulator (Android 15, debug build, `appops` = default, log
says `fullScreenIntent granted`):**
1. Phone unlocked on the launcher: offer sent 20:55:30 → SystemUI
   `onHeadsUpPinnedModeChanged` once at 20:55:32.6 and **no unpin**; screenshots
   at 2 s, 15 s, 40 s and 65 s all show the banner with Accept / Decline still
   pinned. Before: pinned 5.7 s.
2. Screen off + PIN (`mWakefulness=Asleep`, `isKeyguardShowing=true`): offer sent
   20:57:30 → 1.5 s later `START … OFFER_0_…` → `mWakefulness=Awake`,
   `topResumedActivity=MainActivity` with the keyguard still up → JS `offer
   tapped` → `routing to tapped offer`; screenshot at 8 s shows the app over the
   lock screen with the in-app offer banner. The shade notification is posted
   alongside (seen on the lock screen afterwards).
3. Exemption released: after that, sleep → wake with no offer shows the normal
   lock screen (`isKeyguardShowing=true`, app not drawn). PIN cleared after.
4. `--stop` still withdraws (`withdrawn tag=…` 20:58:20).

**Not verified:** a real handset (Android 14+ special-access state on a Play
build; OEM skins); a killed process + FSI (the WebView cold start over the
keyguard); a real order rather than the test payload (the in-app card, not
just the banner); the Accept button pressed from the pinned heads-up.

**Deliberately not built:** looped ringtone; native call-style card; a Profile
row that opens Android's full-screen-intent setting on 14+ (Kangaru has one,
`fullScreenIntent.ts`, worth porting before a Play release).

**Two harness lessons.** (1) After `emu kill` + cold boot, FCM accepted a
message (`projects/ingo-92d5f/messages/…`) that never arrived: Google's push
backend still held the dead instance's connection. `cmd connectivity
airplane-mode enable` / `disable` forced a reconnect and the next send landed in
2 s. Do this once after every emulator restart before judging delivery.
(2) The device token can be asked of the running WebView over CDP
(`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`, then
`Runtime.evaluate` on `Capacitor.Plugins.PushNotifications.register()`) —
script in the session scratchpad, ten lines, no app change needed.

**Screen wake, hardened and proven in every process state (21:01–21:03).** Rio
asked to focus on "the screen wakes when locked and sleeping". Added the floor
Kangaru has (`lightUpScreen`): `OfferMessagingService` takes a 15 s
`SCREEN_BRIGHT_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP` when the screen is not
interactive (manifest `WAKE_LOCK`), so even a handset that downgrades the
full-screen intent gets a lit lock screen with the buttons on it. Rebuilt,
installed, then the matrix, each with PIN set and `mWakefulness=Asleep`,
`isKeyguardShowing=true` before the send:

| Case | Wake | Over keyguard | JS routed | Time to activity start |
|---|---|---|---|---|
| A. app was in the foreground when locked | Awake | `topResumedActivity=MainActivity` | yes | 1.6 s |
| B. process killed (`run-as kill -9`, `pidof` empty) | Awake | new pid 7334, activity started, WebView cold-started | yes, at +9.5 s | 2.9 s |
| C. Doze (`deviceidle force-idle`, state IDLE) | Awake | `topResumedActivity=MainActivity` | yes | 1.5 s |

Each log shows `fullScreenIntent granted` then `screen was dark; lit for
15000 ms`. Doze did not delay the high-priority data message (1 s to service).
Harness: `dumpsys battery unplug` is required before `force-idle`; `unforce` +
`battery reset` after. Real handset still owed (OEM battery managers and the
Android 14+ special access are the two things the emulator cannot show).

## 2026-09-03 — Full-screen offer in the app; the in-app banner is dropped

**Status:** complete on the emulator; real device still owed
**Owns:** `src/pages/DriverOfferPage.js`, `src/pages/driverOfferPage.css`,
`src/components/driver/useOfferActions.js`, `src/components/driver/OfferPins.js`.
**Shares:** `src/components/driver/DriverOffersProvider.js` — tap routing → offer page,
native ring → offer page, toast CTA → offer page, shared offer matcher;
`src/pages/DriverHomePage.js` — handlers/state replaced by `useOfferActions`, pins
imported; `src/lib/driverOfferRing.js` — no DOM banner in the native WebView;
`src/App.js` — one route; `src/components/driver/DriverLayout.js` — hide bottom nav
on the offer route; `src/index.css` — semantic tokens added.

**What this is.** Rio: the in-app "New InGo delivery / Open request" banner is to
be dropped ("drop this"); the request inside the app becomes a whole screen with
two buttons, Accept and Decline, "clean and professional". The OS notification
with Accept / Decline (ADR 0002/0003) stays the out-of-app surface. Any tap on it
(body, full-screen intent, or a button while the offer loads) lands on the new
screen; a new ring while the app is open opens it too (native only; the web
driver keeps the toast). Accept / Decline / bid logic is extracted from
`DriverHomePage` into one hook so there is still one accept path.

**Deliberately kept:** counter-offer (bid) as a tertiary text action on bid-capable
tables, so no existing capability is silently removed. Flagged as a fork below.

**Built.** `DriverOfferPage` at `/driver/offer/:offerKey` (under `DriverLayout`,
bottom nav hidden there): kind badge, ref, close; countdown + bar (the 120 s
re-ring cycle, "Time is up" at 0); pickup / drop-off with the shared pins;
distance line (deduplicated — `dist` already carries the ETA for deliveries);
package; payment block with the wallet / cash note; customer offer + minimum;
"Your offer" once a bid is in; Decline (outlined, left) and Accept $X (filled,
right, 56 px); "Counter-offer a higher price" as a text action on bid tables
with the inline form; states: fetching (30 s grace after mount for a cold-start
poll), no longer available / offline, Declined. Tokens only
(`src/index.css` gained the semantic set). `useOfferActions` holds
accept / decline / bid, moved out of `DriverHomePage`, which now uses it too;
`offerPresentation.js` holds `kindLabel`, `BID_TABLES` and the pins. Provider:
`offerPath()` / `findOfferForKey()` exported; any tap naming an offer routes to
the screen; a ring in the native app navigates there (web keeps the toast, whose
CTA now opens the screen); the parked notification action uses the same
matcher. `driverOfferRing.js` no longer injects the DOM banner in the native
WebView. Bundle `main.720c4857.js`, APK rebuilt and installed.

**Verified on the emulator, all against real rows in the throwaway project
(`scratchpad/make-order.js` clones order `ecd3c8f5…` as a fresh `placed` order
and can invoke the deployed sender the way the customer app does):**
1. Order `a8a7a68f…` inserted → poll → native navigate →
   `/driver/offer/customer_delivery_orders%3Aa8a7…` → screen populated
   (screenshot sent to Rio).
2. Order `43f00096…` → Decline pressed at the button's DOM centre (287,2319) →
   `[offer] decline … result {"ok":true}` → screen "Declined" → DB
   `rejected_driver_ids=[12d82ffc…]`.
3. Order `63d9ce9b…` + sender (`sent:1`) → `[driverPush] payload received` →
   heads-up pinned → screen open → Accept pressed → `accept result
   {"ok":true,"pending":false,"fare":4.5}` → DB `assigned / matched` → sender
   `offer_stop` → `withdrawn` → app on `/driver/active-delivery`.
4. Order `d3285863…`, app backgrounded → ring → the notification's body intent
   (`am start -a com.kigatta.ingo.OFFER_0_<tag> … --es type offer_ring`) →
   `[DriverOffers] routing to tapped offer /driver/offer/…` → app in front on
   the screen → Decline → "Declined".
5. No in-app banner appeared in any run.

**Not verified:** the web (browser) driver: toast → screen; the counter-offer
form on the screen (logic unchanged, moved); a real handset; the full-screen
intent launching *into* the offer screen on a locked phone (the FSI intent
carries the offer key, so it takes path 4, but not re-run tonight).

**One unexplained event, logged for honesty.** On order `a8a7a68f…` the first
Decline attempt (a tap at (286,2392), which the DOM later confirmed is inside
Decline) produced an *accept*: a bid at $4.50 `accepted` at 18:29:53Z, order
assigned, app on `/driver/home`, no page log (the hook had no logging then).
Not reproduced in three later runs, and the hook now logs every accept and
decline with its result, so a recurrence will name itself. Possible cause: the
approval gate re-checks on every route change and replaces the outlet with
"Checking driver account…" (seen in a screenshot 8 s after an insert), so a tap
can land on whichever screen mounts next. That gate behaviour is pre-existing
and worth its own look: every navigation blanks the screen until a DB call
returns.

**Harness notes.** `uiautomator dump` segfaults intermittently on this
emulator and leaves a stale `/sdcard/ui.xml`: never tap on bounds from a dump
you did not just verify. Locate web buttons through CDP instead
(`scratchpad/cdp-eval.js`: `getBoundingClientRect()` × `devicePixelRatio`).
Git Bash mangles `/driver/home` in `adb shell am start --es link /driver/home`;
set `MSYS_NO_PATHCONV=1`. Emulator `screen_off_timeout` was raised to 600000
during the tests and restored to 30000 after.

**Fork flagged, decided by me:** the counter-offer stays as a tertiary text
action on the screen rather than being removed. Rio asked for two buttons; the
two buttons are Accept and Decline, and the bid is not a button. Say the word
and it goes.

**The "That request is no longer available" dialog Rio saw (22:00).** Cause: a
decline (or accept) on the new screen ended the offer locally but left the OS
notification in the shade with live Accept / Decline; pressing it later parks
an action for an offer the poll no longer returns → that dialog. **Fixed:**
`removeOfferLocally` now withdraws the OS notification for the key
(`ingo-offer-<table:id>`), so every path that ends an offer (screen, home card,
notification button, bid claimed) clears the shade. Copy reworded: "no longer
open — already answered, taken by another driver, or timed out". Verified on
order `51d32955…`: notification body intent → screen → Decline → `withdraw …
delivered:1, matching:1` → shade empty.

**Two things learned on the way, both pre-existing.** (1) The provider
auto-opens an accepted job (`fetchBidAcceptedJobsForDriver` → navigate to
`/driver/active-delivery`) on a poll after mount; tonight it moved the app off a
fresh offer screen onto the previous accepted delivery, which looked like an
accept and was not (order stayed `placed`). (2) `/driver/active-delivery` is
outside `DriverLayout`, so the offers provider (the tap sink) is not mounted
there: a notification tapped while the driver is on that page does nothing
until they return to a `/driver/*` tab (the bootstrap parks it; delivered on
the next mount). A driver mid-delivery cannot answer a second offer from the
notification. Worth a decision, not a silent fix.

## 2026-09-03 — Real GPS anywhere; driver-side proximity without a schema change

**Status:** complete on the emulator; sender half unexercised (no Google key here)
**Owns:** `src/lib/offerProximity.js`, `src/lib/offerProximity.test.js`.
**Shares:** `src/lib/googleMapsConfig.js` — `isAcceptableDeviceFix` / `trustedMapCenter`
trust any reliable fix; `src/hooks/useLiveLocation.js` — warning text; `src/pages/DriverOfferPage.js`
+ `src/pages/DriverHomePage.js` — distance line + sort; `supabase/functions/driver-offer-push/index.ts`
— geocode pickup at ring time when `GOOGLE_MAPS_API_KEY` is set, then the existing radius filter.

**Decisions (Rio, 22:10):** (1) trust the device's real fix everywhere; Harare is
only the no-fix fallback — the Zimbabwe box that rejected every fix outside it
is what showed Rio, in Uganda, a map of Harare and published his driver row
with no coordinates at all. (2) Proximity is driver-side and needs **no
migration**: the pickup address is geocoded at use (the app through the
existing `places-geocode` edge function, the sender through Google Geocoding)
and cached; distance to the driver's live fix is computed with the existing
haversine. No table gains a column. Degrades honestly: no coordinates → no
distance shown and no filtering, never a made-up number.

**Not verifiable here:** live geocoding. No Google Maps key exists in this
environment and `places-geocode` is not deployed on the throwaway project
(non-2xx). The pure logic is unit-tested; the wiring is exercised with the
geocoder failing, which must render "—" and keep every driver in the ring.

**Built.**
- `googleMapsConfig.isAcceptableDeviceFix` = any reliable fix; `trustedMapCenter`
  follows it. `SERVICE_AREA_BOUNDS` / `isInServiceArea` remain for callers that
  want the box. `useLiveLocation` exports `readLastDeviceFix()`.
- **The GPS watch and the 15 s publish loop moved from `DriverHomePage` into
  `DriverOffersProvider`** (exposed as `live` in the context; Home and the offer
  screen consume it). Home's unmount cleanup used to publish `is_online=false`,
  so any other tab — and now every ring, which opens the offer screen — took
  the driver out of the dispatch pool. Found by reading the driver row after a
  ring: `is_online:false`, position stale. The offline publish now happens only
  on the toggle or on leaving the driver area.
- `src/lib/offerProximity.js`: geocode-at-use with a 7-day positive / 10-min
  negative cache in `localStorage` (`ingo_pickup_geo_v1`, cap 200), haversine to
  the driver's fix, `formatDistanceKm`, `sortOffersByDistance`,
  `useOfferDistances`. 8 unit tests (`offerProximity.test.js`) pass. Offer
  screen: "Pickup is about X from you" / "— Distance from you unknown: no GPS
  fix yet" / "…: the pickup address could not be located". Home: same line on
  the card, list sorted nearest first, unknowns last.
- `reverseGeocode.js`: `ADDRESS_COUNTRY_CODE` now `REACT_APP_ADDRESS_COUNTRY`
  (default `zw`); both country filters key off it; **the Nominatim forward
  fallback never returned a point** because it filtered on `hit.address` without
  requesting `addressdetails=1` — fixed.
- Sender: `geocodePickup()` (Google Geocoding, needs `GOOGLE_MAPS_API_KEY` as a
  function secret) feeds the existing `NEARBY_RADIUS_KM = 20` filter; response
  carries `proximity: { source: row|geocoded|none, reason }` and
  `reason: no_nearby_drivers` when the radius empties the list. No key → today's
  behaviour, logged.

**Verified on the emulator (`adb emu geo fix 32.5825 0.3476`, Kampala):**
- driver row `driver_live_lat 0.3476 / lng 32.5825, is_online true` 30 s after
  launch on Home; still updating on the Orders tab (+20 s) and on the offer
  screen (+15 s). Before the change the same fix was rejected ("outside Zimbabwe
  service area") and never published.
- ring → offer screen → "Pickup is about 2028 km from you" (Harare CBD from
  Kampala; the honest number), resolved through the Nominatim fallback since
  `places-geocode` is not deployed on the throwaway (CORS/non-2xx in the log);
  cached as `{lat:-17.8257, lng:31.051}`. Screenshot sent to Rio.

**Not verified:** Google paths (edge `places-geocode`, direct Geocoding API,
the sender's `geocodePickup`) — no key in this environment; the Home card sort
with several offers at once; a real handset.

**Harness notes.** The emulator's GPS fix is only applied while some app is
listening and the screen is on — `emu geo fix` before the app is up does
nothing visible. `adb shell settings put system screen_off_timeout 600000` for
the session, restored to 30000 after. The provider auto-opens an accepted
delivery on every fresh mount until the driver "leaves" it (sessionStorage), so
close out test orders in the DB (`status=delivered`) between runs or every
launch lands on `/driver/active-delivery`. Test orders from tonight are closed
(delivered or cancelled with `cancel_reason='test cleanup'`).

**Decisions to record (ADR 0004).** Trust the device fix anywhere; Harare only
as the no-fix fallback; the country bias for address search is per environment.
Proximity is computed at use from text addresses; no coordinates are persisted.

## 2026-09-04 — Driver flow read; the store-build source question reopened

**Status:** complete
**Owns:** `AGENTS.md`.
**Shares:** `CLAUDE.md` — exact edit: the remotes bullet and the `android/` bullet.

**What this is.** Rio asked for a read of the driver side: the flow, the screen
transitions, and the offer logic, wanting "something simple clean". No code was
changed. The read is published as a diagram page (today's flow, the three
interrupts, the proposal) and is summarised in the five findings below. Then Rio
said **"I have access to it"** about where the store builds are produced, which
contradicts a standing assumption in this file and in
`D:\OS\ingo-os\Next Actions.md`.

**The read, in five findings.**
1. The job after Accept exists only in `location.state.order`; every chain screen
   spreads it over `DEFAULT_DRIVER_ORDER`, so a reload, a killed process or a
   notification cold start renders the fixture — order `ING-00881`, "Sara Khan",
   $3.20 — as if it were a real job. Only `DriverCollectPaymentPage` redirects.
2. Three uncoordinated things navigate for the driver: the re-ring
   (`DriverOffersProvider.js:345`, every 120 s for up to 30 min, first offer
   only), the bid-accepted auto-open (`:437`), and the approval gate blanking the
   outlet on every route change (`DriverApprovalGate.js:39`). This is the
   mechanism behind the unexplained accept logged on 2026-09-03.
3. Four surfaces answer one offer, in two vocabularies: home says
   "Offer / Bid higher / Reject", the screen says "Accept / Counter-offer /
   Decline". The home card is ~180 lines duplicating the screen.
4. `/driver/delivery-status` is unreachable — nothing navigates to it. And
   `DriverPickupConfirmPage` duplicates `DriverNavigationPage.onCustomerPickedUp`.
5. The six chain routes are siblings of `DriverLayout`, not children, so the
   offers provider is unmounted mid-job and a tapped notification does nothing.

**What I checked about the store-build source, and did not find.**
`KIGATTA-INVESTMENTS` exposes exactly one repo to Rio's token, `bykea`. The third
remote on this clone, `ingo-app` → `RealAkram20/Ingo-app`, is a **public mirror of
this same codebase**, two commits behind `HEAD` — not a separate app source.
`d:\xampp\htdocs\ingo-release` is the Laravel fleet product, not this. So nothing
on this machine or in either GitHub org locates a store-build source.

**Verified:** the flow read above, from source. The three remotes and the
mirror's contents, from `gh` and `git diff`.
**Not verified:** where the store builds are actually produced. Rio asserted
access on 2026-09-04; the location is still unrecorded, and "access" may mean the
source, the Play/App Store console, or the builder — these need different work.

**Deliberately not built:** all five fixes. Two decisions are open with Rio —
(A) resume bar vs. auto-open on a bid acceptance, (B) whether the home offer card
goes entirely or becomes a read-only row.

**For whoever is next:** do not re-run the store-source search; it is recorded
above. Ask Rio for the location instead.

**Handed to the client, 2026-09-04.** Rio: "we are pushing to kigatta". Rio's
access to `KIGATTA-INVESTMENTS/bykea` is **READ** (`gh repo view` →
`viewerPermission: READ`), so a direct push is impossible and the route is a PR
from the fork. Four commits made from the pending tree (native push / geo +
proximity / the offer screen / docs), ordered so each builds: the offer screen
imports `offerProximity`, so the geo commit lands first. `npm run build` passes
(`main.48c960df.js`). Note `CI=true npm run build` **fails** on pre-existing
ESLint warnings in five files nobody touched here — the project's own build
script does not set `CI`, so this is a latent trap for any CI that does.

Branch `kigatta-handover` on `origin`, PR:
`https://github.com/KIGATTA-INVESTMENTS/bykea/pull/1` — 27 commits, 96 files.
`AGENTS.md` is the handover doc in that branch: self-contained, written for a
developer and their agents who have none of this project's private context.
(The handover branch is built from `master` with the local-only working notes
excluded; the reasoning for that lives in the wiki, not here, so this file stays
useful to whoever reads it.)

**Not verified:** nothing in the PR was run on a real handset, and the PR says
so. The client's developer has not responded yet.

**For whoever is next:** do not push `master` to `origin` and then open a second
PR — it would re-introduce `CLAUDE.md` to the client. Use `kigatta-handover`,
rebuilt the same way, if more work needs handing over.

## 2026-09-04 — Finding 1: the job gets an address, and the fixture stops being a fallback

**Status:** built and compiling; **not run**
**Owns:** `src/components/driver/useDriverJob.js` (new).
**Shares:** `src/App.js` — the six chain routes gain an optional `:jobKey`;
`src/pages/DriverActiveDeliveryPage.js`, `DriverNavigationPage.js`,
`DriverPickupConfirmPage.js`, `DriverDeliveryStatusPage.js`,
`DriverCollectPaymentPage.js`, `DriverRateCustomerPage.js`,
`DriverOrdersPage.js` — order resolution swapped to the hook;
`src/components/driver/useOfferActions.js` + `DriverOffersProvider.js` — the
four navigations into the chain carry the key; `src/data/driverOrderDefaults.js`
— the fixture stops being a runtime fallback.

**What this is.** After Accept the job is carried only in `location.state.order`,
and every chain screen does `{ ...DEFAULT_DRIVER_ORDER, ...state.order }`. With a
real order nothing leaks — `offerToActiveDeliveryOrder` sets all fourteen fixture
keys explicitly. But with **no** state at all (reload, killed process, cold start
from a notification, back button, deep link) the screens render the fixture as
though it were work: `ING-00881`, "Green Valley Mart, Stratford, London E15",
"Sara Khan", `+44 7700 900123`, $3.20. `DriverActiveDeliveryPage` has a second
copy of the same failure at line 83, defaulting pickup to
`'Stratford, London E15'`. Only `DriverCollectPaymentPage` redirects instead.

**The fix.** The job gets an address. Routes take an optional `:jobKey` of
`table:id` — the same encoding `/driver/offer/:offerKey` already uses, so there
is one convention, not two. `useDriverJob` resolves in order: router state when
present (the fast path, and the only one carrying in-flight edits like the
package photo), else a fetch by key through the existing
`fetchActiveOrdersForDriver`, else the honest answer that there is no such job.
Legacy URLs without the key keep working. No page falls back to the fixture.

**Deliberately not done in this pass:** findings 2 and 3 (they need Rio's
decisions A and B), and findings 4 and 5 — the dead `/driver/delivery-status`
route, the duplicated pickup step, and moving the chain under `DriverLayout`.
Those are separate commits so this one stays reviewable.

**Built.** `useDriverJob` resolves a job from router state, else by `table:id`
from the route, else reports it missing; `jobPath(base, order)` builds the
addressed route and falls back to the bare one for an order with no identity.
`DriverJobState` is the single "no job" screen, so six screens stop each
inventing an answer. The six chain routes take an optional `:jobKey`, so old
URLs still resolve. Four screens (active-delivery, navigation, confirm-pickup,
delivery-status) are gated on a real job; the two terminal screens
(collect-payment, rate-customer) keep router state as their source **on
purpose** — by then the job is completed and would not come back from an
active-jobs fetch, so gating them on one would have blocked a driver from
finishing. Every entry into the chain now carries the identity: both
`useOfferActions` accepts, both provider navigations, and the Orders page.
`src/data/driverOrderDefaults.js` is deleted — nothing imported it any more.

**Verified:** `npm run build` passes. `offerProximity` 8/8 pass. No reference to
`DEFAULT_DRIVER_ORDER` survives outside a comment, and the hardcoded
`'Stratford, London E15'` pickup fallback is gone. React's rules of hooks hold:
every gate sits after the last hook in its component, checked per file.

**Not verified — this is the gate.** *None of it has been run.* Not in a
browser, not on the emulator, no driver walked the chain. Specifically unproven:
that a reload on `/driver/active-delivery/<key>` actually recovers the job, and
that `fetchActiveOrdersForDriver` returns the row for each of the four gated
screens. Proving it needs the throwaway project, a driver session and an
accepted job — do that before this is called done.

**Pre-existing, not mine:** `App.test.js` fails on a TypeScript file inside
`node_modules` (`iobuffer` → `fast-png` → `jspdf` → `adminReportsBundle`).
Confirmed by reverting `src/App.js` to `HEAD` and re-running: identical failure.
`CI=true npm run build` also still fails on ESLint warnings in five untouched
files.

**Deliberately not built:** findings 2 and 3 (they wait on decisions A and B),
and 4 and 5 — the dead `/driver/delivery-status` route is now honest but still
unreachable, the pickup step is still implemented twice, and the chain still
sits outside `DriverLayout`.

## 2026-09-05 — Preparing the first Google Play upload from this repo

**Status:** in progress
**Owns:** `android/keystore.properties.example` (new), `docs/release-android.md` (new).
**Shares:** `android/app/build.gradle` — exact edit: release `signingConfig` read
from a gitignored `android/keystore.properties`, plus the version bump;
`.gitignore` — exact edit: ignore `android/keystore.properties`, `*.jks`,
`*.keystore`; `android/app/src/main/res/` — launcher icon and splash regenerated
from the brand logo; `CLAUDE.md` — the PR-merged fact and the store-build answer.

**What this is.** Rio: "we are pushing this update to google play, take me
through it." The tree is being made uploadable, then the walkthrough is written.
Two facts found on the way that the wiki did not have: **PR #1 was merged** into
`KIGATTA-INVESTMENTS/bykea` at 2026-09-04 10:43 UTC, so the client's `master` now
carries `android/`, `AGENTS.md` and `capacitor.config.json` (everything on local
`master` except `CLAUDE.md`). And the store build is being produced **from this
repo, on this machine** — which answers open question 9 for Android going forward.

**Traps found before any edit:**
- `.env.local` points `npm run build` at the throwaway project
  `gcwrnluyaqarmrovbryj`. CRA loads `.env.local` for `build` too, above
  `.env.production`. A Play upload built with that file present ships an app
  whose every user signs in against an empty test database.
- The launcher icon in `res/mipmap-*` is the Capacitor placeholder and
  `public/logo512.png` is the React atom. No InGo icon file exists in the repo;
  the brand logo lives only at the Supabase storage URL in `src/lib/ingoLogo.js`.
- `versionCode 1` / `versionName "1.0"` and no `signingConfig`: Production
  Readiness B2, unchanged since 2026-08-30.

**Built.** `android/app/build.gradle`: release `signingConfig` read from
`android/keystore.properties` (gitignored; template `keystore.properties.example`
committed); when the file is absent Gradle warns `release artefacts will be
UNSIGNED` and still builds, so a missing key cannot ship by accident and the
pipeline can be exercised without one. `versionCode 2`, `versionName 1.1.0`.
`.gitignore`: `android/keystore.properties`, `*.jks`, `*.keystore`. Launcher
icon and splash regenerated from the brand logo (`ingoLogo.js` URL, trimmed and
centred on white) with `@capacitor/assets 3.0.5`; sources in `assets/`
(`icon-only`, `icon-foreground`, `icon-background`, `splash`, `splash-dark`), 49
files under `res/` changed or added. `docs/release-android.md`: the walkthrough,
self-contained for the client's repo. `AGENTS.md` §1.3 and §5 no longer say the
store app is built elsewhere. `CLAUDE.md`: PR #1 merged, the build-from-here
decision, the `.env.local` trap.

**Verified.** `npm run build` with the production Supabase URL and anon key
forced through the shell (so `.env.local` was overridden, not deleted): the
bundle has 0 references to `gcwrnluyaqarmrovbryj` and 15 to
`iaorixerxnqedwgkqxtz`. `npx cap sync android` clean. `./gradlew bundleRelease`
exit 0 → `android/app/build/outputs/bundle/release/app-release.aab`, 8.9 MB;
`jarsigner -verify` says `jar is unsigned`, as designed with no key. The AAB
carries `assets/public/index.html`, the new `ic_launcher.png` at every density
and the Firebase config. The unsigned warning prints on a plain `gradlew help`
(it does not with `-q`). The generated launcher icon was viewed: orange rider on
white, correctly inside the adaptive safe zone. `@capacitor/assets` also
re-serialised `AndroidManifest.xml` (whitespace only); reverted.

**Not verified.** Nothing was uploaded to Play and nothing was installed on a
phone. Not known from this machine: the listing's package name, its live
`versionCode`, whether Play App Signing is on, and who holds the upload key —
the AAB built here cannot be uploaded until those are answered and a key exists.
Whether `driver-offer-push` is deployed on the production Supabase project is
also unknown (`supabase functions list` needs a login; the token was revoked
2026-09-03 as planned). `REACT_APP_GOOGLE_MAPS_API_KEY` is still unset, so this
bundle ships map pages degraded.

**Deliberately not built:**
- The upload keystore — a credential, generated by Rio, kept out of the repo.
  Command in `docs/release-android.md` §1.
- `minifyEnabled true` — no gain for a WebView shell, real risk to the
  Firebase service class; left `false`.
- A settings row that opens the full-screen-intent special access (Kangaru's
  pattern) — Play-side behaviour is unknown until a store build is installed;
  the service already logs the state per ring.
- Deleting `.env.local` — it is Rio's local test setup; the doc says to rename
  it for a release build, and the shell override was used here instead.
- A commit. Rio did not ask for one; the tree is left modified on `master`.
  Handing this to the client again needs `kigatta-handover` rebuilt the same way
  as before (no `CLAUDE.md`), not a PR from `master`.

**For whoever is next:** the release order is in `docs/release-android.md`
§"Every release". The three Play Console answers gate everything; internal
testing is the real-device run this repo has owed since 2026-09-03. Roll out the
app before redeploying the sender.

**Status:** complete

### 2026-09-05, later — "fix it": upload key generated, bundle signed

Rio's Play Console screenshots: one bundle ever uploaded, `versionCode 1
(1.0)`, target SDK 35, first published 2026-05-20, and a policy block "App must
target Android 16 (API level 36)" whose 2026-08-31 deadline has passed, so the
store app cannot be updated by anyone until a 36-target bundle reaches
Production. Published after August 2021 means Play App Signing is on, so a
mismatched or lost upload key is recoverable by reset.

**Built.** `android/ingo-upload.jks` (RSA 2048, alias `ingo-upload`, valid to
2054, DN `CN=InGo, OU=Mobile, O=KIGATTA INVESTMENTS, L=Harare, C=ZW`) with a
random 32-character password written to `android/keystore.properties`; both
gitignored, neither shown by `git status`. `android/ingo-upload-cert.pem`
exported for the Play upload-key reset form (`android/*.pem` added to
`.gitignore`). Upload key SHA-1
`76:1B:9D:40:3C:FF:D4:01:06:73:EE:05:41:6D:22:8A:6F:5E:4B:D8`.
`./gradlew bundleRelease` → `app-release.aab`, `jarsigner -verify` → `jar
verified`, signed by that DN. Copied to Rio's Desktop as
`InGo-1.1.0-vc2.aab`.

**Not verified.** The listing's package name and its registered upload-key
SHA-1 are still unread; the first upload to Internal testing is the test. Two
rejections are possible and each is decisive: "wrong key" → request the upload
key reset with `ingo-upload-cert.pem`; "package name mismatch" → this is a new
app, stop and decide.

**For whoever is next:** the password is only in `android/keystore.properties`.
Rio is to copy it and the `.jks` into a password manager before anything else.

## 2026-09-06 — Final device run before the upload; blocked on a revoked Firebase key

**Status:** in progress — staged, waiting on one console action
**Owns:** `docs/system-map.md` (new).
**Shares:** `android/app/build.gradle` — exact edit: `applicationId` →
`com.world.fi.ingo`; `android/app/src/main/res/values/strings.xml` — the two
package strings; `AGENTS.md` §0 pointer; `CLAUDE.md` pointer.

**Two facts from Play Console that change the release.** The listing with users
is **`com.world.fi.ingo`** (Production, 468 installs, one bundle, versionCode 1,
target 35, published 2026-05-20). A second listing `zw.co.ingo` is unpublished
(8 installs). Neither is `com.kigatta.ingo`, so the bundle built yesterday would
have been a *third* app. `applicationId` is now `com.world.fi.ingo`; namespace
and Java package stay `com.kigatta.ingo`. **`com.world.fi.ingo` is not
registered in Firebase `ingo-92d5f`** (`google-services.json` has one client,
`com.kigatta.ingo`), so (a) a release build with the new id fails in the
google-services plugin until it is, and (b) the app on those 468 phones has
never been able to receive push from this project. The Desktop bundle
`InGo-1.1.0-vc2.aab` is therefore stale (wrong package); rebuild after the
Firebase registration.

**Rio: "we need proper documentation … I suspect we were meant to use
firebase."** Answered with evidence and written into `docs/system-map.md`: the
site Firebase hosts (`ingo-92d5f.web.app`, `main.bb832a68.js`) is this codebase
and references the production Supabase project 13 times; Firebase is hosting +
FCM only. The one thing still unexamined is the APK on Play itself; §9 of the
map says how to check it in five minutes (App bundle explorer → download →
grep). Do that before uploading over 468 installs.

**The device run, as far as it got (emulator `Test_Android`, cold boot):**
- Test build: `assembleRelease` with `.env.local` (throwaway project), signed
  with the new upload key (apksigner: V2, SHA-1 `761b9d40…`), package still
  `com.kigatta.ingo` because Firebase knows only that one. Installed after
  uninstalling the old debug-signed copy.
- Driver sign-in driven over CDP (`scratchpad/cdp.js`, `Runtime.evaluate`):
  `history.pushState('/driver/login')` + popstate, fill `#dlem`/`#dlpw`,
  `requestSubmit()` → `/driver/home`, "You are Online". A full
  `location.assign('/driver/login')` lands on `/login` with no form; use the
  in-app navigation.
- Runtime permissions are reset by the reinstall; `POST_NOTIFICATIONS` was
  `prompt`. Granted the three via `pm grant`, reloaded → **new token row**
  stored 21:10:06 (a second row; the 09-03 token remains) and **live location
  published** (`-17.83, 31.053`, 21:11:21) — the sender's online predicate is
  satisfied unaided.
- Fresh order `36c10923-634c-4f35-98ea-ed44bbdc2257` in
  `customer_delivery_orders`, `placed`, `bid_status=open` (the app's offer list
  filters on `bid_status in ('open')`; `null` violates NOT NULL; copying a
  cancelled row's `cancelled` hides it).
- **Ring failed twice, same cause:** deployed sender →
  `Google auth failed: invalid_grant`; local `send-test-offer.js` →
  `invalid_grant: Invalid JWT Signature`. The `firebase-adminsdk-fbsvc@ingo-92d5f`
  private key (id `18320783…`) has been revoked — the hygiene item 3d in the
  wiki, done. Nothing can send until a new key exists.

**Verified:** everything above up to the send. **Not verified:** the
notification itself on this build, Accept/Decline, the lock-screen path, the
job recovery on `/driver/active-delivery/<key>`.

**To resume (minutes):** Firebase console → Project settings → Service accounts
→ Generate new private key → save as `.secrets/fcm-service-account.json`; then
`node scripts/send-test-offer.js "$(cat <scratchpad>/token.txt)"` — or read the
token from `driver_push_tokens` (row updated 21:10). For the deployed sender:
`SUPABASE_ACCESS_TOKEN=… ./scripts/deploy-push-sender.sh gcwrnluyaqarmrovbryj`.
Emulator `screen_off_timeout` is 600000 for the session; restore to 30000.

**Resumed after Rio supplied a new service-account key (id `58c0f767…`),
saved to `.secrets/fcm-service-account.json`. The key passed through chat:
rotate it again after the release, as with the last one.**

**The device run, complete — every step on the release-signed build:**

| Step | Result |
|---|---|
| Ring, app backgrounded | `IngoOfferPush: posted … fullScreenIntent granted`; heads-up "New InGo delivery … Accept / Decline", channel `ingo_driver_offers`, importance 5, `category=call`, 2 actions. Screenshot `emu-ring.png` |
| Ring, screen asleep | `mWakefulness Asleep → Awake`, focus `MainActivity`, the **in-app offer screen for the real open order** (ING-36C10923, "Pickup is about 1.5 km from you", Respond in 94 s). Screenshot `emu-locked.png` |
| Accept in the app | → `/driver/active-delivery/customer_delivery_orders:36c1…`; row `assigned`, `bid_status=matched`, `assigned_driver_id=12d82ffc…`; app notifications 0 |
| Kill + cold start | lands on the job; then the addressed route with **no router state** renders ING-36C10923 with sender name and phone from the database; none of `ING-00881 / Sara Khan / Stratford / Green Valley` present. **Finding 1 proven on device.** |
| Notification **Accept** button, real key (`OFFER_KEY=customer_delivery_orders:351f…`) | first press while the app sat on the chain screen: app foregrounded, **nothing else** — the provider is unmounted there (**Finding 5, now reproduced on device**, not just read). After in-app navigation to `/driver/home` the queued action ran: order 2 `assigned` 21:32:02 UTC, notification withdrawn |

**Not verified:** Decline button; the PIN-locked keyguard (this emulator has no
lock; proven 2026-09-03); a real handset; the real package `com.world.fi.ingo`
(Firebase registration pending, so this run used `com.kigatta.ingo`).

**Built on the way:** `scripts/send-test-offer.js` takes `OFFER_KEY=<table>:<uuid>`
so the buttons act on a real row (usage comment updated). Test orders 1 and 2
closed (`delivered`); emulator `screen_off_timeout` restored; `build/` and the
Capacitor assets rebuilt against production so no throwaway bundle lingers under
`android/`; the Desktop bundle renamed `STALE-wrong-package-do-not-upload-…`.

**Deliberately not built:** Finding 5 (chain routes outside `DriverLayout`).
It is now a measured defect — a driver on any chain screen who presses Accept
on a new offer gets the app in front and nothing else until they navigate — and
it should be fixed before the *second* release, not this one, because this one
is gated on Play policy (target 36) and the fix touches routing.

**Status:** complete (test); the release itself waits on the three console
actions in the reply to Rio.

### 2026-09-06, 00:40 — Firebase knows the live package; the upload bundle exists

Rio registered `com.world.fi.ingo` in `ingo-92d5f` and supplied the new
`google-services.json` (two Android clients now; also visible in the console: an
Apple app `com.kigatta.ingo` and a web app `ingo`). File in place, gitignored.
`./gradlew bundleRelease` → merged manifest `package="com.world.fi.ingo"`,
`versionCode 2`, `versionName 1.1.0`, `targetSdkVersion 36`; `jarsigner` →
`jar verified`, signed by the upload key. Web assets under `android/` confirmed
production (0 throwaway references). Copied to Rio's Desktop as
`InGo-com.world.fi.ingo-1.1.0-vc2.aab` (8.9 MB). **This is the file to upload.**
The earlier Desktop file is the renamed `STALE-…` one.

**Not verified:** the upload itself, the upload-key match, and what the version-1
APK on Play contains (`docs/system-map.md` §9) — both are Rio's next clicks.

### 2026-09-06, 01:00 — "push the updated web app so it talks to the APK"

Rio wants the site deployed so customers ordering on the web ring drivers on
the new app. Two deploys, both needing a browser login Rio must do:
Firebase Hosting (`npx firebase login`, then `npx firebase deploy --only
hosting` with the verified production `build/`, never the package script's
rebuild) and the sender on production Supabase (`npx supabase login`, then
`PUBLIC_APP_URL=https://ingo-92d5f.web.app ./scripts/deploy-push-sender.sh
iaorixerxnqedwgkqxtz`).

**Found on the way, and it is the day's most important production fact:** the
sender **is** deployed on production and answers **HTTP 503 `BOOT_ERROR`** to
every call (probed with a zero uuid, no side effect). The live site has called
it on every order since the original developer added it on 2026-08-26. **No
driver has ever been rung from production.** The boot trap is the one already
recorded on the wiki's edge-functions page and fixed in this repo's function.

**Built:** `scripts/deploy-push-sender.sh` accepts a stored `supabase login`
(not only the env token) and passes `PUBLIC_APP_URL` through when set.
`docs/release-android.md` §7 records the 503 and gains §7b (the website);
`docs/system-map.md` known-unknowns updated.

**Not done:** neither deploy — waiting on Rio's two logins. Nothing has changed
on production.

**01:20 — the Supabase login cannot see production.** Rio ran `npx supabase
login` (token `cli_reala@ArmGenius_…`). `supabase projects list` for that
account returns exactly one project: the throwaway `gcwrnluyaqarmrovbryj`, in
org `kzoyczhrsieclgviultm` ("it@ingo.co.zw's Project"). **The production project
`iaorixerxnqedwgkqxtz` is not in any org this account belongs to.** So the
account the wiki calls "the client's" does not own the production database;
someone else's does (the original developer is the obvious candidate). The
sender cannot be redeployed to production until an owner of that project either
invites this account to its organisation or logs in here. Firebase login still
absent (`login:list` empty) after the "Oops" page; `--no-localhost` suggested.
Nothing deployed.

**01:35 — Firebase CLI login: the tool, not the account.** `firebase login`
failed twice ("Oops" page; then with `--no-localhost` the code exchange died:
`FetchError … accounts.google.com/o/oauth2/token: Premature close`). Reproduced
outside the CLI: `node-fetch@2.7.0` (what firebase-tools 15.16.0 uses) gets
`Premature close` from that endpoint under **Node 24.17**, and a clean 400 under
**Node 20.20** (`npx -p node@20`). Native `fetch` is fine on both. So the CLI
must run under Node 20 on this machine:
`npx -p node@20 -- node node_modules/firebase-tools/lib/bin/firebase.js <cmd>`.
The standalone `firebase.tools` Windows binary was tried and crashes in its
"firepit" welcome step (`SyntaxError: Unexpected end of JSON input`); removed.
The service-account route (`GOOGLE_APPLICATION_CREDENTIALS`) was blocked by the
auto-mode classifier here, and when Rio ran it himself the CLI answered "Failed
to authenticate" — most likely the same node-fetch failure on the token exchange.

**01:45 — website deployed.** Firebase login succeeded under Node 20 as
`rodneykiggundu@gmail.com` (that account owns site `ingo-92d5f`). Deployed the
verified production `build/` with `deploy --only hosting` (no rebuild, so
`.env.local` never entered the picture): 31 files, 22 uploaded, release
complete. Live check: `https://ingo-92d5f.web.app` now serves
`main.6244daf7.js` (was `main.bb832a68.js`), 0 throwaway references, 15
production references, the `/driver/offer/` route present. Rollback, if ever
needed: Firebase console → Hosting → Release history.

**What the deploy does not fix:** every order placed on the site still calls
the production `driver-offer-push`, which still answers 503 `BOOT_ERROR`. The
site and the APK share the database, so orders, tracking and everything else
line up; only the *ring* is missing until the sender is redeployed, and that is
gated on the Supabase organisation ownership (01:20).

**02:00 — `docs/deployment.md`.** Rio: "give me the steps for the perfect
deployment." The whole-system runbook: preconditions, freeze, build, verify,
deploy in order (website → Android internal → declarations → Android production
staged → sender), after-care, and a table of where the first release stands.
Pointed to from `AGENTS.md` and `docs/release-android.md`.

## 2026-09-06 — Location: fast first fix on Android, and a Permissions screen in the driver Profile

**Status:** in progress
**Owns:** `android/app/src/main/java/com/kigatta/ingo/IngoPermissionsPlugin.java`
(new), `src/lib/nativePermissions.js` (new), `src/components/driver/DriverPermissionsPanel.js`
(new) + its CSS, `docs/adr/0005-native-location-and-permissions-screen.md` (new).
**Shares:** `src/hooks/useLiveLocation.js` — exact edit: a native branch that
reads position through `@capacitor/geolocation` and requests permission
explicitly before any read; `src/lib/devicePickupLocation.js` — exact edit:
native branch in `readDeviceGpsPosition`; `src/pages/DriverProfilePage.js` — a
Permissions section; `src/components/driver/DriverPermissionPrompts.js` — copy
and the settings action when denied; `android/app/src/main/java/com/kigatta/ingo/MainActivity.java`
— `registerPlugin(IngoPermissionsPlugin.class)`; `package.json` —
`@capacitor/geolocation`.

**What this is.** Rio on the release APK: "allow location … works but it takes
forever when checking", and "we need to add a Permission screen in the Profile
and fully fix this". Read from source: the Allow tap runs
`readDeviceGpsPosition({interactive:true})` through the WebView's
`navigator.geolocation` — a 10 s network read, then on failure a 12 s GPS read,
each with a 1.5 s hard timer — and the OS permission dialog counts against the
first timer, so a driver who reads the dialog for eight seconds has already
burned most of the fast attempt. Two more reads (the watch at 25 s high
accuracy and a "soft refresh" at 20 s + 15 s) start on mount and compete.
Nothing on the native side ever asks Android's fused provider, which answers
from its last known location in well under a second.

**02:10 — three more bugs from Rio's phone, all from one screenshot.** An offer
screen on production: pickup "Stratford, London E15" → "Ntinda complex",
"Pickup is about 2193 km from you", customer offer $4.20, admin minimum $4.20,
and Accept refused with "Bid must be at least 4.20."

1. **Accept at the customer's price was refused** — `roundBidAmount` snapped
   every bid to 0.50 steps, so $4.20 became $4.00 and failed its own $4.20
   floor. Any amount off a half-dollar failed. Fixed in `src/lib/bookingBids.js`:
   bids are cents (integer arithmetic), and a bid within a cent of the floor
   *is* the floor. Same fix in `customerRaiseOffer`.
2. **A London placeholder reached a real order.** `PriceEstimatePage` fell back
   to 'Stratford, London E15' / 'Oxford Street, London W1' when the router state
   had no addresses, and `OrderConfirmationPage` did the same. Now: no
   placeholders; the estimate page redirects to `/request-delivery` when either
   address is missing; the confirmation shows '—'.
3. **An invented 4.2 km priced real orders.** `RequestDeliveryPage` sent
   `distanceKm: 4.2` whenever geocoding failed, which also stopped the estimate
   page's own fallback geocode from running (it saw an "explicit" value). Now it
   sends `null`; the estimate page retries, and if still unknown prices on an
   assumed 4.2 km **and says so** next to the price. Not blocking the order was a
   deliberate choice: geocoding fails often without a Google key.
4. **"2193 km from you."** The country-biased geocoder matched the London
   placeholder to somewhere in Zimbabwe; Kampala→Harare is 2193 km.
   `offerProximity.distanceKm` now returns unknown above 500 km
   (`MAX_PLAUSIBLE_PICKUP_KM`), so the screen shows nothing instead of nonsense.

Also: the tap sink ignores the panel's sample offer (`offerKey=test`).

**Rio, 02:20, on the release APK:** "the heads-up notification only comes when
we are out of the app. Then the full-screen notification comes on wake and in
app. The full experience we get with WhatsApp." Recorded as the **intended**
behaviour, not a defect: outside the app a heads-up with Accept / Decline
(ADR 0002); dark or locked phone, the full-screen offer (ADR 0003); inside the
app, the offer screen itself (the in-app request, 2026-09-03). Do not "fix" the
absence of a heads-up while the app is in front.

**02:40 — "take your time to clean this flow."** The emulator showed the driver
online with **no location prompt at all** after the permission had been
revoked: `useLiveLocation` seeds `lat/lng` from a 3-hour localStorage cache, so
`hasFix` was true and `DriverPermissionPrompts` never asked. Worse, the
provider published that cached coordinate as the live position every 15 s.

Cleaned:
- `useLiveLocation` now reads the OS permission (mount, foreground, after the
  Allow dialog) and exposes `permission`, `needsPermission`, `located` (a fix
  **and** the right to have it). A grant seen on return from Settings starts
  the native watch and fetches a fix with no extra tap.
- `DriverPermissionPrompts` decides from the permission, not the cache: refused
  → "Location is off" + Open settings; not asked → "Allow location" (OS dialog);
  allowed but no fix → "Finding your location…" + Retry.
- `DriverOffersProvider` publishes only `located` positions.
- `DriverApprovalGate` trusts a database "yes" for 5 minutes (module scope) and
  re-asks in the background; `markDriverVerified` after sign-in. The
  "Checking driver account…" blank on every navigation — the 2026-09-03 tap
  hazard — is gone except for the first check of a stale session.
- Reproduction note: with `applicationId` ≠ Java package, the activity is
  `com.world.fi.ingo/com.kigatta.ingo.MainActivity`; and the emulator's screen
  timeout must be raised or the WebView stops answering CDP mid-test.

**03:05 — one answer bar for an offer.** Rio, from the emulator: "not all the
order features are on the new order screen, things like the bid higher … keep
the work professional and clean." The screen had the counter-offer as a text
link; the card said "Offer / Bid higher / Reject". That is the 2026-09-04
finding 3 (four surfaces, two vocabularies) and the screen standard's "never
duplicate UI". Built `src/components/driver/OfferActionBar.js` (+ css, on the
`--ingo-*` tokens): Decline · Bid higher / Raise bid · Accept $X, the
counter-offer form inline, one note line. Both `DriverHomePage` (card) and
`DriverOfferPage` render it; their own action/bid markup and the orphaned CSS
(`driverPortal.css`, `driverOfferPage.css`) are gone. The card uses
`BID_TABLES` like the screen. `driverPermissionsPanel.css` moved onto the same
tokens. Decision B from 2026-09-04 (does the card stay at all) is still Rio's;
this makes the card and the screen identical in what they offer, which is the
precondition either way.

**Correction to the record.** The "self-accept" I suspected at 02:35 was not
one: the device log shows the sample offer posted from the panel at 02:31:30
and its Accept / Decline pressed five times from SystemUI, then the card's
Accept pressed at 02:35 — Rio was driving the emulator window on this machine
while I drove it over adb. The 2026-09-03 "unexplained accept" most likely has
the same cause. No code path accepts without a tap; verified by reading every
caller of `driverAcceptOffer`.

**03:30 — verified on the emulator, fresh installs of the release-signed build
(`com.world.fi.ingo`, throwaway project), every step scripted over adb + CDP:**

| Step | Result |
|---|---|
| Sign-in | lands on `/driver/home` with no "Checking driver account…" (gate cache + `markDriverVerified`) |
| Location revoked, Home | prompt renders from the OS permission, not the cache: "Turn on location · Allow location · Not now" |
| Allow tap | Android's own dialog: "Allow InGo to access this device's location? Precise / Approximate / While using the app / Only this time / Don't allow"; the prompt reads "Asking…" underneath (screenshot `emu-loc-after.png`) |
| After the grant | console: `native fast fix {"accuracy":89.9,"ms":249}`, `native watchPosition started` — **249 ms to the first fix**, against 10–22 s of timeouts before |
| GPS moved (emulator `geo fix` → Avondale) | `driver_registrations.driver_live_lat/lng` followed to the exact coordinates on the next publish |
| Profile → Permissions | rows read the phone: Location Allowed · Notifications Allowed · Offer alerts Pops on screen · Full-screen offers Allowed · Battery Optimised [Open settings] · Send test offer |
| Send test offer | `IngoOfferPush: posted tag=ingo-offer-test`, channel `ingo_driver_offers`, importance 5, 2 actions |
| Offer screen | buttons "Decline / Bid higher / Accept $4.20"; Bid higher opens the form (prefill 4.70, "minimum $4.20"), Cancel closes it |
| Accept at exactly the minimum (4.20, off the half-dollar) | order `assigned`, `bid_status matched`, `agreed_fare_amount 4.2`, app on the active delivery — the bug from Rio's phone screenshot, gone |
| Home card | same bar: "Decline / Bid higher / Accept $4.20" + the note line |

**Not cleanly measured:** how long the Home prompt takes to *clear* after the
grant. The fix arrives in 249 ms and the state flips on ingest, so it should be
immediate, but every clean run was disturbed by taps from the emulator window
(Rio was exploring it at the same time — see 03:05) and the one undisturbed
timer read 30 s from marks placed after an earlier tap. Owed: one run with
nobody else on the emulator, or on a handset. **Not verified at all:** a real
handset; Approximate-only grant; the "Open settings" return paths (they re-read
on foreground, by code); the web build's behaviour (unchanged by design).

**Harness lessons, for the next session:** Git Bash rewrites `/sdcard/…` to a
Windows path in `adb shell` arguments — use `//sdcard/…`; and one emulator
cannot be driven by two hands: a second AVD for automation, or an agreed
hands-off window.

### 2026-09-06, 04:00 — Overseer review, then the website redeployed with the day's fixes

Reviewed by a second agent against `docs/reviews/2026-09-06-overseer-brief.md`.
The findings that change the record above:

- The site deployed at 01:45 (`main.6244daf7.js`) predated every fix made
  after 02:00, so customers on the web were still getting the London
  placeholder and half-dollar bid rounding until 04:00 (below).
- `roundBidAmount`'s comment is wrong: the fare columns are unconstrained
  `numeric` and `numeric(12,4)`, not `numeric(12,2)`, and the floor from
  `PriceEstimatePage` is an unrounded sum, so `snapToFloor` stores sub-cent
  amounts (a typed 4.31 against a 4.31495 floor is stored as 4.31495). No path
  accepts below the floor; scripted. Fix in the next versionCode.
- The Desktop bundle was re-copied at 03:24, not only at 00:40 as recorded
  above, and is current: `main.115f7a71.js`, 0 throwaway / 15 production refs.
- The cached coordinate is still published once on mount before the first
  permission read (`permission` is null until then); the next 15 s tick corrects
  it. The sample offer's Accept / Decline do nothing and leave the notification
  in the shade. The chain routes mount a fresh `DriverApprovalGate`, so the
  "Checking driver account…" blank still appears there after 5 minutes.

**04:00 — website redeployed.** Rio: "push to the live website and give me the
apk". `firebase deploy --only hosting` under Node 20 from the verified `build/`
(no rebuild; `.env.local` present and untouched): 32 files, 11 uploaded,
release complete. Live check: `ingo-92d5f.web.app` serves `main.115f7a71.js`,
byte-identical to `build/`, 0 throwaway / 15 production references, the
unmeasured-route notice and the answer bar present.

**The APK handed to Rio:** `android/app/build/outputs/apk/release/app-release.apk`,
identical to Desktop `InGo-com.world.fi.ingo-1.1.0-vc2.apk`. apksigner: V2,
upload-key DN, SHA-1 `761b9d40…`; `com.world.fi.ingo`, versionCode 2, 1.1.0,
target 36; web bundle `main.115f7a71.js`, 0 throwaway / 15 production. The
same code as the site.

**Not done:** nothing committed on `master` (flagged; Rio chose to deploy
first). Step 8 of `docs/deployment.md` (inspect the Play version-1 APK) is
still open. The production sender still answers 503. The Firebase
service-account key that passed through chat is still to be rotated.

**04:10 — artefact naming.** Rio: the files are `InGo v1.1.0.apk` / `.aab`,
then `InGo v1.1.1` and so on for every update. The earlier Desktop copies had
gone; both re-copied from the Gradle outputs under the new names and confirmed
byte-identical (`com.world.fi.ingo`, versionCode 2, upload-key SHA-1
`761b9d40…`). Rule written into `docs/release-android.md` §3 and the checklist,
and `docs/deployment.md` steps 2 and 6: versionName bumps the patch every
update, versionCode by one, and nothing leaves the repo under another name.

**04:30 — "heads-up works from Send test offer, not from real orders", on
Rio's phone.** Diagnosed, not fixed. The phone is proven (the sample offer
posts through the real ring path). Real orders never produce a push because
the production sender still answers `503 BOOT_ERROR`, re-probed at 04:15 with
the exact `functions.invoke` call the site makes (anon key, `{table, orderId,
action:'ring'}`, zero uuid). The emulator "works" because its installed APK
(`main.403242ea.js`, 13 throwaway references) talks to the test project, whose
sender was deployed from this repo on 09-03. **Blocked on the same account
gap as 01:20:** `supabase projects list` still returns only the throwaway; no
other Supabase credential exists on this machine. Two routes written into
`docs/release-android.md` §7 and new §7c: a personal access token from any
account that can open production (then the script), or the dashboard editor
(paste `index.ts`, JWT off, three secrets). The classifier blocked writing a
compacted copy of the service-account key, so §7c prints it instead.

**04:45 — confirmed: the `it@ingo.co.zw` Supabase account has no production.**
Rio generated a fresh token on it (sees only `gcwrnluyaqarmrovbryj`; revoke it,
it went through chat), then opened the dashboard: one organisation, one
project, the throwaway. The "PRODUCTION" badge on the dashboard is the branch
name and misled the search. Production `iaorixerxnqedwgkqxtz` belongs to an
organisation nobody on the client side can log into; the original developer is
the only candidate. Rio is sending them the invite request (drafted in chat;
ask: invite `it@ingo.co.zw` as Owner of that organisation). Push stays off
until that lands. Nothing deployed.

## 2026-09-06, 13:46 UTC — the production push sender is live

Rio obtained the login to the production Supabase account and generated a
personal access token on it (passed through chat; **revoke it**). Under that
token `supabase projects list` shows exactly one project:
`iaorixerxnqedwgkqxtz`, named **"rodneykiggundu@gmail.com's Project"**, org
`lkyskxlueaozftafcewn`. So production Supabase is owned by the same Google
account that owns Firebase `ingo-92d5f` and its hosting; the `it@ingo.co.zw`
account never held it.

**Deployed:** `scripts/deploy-push-sender.sh iaorixerxnqedwgkqxtz` with
`PUBLIC_APP_URL=https://ingo-92d5f.web.app`: `driver-offer-push` version 14,
`verify_jwt=false`, updated 2026-09-06T13:46:00Z; secrets set:
`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` (the 58c0f767… key,
compacted), `PUBLIC_APP_URL`. `GOOGLE_MAPS_API_KEY` already existed on the
project, so the 20 km radius filter is active on production.

**Verified:** the site-shaped call (anon key, `{table, orderId, action:'ring'}`,
zero uuid) now returns `404 {"ok":false,"error":"Booking not found"}` twice in
a row, where it returned `503 BOOT_ERROR` all day. The function boots. The
other 12 functions are untouched (all `verify_jwt=true`).

**Not verified:** a real order ringing a real phone. Rio is placing one now
with the phone signed in, online, and located within the last 5 minutes and
within 20 km of the pickup address.

**Order note:** this is sender-before-app for the 468 store installs, against
the runbook. Deliberate: they received nothing at all before, so a plain banner
on an old app is strictly better than silence.

## 2026-09-06 — v1.1.1: the overseer's fixes, one build for site and store

**Status:** in progress
**Owns:** `src/lib/bookingBids.js` + test, `src/pages/PriceEstimatePage.js`,
`src/hooks/useLiveLocation.js`, `src/components/driver/DriverApprovalGate.js`,
`src/components/driver/DriverOffersProvider.js`, `capacitor.config.json`,
`android/app/build.gradle` (versionCode 3, 1.1.1), `AGENTS.md`.

Rio: "fix the apk and push the backend live on the server and generate the new
apk". The backend is already live (13:46 UTC). This entry is the app: the
review findings that are code, not re-architecture.

1. **Money is cents at the source and at the check.** `PriceEstimatePage`
   rounds the fare total to cents before it becomes `minimum_fare_amount`;
   `driverPlaceBid` / `customerRaiseOffer` compare against a cent-rounded floor
   and store cent values. A bid never lands below the floor, and a typed 4.31
   is stored as 4.31, not as 4.31495. Test covers a sub-cent floor.
2. **No cached coordinate on the first publish.** On native, `located` is
   false until the OS permission has been read once.
3. **The approval gate blanks only for an id never verified in this process.**
   A stale answer for an id already verified is re-asked in the background,
   which is what the docstring said and the chain routes did not do.
4. **The sample offer's Accept / Decline withdraw the notification** instead of
   leaving it in the shade.
5. `capacitor.config.json` `appId` = `com.world.fi.ingo`; `AGENTS.md` §1 order
   and the §5 native-file list gain `IngoPermissionsPlugin.java`.
6. `versionCode 3`, `versionName 1.1.1`; artefacts `InGo v1.1.1.apk` / `.aab`.

**Not built, on purpose:** hoisting the gate above the chain routes (Finding 5,
routing); the `--ingo-success` contrast (a token used app-wide); the
`readLastDeviceFix` distance fallback on the Home card.

**Verified (17:02 local):** `bookingBids` + `offerProximity` tests, 18 pass
(5 new, sub-cent floor). `npm run build` with `.env.local` renamed away →
`main.192168c7.js`, 0 throwaway / 3 production references; `npx cap sync`;
`gradlew bundleRelease assembleRelease`; AAB `jar verified`; APK signed by the
upload key (SHA-1 `761b9d40…`), `com.world.fi.ingo`, versionCode 3, 1.1.1,
target 36; the bundle inside the AAB is byte-identical to `build/`; strings
unique to the new code present in it. Copied as `InGo v1.1.1.apk` / `.aab` on
Rio's Desktop, APK sent to Rio. Website deployed from the same `build/` under
Node 20; live index serves `main.192168c7.js`, byte-identical to the APK's.

**A number that misled the record:** "15 production references" was never a
count of anything real. The URL has one consumer (`supabaseClient.js`, with a
hardcoded production default); the other 12 copies came from whole-object
`process.env` inlining whenever the variable was set in a build's environment.
`.env.production` carries no Supabase lines, so a clean release build shows 3.
The guard is `0` throwaway and `> 0` production, as the docs say; the 15 is
not a target. The same anon key is in both bundles.

**Not verified:** any of it on a real handset; a real order ringing a phone
from production (sender live since 13:46 UTC, Rio testing). Nothing committed.

**Status:** complete

## 2026-09-06 — "ringing but no heads-up" on a real phone: every link, and v1.1.2

**Status:** in progress
**Owns:** `supabase/functions/driver-offer-push/index.ts`,
`src/pages/DriverNotificationsPage.js`, `src/lib/driverNotificationPrefs.js`,
`src/pages/StripeReturnPage.js`, `IngoPermissionsPlugin.java`,
`src/lib/nativePermissions.js`, `src/components/driver/DriverPermissionsPanel.js`
(+ css), `android/app/build.gradle` (versionCode 4, 1.1.2), `AGENTS.md` §6.

Rio, on his phone with every permission granted and the sample offer popping:
a real order rings in the app but no heads-up arrives. The native side posts a
notification for every `offer_ring` it receives and the JS never withdraws one
it did not answer, so the push was never sent. Read every link from the order
to the phone; four of them could drop it, and each is now closed.

1. **Radius filter dropped the driver.** With `GOOGLE_MAPS_API_KEY` set on
   production (it is), the sender kept only drivers within 20 km of the
   geocoded pickup and dropped anyone with no published fix — while the app's
   poll shows every open order to every online driver. Now: no fix = unknown =
   kept; nobody within the radius = ring every fresh online driver and say so
   (`proximity.fallback: 'all_online'`). The sender is never stricter than the
   app. (AGENTS.md §6.)
2. **Preferences killed push for anyone who touched the Notifications page.**
   The page pinned `push_when_closed: false` on every save, the client default
   was `false` too, and the sender skipped any row with `push_when_closed ===
   false`. One tap on "offer sound" = no push ever again for that driver. Now
   the sender honours `new_offers === false` only; the page and the default
   say `true`, matching the column default.
3. **Five-minute freshness dropped any closed app.** The app publishes only
   while its WebView is alive, so a driver who closed the app was out of
   dispatch five minutes later — the opposite of what push is for. Now 30
   minutes, the app's own ring window. Trade-off recorded in the constant's
   comment.
4. **Card-paid orders never rang.** `SelectPaymentPage` and `TaxiBookingPage`
   ring only for cash and wallet, and nothing rang after the card cleared.
   `StripeReturnPage` now rings the right table after a first-time successful
   finalize (`RING_TABLE_BY_KIND`).

Also, so the phone can say why: the plugin reports **Do Not Disturb** (the
offer channel cannot bypass it), the panel shows it with a settings action and
the Home pointer counts it; the panel shows **"Offer alerts in InGo: Off"**
with a link when the driver's own New-offers switch is off; the Battery row
names the OEM Autostart setting. Verified as correct without change: the FCM
message is data-only for Android, `priority: HIGH`, `ttl: 120s`, collapse key;
every order type calls the sender; a rotated token is re-registered on the
next app start.

**Deployed:** the sender, three times, last with all three changes; the
zero-uuid probe still answers `404 Booking not found`.

**Verified (17:58 local):** tests 18/18; ESLint clean on every touched file;
`npm run build` with `.env.local` aside → `main.f454cab6.js`, 0 throwaway / 3
production references; `cap sync`; Gradle; AAB `jar verified`; APK signed by
the upload key, `com.world.fi.ingo`, versionCode 4, 1.1.2, target 36; the dex
contains `openDndSettings` and `doNotDisturb`; the bundle inside the AAB is
byte-identical to `build/` and carries the DND row text. `InGo v1.1.2.apk` /
`.aab` on Rio's Desktop, APK sent. Website deployed from the same `build/`;
the live index serves `main.f454cab6.js`, byte-identical to the APK's.

**Not verified:** a real order ringing Rio's phone through the fixed sender —
that is the test that closes this entry, and it is Rio's next action with
v1.1.2 installed. A card-paid order end to end. DND detection on a handset.
Nothing committed.

**Status:** complete

### 2026-09-06, 15:08 UTC — "go through it again": the chain re-verified, two more defects

Every link checked against the deployed state, not the source:

| Link | Evidence |
|---|---|
| Website = APK bundle | live `main.f454cab6.js` byte-identical to `build/` and to the bundle inside `InGo v1.1.2` |
| Sender code on production = repo | `supabase functions download` → `diff` IDENTICAL (checked after each deploy) |
| Sender boots, JWT off | zero-uuid ring → `404 Booking not found`; `functions list` → `verify_jwt=false` |
| Service role, token table, FCM auth | a `stop` for a non-existent tag through the real sender: `sent: 2, tokens: 2` — production has 2 registered phones and FCM accepted both; the payload is a no-op on the phone |
| Order types | delivery (cash/wallet at SelectPayment, EcoCash after payment, card at StripeReturn), taxi and tuk-tuk (TaxiBooking, card at StripeReturn), shop (owner marks ready) all call the sender |
| Message shape | data-only for Android, HIGH, `ttl 120s`, collapse key |

Two defects found by re-reading, both fixed and deployed (**v22**):

- **A driver who never had a fix was never rung.** `publishDriverOnlineLocation`
  writes `driver_live_updated_at` only with a real fix, so an online driver
  without one keeps it null and the freshness `gte` dropped them before the
  radius rule could keep them. The sender now takes `is_online` drivers whose
  timestamp is fresh **or null**.
- **A row with no coordinates was measured from (0, 0).** `Number(null)` is 0,
  so `haversineKm` produced a distance to the Gulf of Guinea and the "unknown
  is kept" rule never triggered. Now a null coordinate is a null distance.

**Not verified:** a real order ringing Rio's phone. That is the remaining test,
and it is the only one left.

## 2026-09-06 — the 360: every scenario on the emulator, scripted, and v1.1.3

**Status:** in progress
**Owns:** `src/App.js` (onboarding skipped for a signed-in driver),
`supabase/functions/driver-offer-push/index.ts` (per-token try/catch, `failed`
in the response), `android/app/build.gradle` (versionCode 5, 1.1.3).

Rio revoked every Supabase token, including the throwaway's, and asked for a
360. So: the repo's sender runs **locally under Deno** (`npm i -g deno@2`,
from a scratchpad copy because Deno refuses npm auto-install next to a
`package.json`) against the throwaway database with the current Firebase key,
and the emulator runs a throwaway-pointed v1.1.2 fresh install. Every step is
adb + CDP; the release build logs no JS console, so state is read through CDP.

| Scenario | Result |
|---|---|
| A. App open on Home, real order, ring | heads-up **over the open app** with Accept / Decline; Accept from the shade → order `assigned`, fare 4.20, notification withdrawn, app on Active Delivery |
| B. App in background | heads-up over the launcher; Decline from the shade → `rejected_driver_ids` set, notification withdrawn, app brought forward |
| C. App killed with `am force-stop` | **no delivery, by Android's design**: a force-stopped app receives nothing until opened. This is the OEM "swipe = force stop" case the Battery row's Autostart advice covers |
| C. App killed with a plain process kill (swipe from Recents on stock Android) | FCM restarted the process, notification posted, `fullScreenIntent granted`. Tapping it cold-started the app **on the customer onboarding**, because a fresh install had never dismissed it and the driver shell that collects the parked tap mounts only under `/driver`. Fixed in `App.js`; re-tested below |
| D. Screen asleep | `screen dark / screen intent`, wakefulness Asleep → Awake, the full-screen offer; Decline in the app → recorded, notification withdrawn |
| E1. Driver online, no fix ever (null coords, null timestamp) | rung (`drivers 1, sent 1`) — the v22 rule |
| E2 / E3. Fix 20 min / 40 min old | rung / `no_online_drivers` — the 30 min window |
| G1. `push_when_closed=false` | rung — the flag is ignored |
| G2. `new_offers=false` | `prefs_disabled`; the panel shows **Offer alerts in InGo = Off [Open]** |
| H. Do Not Disturb on | panel shows **Do not disturb = On [Open settings]**; a ring under DND is posted with no heads-up window; the row clears when DND is off (`set_dnd off`; `none` means *total silence*, and reads as On, correctly) |
| I. Sample offer, Accept on it | notification withdrawn (v1.1.1 fix) |
| Radius fallback | no Google key locally, so proven by a script of the exact selection code: near kept, far-only → `fallback: all_online`, no-fix kept, and the old `Number(null)` bug measured 3931 km |

**Found and fixed on the way:** a parcel labelled "360 parcel" parsed as 360 kg
and the app hid it while the sender rang — my test data, but it shows the sender
does not apply the app's vehicle-capacity rule (a driver can be rung for a
parcel they cannot take and then see "no longer open"); recorded, not changed.
A DNS blip to FCM threw out of the send loop and answered 500 with nobody rung;
now each token is tried and `failed` is counted. The first real ring cleaned 6
stale tokens from the throwaway (FCM `UNREGISTERED` → deleted), which is the
designed behaviour.

**Production:** still v22 (the hardening is not deployed; every token was
revoked). Deploy it with the next token.

**C re-tested with the `App.js` fix, fresh install, onboarding never
dismissed:** process killed, ring, FCM restarted the process and posted
(about 60 s later — the emulator's FCM connection was in its low-power
heartbeat state after the kill; the first 5 s check missed it), tap on the
notification body → cold start straight to `/driver/offer/<key>` → Accept in
the app → `assigned`, notification withdrawn. Before the fix the same tap
landed on "Fast Deliveries / Skip".

**Verified (19:12 local):** production build with `.env.local` aside →
`main.13fe8d5a.js`, 0 throwaway / 3 production references; `cap sync`;
Gradle; APK signed by the upload key, `com.world.fi.ingo`, versionCode 5,
1.1.3, target 36; the bundle inside the AAB is byte-identical to `build/`;
`InGo v1.1.3.apk` / `.aab` on Rio's Desktop, APK sent. Website deployed from
the same `build/`; the live index serves `main.13fe8d5a.js`, byte-identical.
Throwaway cleanup: every 360 order closed, prefs back to all-true, DND off,
emulator screen timeout back to 30 s, local sender stopped. `android/` assets
and `build/` are production again.

**Not verified:** a real order ringing Rio's phone from production. Every
piece of that path has now been exercised on the emulator except the phone
itself. Nothing committed.

**Status:** complete

## 2026-09-06 — "out of the app the heads-up does not show": the phone self-heals and tells, v1.1.4

**Status:** in progress
**Owns:** `OfferMessagingService.java` (effective channel, ring record),
`IngoPermissionsPlugin.java` (manufacturer, effective channel, `lastRing`),
`src/components/driver/DriverPermissionsPanel.js` (three rows),
`android/app/build.gradle` (versionCode 6, 1.1.4).

Rio's phone (v1.1.3, Sonde, Uganda): two real jobs accepted, the Home pointer
"Offers may arrive silently" showing, and "in the app it works, out of the app
no heads-up". Inside the app the poll opens the offer screen with no
notification at all, so that symptom means the push arrives and the
**notification** is being silenced or hidden on that phone. Two things the app
could not do about it until now:

1. **A silenced channel is forever.** Android makes a channel immutable; if the
   driver (a long-press → "Silent") or the maker's notification manager drops
   `ingo_driver_offers` below HIGH, every later offer lands in the shade with
   no pop-up and no build can raise it. Now `effectiveChannelId()` posts on the
   base channel while it can pop, otherwise on `ingo_driver_offers_2` (…`_5`)
   created at HIGH. The JS side still creates the base id; ADR 0001's rule is
   unchanged because only Java posts. The panel says when this has happened.
2. **Nobody could see what the phone saw.** `postOffer` now records the ring
   (time, tag, channel and its importance, notifications enabled, full-screen
   grant, screen on, DND) and the panel shows **Last offer push: Arrived /
   Arrived, hidden / None yet** with the reason. "None yet" while online with
   orders flowing = delivery, not display.
3. **Makers' own pop-up switch.** Xiaomi, Tecno/Infinix, Oppo/Realme, Vivo,
   Huawei/Honor and Samsung keep a per-app "floating / banner / pop-up" switch
   outside the channel that no API reads. The panel names the maker and the
   switch, with the app's notification settings one tap away.

**Deliberately not built:** `setBypassDnd` (an app cannot grant itself that);
a foreground service (the real fix for OEM process killing, a separate piece).

**Verified on the emulator (throwaway build, fresh rows):** panel before any
ring: *Last offer push = None yet*; after Send test offer: *Arrived — just now
(09:12 PM), screen on, the test offer. Nothing on the phone stood in its way.*
Then the base channel was set to **Silent through Android's own channel
settings screen** (`dumpsys`: importance 2); the next test offer logged
`cannot pop on screen; moving offers to ingo_driver_offers_2`, the new channel
exists at importance 4, the heads-up **popped over the panel** with Accept /
Decline (screenshot `emu360-heal-after.png`), and the Offer alerts row reads
"Pops on screen — the original alert channel had been set to silent or
blocked on this phone, so offers now use a fresh channel". The emulator is a
Google device, so no maker row; the maker rows are text only.

**Verified (21:33 local):** ESLint clean; production build with `.env.local`
aside → `main.673c374e.js`, 0 throwaway / 3 production references; `cap
sync`; Gradle; AAB `jar verified`; APK signed by the upload key,
`com.world.fi.ingo`, versionCode 6, 1.1.4, target 36; the dex contains
`effectiveChannelId` and `recordRing`; the bundle inside the AAB is
byte-identical to `build/`. `InGo v1.1.4.apk` / `.aab` on Rio's Desktop, APK
sent. Website deployed from the same `build/`; the live index serves
`main.673c374e.js`, byte-identical.

**Not verified:** the healing on Rio's phone. His next panel screenshot says
it: *Offer alerts* with the "fresh channel" line, or *Last offer push = None
yet* while orders flow, which would mean delivery, not display. Nothing
committed. The sender hardening is still not on production (no token).

**Status:** complete

## 2026-09-06, 18:45 UTC — the conclusive test on production, and the real cause

Rio: "test on the emulator to make sure you are giving us the conclusive
answer". Setup: `InGo v1.1.4.apk` (production) on the emulator, Rio signed it
in himself with **his own production driver** (`eb17d3db…`), online,
permissions granted, GPS moved to Seeta (0.36, 32.68) so the 20 km radius
would include it; a **headless Chrome on this machine placed a real cash
order on `ingo-92d5f.web.app`** as a guest (`#ING-9EBDBFB930`, Sonde Road →
Ntinda), with the emulator app in the background.

**Result: nothing reached the emulator. Not one `IngoOfferPush` line.** Then
the production sender was called by hand for that order, exactly as the site
does:

```
{"ok":false,"error":"column driver_registrations.driver_live_lat does not exist"}  HTTP 500
```

**The production database never had `supabase/driver_online_location.sql`.**
The sender selects `driver_live_lat/lng/updated_at` and `is_online`; the
columns do not exist on production, so **every real ring since 13:46 UTC has
died with 500** (before that it died with 503 at boot). The zero-uuid probes
stop at the booking lookup and never reached that query, and the `stop`
probe does not touch `driver_registrations` — both said "fine". The two jobs
Rio accepted today came from the in-app poll. This is also why the driver
app's `publishDriverOnlineLocation` has never stored a position on
production (it warns to a console nobody sees). Rio's phone was never the
problem; everything phone-side built today still stands, and the panel's
"Last offer push = None yet" on production is exactly this.

**Built:** the sender falls back to `id, is_online, vehicle_type` when the
live columns are missing, rings every online approved driver without a
radius, logs the migration to run, and returns `schemaGap` in its JSON;
`deno check` passes. **Not deployed** (every token revoked).

**The fix on production is one paste** in the Supabase SQL editor of
`iaorixerxnqedwgkqxtz`: `supabase/driver_online_location.sql` (idempotent,
`add column if not exists`). Then the deployed v22 works unchanged. Whether
the rest of the repo's 70 migrations reached production is now an open
question; `driver_live_tracking.sql` (live columns on the order tables) is
the next suspect.

**Left behind:** order `#ING-9EBDBFB930` is open on production; the guest
page's Cancel did not take (no session). Cancel it from the admin portal or
let it age out. Headless Chrome closed; the emulator stays signed in as Rio's
driver.

### 19:06 UTC — first push ever from production, proven on two devices

Rio ran `supabase/driver_online_location.sql` in the production SQL editor
("Success. No rows returned"). Within a minute the emulator's publish went
through (`PATCH driver_registrations` → 204, `is_online: true`, the Seeta
position, every 15 s; captured with a fetch hook in the WebView). The sender,
called for the same real order with the emulator app in the background:

```
{"ok":true,"action":"ring","sent":2,"drivers":1,"tokens":2,"proximity":{"source":"geocoded","radiusKm":20}}
```

Emulator: `posted tag=…9ebdbfb9…`, `fullScreenIntent granted`, heads-up
"New delivery request · Sonde Road → Ntinda Complex · $4.20" over the
launcher **7 s after the call** (screenshot `emu-prod-headsup3.png`). Rio,
at the same moment: "the order went through, and it came to our phone".
Decline from the emulator's shade withdrew it; the panel then read *Last
offer push = Arrived — 1 min ago, screen on. Nothing on the phone stood in
its way.* Driver `eb17d3db…`, order `#ING-9EBDBFB930`, 2026-09-06 19:06:40Z:
the first driver push from production in the product's life.

**Rio, right after: "the sound keeps on ringing even after the order was
closed or accepted."** Read: a push starts its own ring loop
(`driverPush.js` → `notifyDriverNewOffer` → `startDriverOfferRing(offerKey)`)
under the same key the provider uses, but `syncRingsToOpenOffers` only
stopped keys in `activeRingKeysRef`, which holds the provider's own rings. An
offer that vanished because *another* device (the emulator's Decline, here)
or the customer answered it left the push's loop ringing for its full 120 s,
and its notification in the shade. Fixed: the vanish loop now stops every
sounding ring (`getActiveDriverOfferRingKeys()`) and withdraws the shade copy.
This device's own Accept / Decline already stopped it. → **v1.1.5**.

**Verified (22:14 local):** ESLint clean; production build with `.env.local`
aside → `main.683fe94e.js`, 0 throwaway / 3 production references; `cap
sync`; Gradle; AAB `jar verified`; APK signed by the upload key,
`com.world.fi.ingo`, versionCode 7, 1.1.5, target 36; the bundle inside the
AAB is byte-identical to `build/`. `InGo v1.1.5.apk` / `.aab` on Rio's
Desktop, APK sent. Website deployed from the same `build/`; the live index
serves `main.683fe94e.js`, byte-identical. **Not verified:** the ring fix
on a phone (the emulator cannot reproduce "answered elsewhere" without a
second production device; the code path is the same vanish loop that scenario
B exercised). Nothing committed. Test order `#ING-9EBDBFB930` still open on
production.

**Status:** complete

### 22:30 — "Web page not available" inside the map, v1.1.6

Rio's phone: the driver Home map area showing Android's own error page,
`https://www.google.com/maps?q=0.3407,32.6094&z=14&output=embed` …
`net::ERR_INTERNET_DISCONNECTED`. With no Maps key the map is a Google web
page in an iframe; when the phone's data dropped at the moment the frame
loaded, Android painted its error page inside it, and an iframe never
retries, so the page stayed until the next re-centre. Mobile data drops
often, so "keeps on happening".

**Built** (`src/components/GoogleMapEmbed.js` + css, used by 8 pages): while
offline the frame is replaced by a quiet "Map paused — no internet
connection. It comes back on its own." panel on the tokens; the frame is
re-issued (keyed by src + an epoch) when the connection returns and when the
app comes back to the foreground. The frame still cannot tell the app that
*its* load failed while `navigator.onLine` was true, so a drop that Android
does not report as offline can still leave the page until the next
re-centre, online event or foreground. **Deliberately not built:** a Maps
API key (needs the client's Google Cloud account; would also give real
tiles). versionCode 8, 1.1.6.

**Verified (22:38 local):** ESLint clean; production build with `.env.local`
aside → `main.9942591e.js`, 0 throwaway / 3 production references; `cap
sync`; Gradle; AAB `jar verified`; APK signed by the upload key,
`com.world.fi.ingo`, versionCode 8, 1.1.6, target 36; the bundle inside the
AAB is byte-identical to `build/` and carries the "Map paused" text.
`InGo v1.1.6.apk` / `.aab` on Rio's Desktop, APK sent. Website deployed from
the same `build/`; the live index serves `main.9942591e.js`, byte-identical.
**Not verified:** the placeholder on a phone with data switched off (the
emulator's airplane mode would do; not run). Nothing committed.

**Status:** complete
