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
