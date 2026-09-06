# InGo — the deployment runbook

The order in which a release goes out, the check that gates each step, and
the way back if a step goes wrong. Three things deploy: the **website**
(Firebase Hosting), the **Android app** (Google Play), and the **push sender**
(a Supabase Edge Function). They share one database, so the order matters
only for push, and there the rule is **app before sender**.

Written 2026-09-06 from the first release prepared in this repository.
`docs/release-android.md` has the Android detail; `docs/system-map.md` says
what each service is. This file is the order.

---

## 0. Preconditions, once per machine and per person

| Need | Where it lives | Check |
|---|---|---|
| Firebase account that owns site `ingo-92d5f` | `rodneykiggundu@gmail.com` | `firebase login:list` (under Node 20, see §3) |
| Play Console access to `com.world.fi.ingo` | KIGATTA's developer account | the app appears in the console |
| Supabase account in the organisation that holds `iaorixerxnqedwgkqxtz` | `rodneykiggundu@gmail.com` (org `lkyskxlueaozftafcewn`, found 2026-09-06). A personal access token from that account, passed as `SUPABASE_ACCESS_TOKEN`, is enough; the `it@ingo.co.zw` login holds only the test project | `npx supabase projects list` shows the production ref |
| Upload keystore + passwords | `android/ingo-upload.jks`, `android/keystore.properties`, and a password manager | `git status` shows neither |
| `google-services.json` with both Android clients | `android/app/` | lists `com.world.fi.ingo` |
| Firebase service-account key | `.secrets/fcm-service-account.json` | `node scripts/send-test-offer.js` does not say `invalid_grant` |
| Production schema carries the repo's migrations | `supabase/*.sql`; production was found missing `driver_online_location.sql` on 2026-09-06 | ring the sender for a **real** open order and read its JSON: `sent` and no `error` about a missing column. A zero-uuid probe proves nothing here |
| JDK and Android SDK | Android Studio's JBR at `JAVA_HOME`, SDK at `ANDROID_HOME` | `cd android && ./gradlew help` |
| Node 20 for the Firebase CLI | fetched by npm on demand | `npx -p node@20 -- node --version` |

If any row fails, fix it before step 1. Nothing below works around a missing
precondition.

## 1. Freeze

1. Everything for the release is committed on `master`. `git status` is clean
   apart from the gitignored secrets.
2. Raise `versionCode` by one and set `versionName` to the next patch
   (1.1.0 → 1.1.1 → 1.1.2, every update) in `android/app/build.gradle`.
   `versionCode` must exceed the highest one Play has ever seen for this
   package, including rejected uploads.
3. Tag: `git tag android-v<versionName>`.

## 2. Build

4. **Environment.** `.env.local` must not exist (rename it). `.env.production`
   has what the release should ship (`REACT_APP_GOOGLE_MAPS_API_KEY`,
   `REACT_APP_ADDRESS_COUNTRY`).
5. **Web bundle.**
   ```bash
   npm run build
   grep -c gcwrnluyaqarmrovbryj build/static/js/main.*.js   # 0, or stop
   grep -c iaorixerxnqedwgkqxtz build/static/js/main.*.js   # > 0
   ```
6. **Android bundle and APK.**
   ```bash
   npx cap sync android
   cd android && ./gradlew bundleRelease assembleRelease
   "$JAVA_HOME/bin/jarsigner" -verify app/build/outputs/bundle/release/app-release.aab | tail -1   # jar verified.
   grep -o -E 'android:(versionCode|targetSdkVersion)="[^"]+"|package="[^"]+"' \
     app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml
   ```
   Expect `package="com.world.fi.ingo"`, the versionCode from step 2, target 36.
   The same `build/` feeds the website in step 9. Do not rebuild in between.
   Copy the outputs as `InGo v<versionName>.aab` and `InGo v<versionName>.apk`;
   that is the only name a build leaves this repo under.

## 3. Verify before anything is live

7. **Device run on the release-signed APK against the test project.** Build a
   second APK with `.env.local` pointing at `gcwrnluyaqarmrovbryj`, install it
   on the emulator or a phone, and walk `docs/push-local-testing.md` Part 3:
   sign in, ring (`OFFER_KEY=… node scripts/send-test-offer.js <token>`),
   Accept from the notification, screen-off ring, kill and reopen on the
   active delivery. Then rebuild with `.env.local` renamed away, or the
   Capacitor assets under `android/` still point at the test project.
8. **First update only:** inspect the APK currently on Play
   (`docs/system-map.md` §9). Confirm it talks to the same database. If it
   does not, stop and decide; an update would strand 468 users.

## 4. Deploy, in this order

9. **Website.** From the same `build/` as step 5:
   ```bash
   npx -p node@20 -- node node_modules/firebase-tools/lib/bin/firebase.js deploy --only hosting --project ingo-92d5f
   ```
   Verify: `curl -s https://ingo-92d5f.web.app/ | grep -o 'main\.[a-z0-9]*\.js'`
   matches `build/static/js/`. **Back:** Firebase console → Hosting → Release
   history → Rollback. Seconds.
10. **Android, internal testing.** Play Console → Testing → Internal testing →
    Create new release → upload the `.aab` → Start rollout. Add your Google
    account under Testers, install from the opt-in link, and repeat the
    device run from step 7 against production with a real driver account:
    sign in, one real order from the website, Accept, active delivery.
11. **Play declarations.** App content → Data safety (location is collected,
    for app functionality). Answer the full-screen-intent question if it
    appears. Target API 36 clears the policy block.
12. **Android, production.** Release → Production → Create new release → Add
    from library → the same bundle → staged rollout **20%** → Review → Start.
    Watch for a day: Play Console → Quality → Android vitals (the app has no
    crash reporting of its own, so this is the only signal). Then 100%.
    **Back:** halt the rollout in the console. A versionCode cannot be rolled
    back; a fix is a new, higher versionCode through steps 2–12.
13. **Push sender, after drivers have the new app.**
    ```bash
    PUBLIC_APP_URL=https://ingo-92d5f.web.app ./scripts/deploy-push-sender.sh iaorixerxnqedwgkqxtz
    ```
    Verify with the smoke test the script prints: a JSON body, not a 503 or a
    401. Then one real order from the website must ring one real driver on
    the new app. **Back:** `git checkout <previous tag> -- supabase/functions/driver-offer-push`
    and deploy again. Why this order: the sender is data-only and the app
    draws the notification; the new sender with the old app is silent on a
    killed phone.

## 5. After

14. **Rotate anything that passed through chat or email:** the Firebase
    service-account key, any Supabase access token. Generate the new key, put
    it in `.secrets/`, and re-run step 13's script so the function has it.
15. **Record.** `docs/worklog.md` gets the release entry with what was verified
    and what was not. If any service, id or account changed,
    `docs/system-map.md` changes with it.
16. **Rename `.env.local` back** for the next test session.

## Where the first release stands (2026-09-06)

| Step | State |
|---|---|
| 1–6 | 2–6 done for **v1.1.6 (versionCode 8)**: `InGo v1.1.6.aab` and `InGo v1.1.6.apk` on Rio's Desktop, built 22:35 (everything in v1.1.5 plus: the map frame shows "Map paused" while offline and reloads itself when the connection returns). v1.1.0–v1.1.5 were never uploaded; do not upload them. Step 1 (commit and tag) is not done |
| 7 | done on the emulator, every path, on `com.kigatta.ingo` |
| 8 | **open** — the version-1 APK has not been inspected |
| 9 | **done 22:38** — `main.9942591e.js` live, byte-identical to the bundle inside `InGo v1.1.6.apk` / `.aab` (earlier today: 01:45, 04:00, 17:05, 17:58, 19:12, 21:33, 22:14; each deploy matched the APK of its hour) |
| 10–12 | **open** — the upload itself also answers whether the upload key matches |
| 13 | **done, proven 19:06 UTC** — `driver-offer-push` v22 on production with the three secrets. A real order at 18:45 UTC first answered `column driver_registrations.driver_live_lat does not exist` (production never had `supabase/driver_online_location.sql`); Rio ran that file in the production SQL editor at ~19:00 UTC, and the next ring for the same order answered `sent 2, drivers 1, proximity geocoded` and popped on the emulator (app in background) and on Rio's phone: the first driver push from production ever. The repo's sender additionally degrades to "everyone online" when those columns are missing and names the migration (needs a deploy token to reach production). The later deploys add: ring all fresh online drivers when nobody is within 20 km (the sender is never stricter than the app), 30 min freshness instead of 5, online drivers with no fix yet are kept (null timestamp, null coordinates), and `push_when_closed` no longer blocks push. **The repo is one step ahead of v22:** a per-token try/catch with a `failed` count (a DNS blip to FCM used to answer 500 with nobody rung); deploy it with the next token. Done before steps 10–12 on purpose: old-app phones got nothing before, a banner is better than silence. The production project is owned by `rodneykiggundu@gmail.com` (same account as Firebase); `it@ingo.co.zw` never held it |
| 14 | owed for the Firebase key supplied on 2026-09-05 and the Supabase token supplied on 2026-09-06 |
