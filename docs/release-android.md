# Releasing the Android app to Google Play

The Android app on Google Play is built **from this repository**: `npm run build`
→ Capacitor → Gradle → an `.aab` uploaded through Play Console. Written
2026-09-05 for the first upload from here (`versionName 1.1.0`). Read it top to
bottom the first time; after that the checklist at the end is enough.

The order across website, app and push sender is `docs/deployment.md`; this
file is the Android detail. Everything below was run on Windows from Git Bash. In PowerShell use
`.\gradlew.bat` instead of `./gradlew`.

---

## 0. Three answers from Play Console before anything is built

Open Play Console → the InGo app.

1. **Package name.** Shown under the app name on the dashboard and in
   *Setup → App integrity*. It must equal `applicationId` in
   `android/app/build.gradle`, which is **`com.world.fi.ingo`** (the Play
   listing with users; set 2026-09-06). The Gradle `namespace` and the Java
   package stay `com.kigatta.ingo`, which is fine. If the listing ever shows a
   different package, stop: the bundle would be a *new app* and users would
   have to install a second one.
2. **Current versionCode.** *Release → Production → the latest release → App
   bundles.* `versionCode` in `android/app/build.gradle` must be higher, or
   the upload is refused. It is `2` today, on the assumption nothing above `1`
   was ever uploaded; raise it if the console says otherwise.
3. **Who holds the upload key.** *Setup → App integrity → App signing.*
   - **"Play App Signing" enabled** (default for any app created after
     August 2021): the page shows an *Upload key certificate* SHA-1. The
     keystore used below must produce that SHA-1. If nobody has that keystore,
     use *Request upload key reset* on the same page; Google verifies and
     accepts a new certificate in about two working days. Nothing is lost.
   - **Play App Signing not enabled:** the original keystore the store app was
     signed with is the only key that can update it. There is no reset. If it
     is gone, the only route is a new listing.
   - **No app on Play yet:** skip this; the first upload enrols the app in
     Play App Signing and whatever key signs it becomes the upload key.

## 1. The upload key

If a keystore already exists, use it. If not, generate one once and never
again:

```bash
cd android
"$JAVA_HOME/bin/keytool" -genkeypair -v -keystore ingo-upload.jks -alias ingo-upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

Put `ingo-upload.jks` and both passwords in a password manager **before** the
next step. A lost upload key with Play App Signing costs two days; a lost
signing key without it costs the listing.

Then create `android/keystore.properties` from
`android/keystore.properties.example`. Both the `.jks` and the `.properties`
are gitignored; confirm with `git status` that neither shows.

To read the SHA-1 back (to compare with Play Console):

```bash
"$JAVA_HOME/bin/keytool" -list -v -keystore android/ingo-upload.jks -alias ingo-upload | grep SHA1
```

## 2. Environment for a store build

- **`.env.local` must not exist while you build.** It points the app at the
  throwaway Supabase project used for push testing, and CRA reads it for
  `npm run build` too, *above* `.env.production`. Rename it:
  `mv .env.local .env.local.throwaway`. Rename it back afterwards.
- `.env.production` is what the store build reads. Add
  `REACT_APP_GOOGLE_MAPS_API_KEY=` with a Maps JavaScript key if you have one;
  inside the Android WebView the page origin is `https://localhost`, so a key
  restricted by HTTP referrer needs `https://localhost/*` allowed. Without it
  map pages render degraded, as they do on the web today.
  `REACT_APP_ADDRESS_COUNTRY` defaults to `zw`; set it only for another market.
- `android/app/google-services.json` must come from Firebase project
  **`ingo-92d5f`** and list the `com.world.fi.ingo` client (Firebase console →
  Project settings → Your apps → download). It is gitignored. The release build
  fails loudly if it is missing; a debug build only warns.

## 3. Build

```bash
cd "d:/xampp/htdocs/ingo app"
npm run build
grep -c gcwrnluyaqarmrovbryj build/static/js/main.*.js     # must print 0
grep -c iaorixerxnqedwgkqxtz build/static/js/main.*.js     # must be > 0
npx cap sync android
cd android && ./gradlew bundleRelease assembleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab` (for Play) and
`android/app/build/outputs/apk/release/app-release.apk` (for a phone by hand).

**Name what leaves this repo `InGo v<versionName>`** — `InGo v1.1.0.aab` and
`InGo v1.1.0.apk` for this release, `InGo v1.1.1` for the next, and so on
(Rio, 2026-09-06). Copy, never rename in place, so the Gradle output stays
where `jarsigner` and the steps below expect it:

```bash
cp app/build/outputs/bundle/release/app-release.aab "<destination>/InGo v1.1.0.aab"
cp app/build/outputs/apk/release/app-release.apk   "<destination>/InGo v1.1.0.apk"
```

Prove it is signed with the key from step 1 (an unsigned bundle builds fine and
is refused at upload):

```bash
"$JAVA_HOME/bin/jarsigner" -verify -verbose -certs app/build/outputs/bundle/release/app-release.aab | tail -3
```

Expect `jar verified.` If `android/keystore.properties` was missing, Gradle
printed `release artefacts will be UNSIGNED` and this prints `jar is unsigned`.

The two `grep` lines are the guard against step 2: an app whose every user
signs in against an empty test database looks perfectly healthy in the build
log. The production count is `3` on a clean build and `15` on one made with
the variable set in the shell; the extra copies are whole-object `process.env`
inlining, not extra uses. `0` and `> 0` are the rule; `15` is not a target.

## 4. Upload to Internal testing first

Nothing built from this repo has yet been run on a real handset. Internal
testing installs the exact store build on your own phone through Play, with no
review, in minutes. Do this before Production, every time.

Play Console → *Testing → Internal testing → Create new release* → upload the
`.aab` → release notes → *Next → Save → Review release → Start rollout to
Internal testing*. On the *Testers* tab add an email list with your Google
account, then open the *opt-in link* on the phone and install from Play.

The device run this build owes:

1. Driver sign-in. The location prompt appears and the driver shows online.
2. From a browser, place a customer order. The phone posts the offer
   notification with **Accept** and **Decline**.
3. Kill the app, lock the phone, place another order. The screen wakes with
   the offer; Accept from there; the order goes `assigned` and the app lands on
   the active delivery.
4. On `/driver/active-delivery/<key>`, kill the app and reopen it from the
   notification or recents. The job comes back from the route key instead of
   a blank or a fixture.
5. `adb logcat -s IngoOfferPush` on a ring shows `fullScreenIntent granted` or
   `NOT granted`. See §5.
   (With adb, the activity is `com.world.fi.ingo/com.kigatta.ingo.MainActivity`:
   the Play package and the Java package differ, so `.MainActivity` alone does
   not resolve.)
6. A map page renders tiles if a Maps key was set.

## 5. Play Console declarations this build needs

Under *App content*, Play checks the manifest and asks about anything new:

- **Data safety.** This build declares `ACCESS_FINE_LOCATION` and
  `ACCESS_COARSE_LOCATION`, which the store app may not have declared. Location
  is *collected*, *required for app functionality*, not shared, driver side.
  Background location is **not** used (no foreground service; that is a
  separate piece of work), so no video demonstration is required.
- **Full-screen intent.** `USE_FULL_SCREEN_INTENT` is declared for the offer
  screen over a locked phone. On Android 14+ Play grants it automatically only
  to calling and alarm apps; for everyone else it is a special app access the
  user switches on under *Settings → Apps → Special app access → Full screen
  notifications*. If Play shows a declaration form for it, answer honestly:
  time-sensitive dispatch offers. Without the grant the app still works and the
  offer falls back to the ordinary heads-up banner; the service logs which
  state it is in on every ring.
- **Notifications** (`POST_NOTIFICATIONS`) needs no declaration.
- **Target API level** is 36, which satisfies Play's 2026 requirement.

## 6. Promote to Production

*Release → Production → Create new release → Add from library* → pick the same
bundle → *staged rollout* at 20% → *Review → Start rollout*. Watch for a day,
then raise to 100%. Review on an existing app usually takes hours, sometimes
days; a first upload from a new key or with new permissions takes longer.

## 7. After the app is out: the push sender

Roll out **the app first, the sender second** (see `AGENTS.md`). The Android
leg of the offer message is data-only and the app draws the notification
itself; the new sender with the old app is silent on a killed phone, while the
old sender with the new app still shows a plain banner.

Once the store build is on drivers' phones, deploy
`supabase/functions/driver-offer-push` to the production Supabase project:

```bash
npx supabase login
npx supabase functions deploy driver-offer-push --project-ref iaorixerxnqedwgkqxtz
```

`supabase/config.toml` already sets `verify_jwt = false` for it. Secrets it
reads (Supabase dashboard → Edge Functions → Secrets, each on ONE line):
`FIREBASE_SERVICE_ACCOUNT_JSON` (a service-account key from `ingo-92d5f`),
`FIREBASE_PROJECT_ID=ingo-92d5f`, `PUBLIC_APP_URL`, and optionally
`GOOGLE_MAPS_API_KEY` for the 20 km radius filter. The traps hit on the first
deploy are in `docs/push-local-testing.md`.

**Checked 2026-09-06:** the function *is* deployed on production and answers
every call with HTTP 503 `BOOT_ERROR` ("Function failed to start"). So today
every order placed on the live site calls a sender that crashes, and no driver
has ever been rung from production. Redeploying from this repo (the boot trap
is fixed here) with the secrets above is what turns push on. The web-push click
link needs `PUBLIC_APP_URL=https://ingo-92d5f.web.app`; the helper passes it
through when set:

```bash
PUBLIC_APP_URL=https://ingo-92d5f.web.app ./scripts/deploy-push-sender.sh iaorixerxnqedwgkqxtz
```

The script needs a `supabase login` (or `SUPABASE_ACCESS_TOKEN`) belonging to
the organisation that owns `iaorixerxnqedwgkqxtz`. **On 2026-09-06 no login on
Rio's machine could see that project**; the stored one sees only the throwaway.
A personal access token from an account that can open the production project
in the dashboard (Account → Access Tokens) is the quickest way in:
`SUPABASE_ACCESS_TOKEN=<token> PUBLIC_APP_URL=… ./scripts/deploy-push-sender.sh iaorixerxnqedwgkqxtz`.

## 7c. The sender without the CLI (dashboard editor)

When nobody can run the script, whoever can open the production project in
the Supabase dashboard can deploy it there. The function is one file with
native imports and no shared modules, so it pastes as-is.

1. Dashboard → Edge Functions → **Deploy a new function → Via Editor**. Name
   it exactly `driver-offer-push`. Paste the whole of
   `supabase/functions/driver-offer-push/index.ts`. Deploy.
2. Open the function → Details → turn **Enforce JWT verification off**. The
   site calls it with the publishable key, which is not a JWT.
3. Edge Functions → **Secrets** → add, each value on one line:
   `FIREBASE_PROJECT_ID` = `ingo-92d5f`; `PUBLIC_APP_URL` =
   `https://ingo-92d5f.web.app`; `FIREBASE_SERVICE_ACCOUNT_JSON` = the key
   compacted to one line. A pretty-printed key becomes the secret `{`. Print it
   compacted with:

   ```bash
   node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8'))))" < .secrets/fcm-service-account.json
   ```

4. Smoke test from any shell: the curl in §7 with a zero uuid must return a
   JSON body such as `{"sent":0,"reason":"not_found"}`, not `503 BOOT_ERROR`.
5. Place one real order from the website with a driver signed in, online and
   located within the last 5 minutes. The phone rings.

## 7b. The website

The site at `https://ingo-92d5f.web.app` is the same build. Deploy it with the
production `build/` you just verified — **not** with `npm run deploy:hosting`,
whose rebuild would read `.env.local` if it exists:

```bash
npx firebase login --no-localhost   # once per machine; paste the code Google shows
npx firebase deploy --only hosting
```

**On Node 24 the login fails** ("Premature close" from Google's token endpoint:
the CLI's `node-fetch@2` cannot read that response under Node 24, verified
2026-09-06). Run the CLI under Node 20 instead; npm supplies it without
installing anything:

```bash
npx -p node@20 -- node node_modules/firebase-tools/lib/bin/firebase.js login --no-localhost
npx -p node@20 -- node node_modules/firebase-tools/lib/bin/firebase.js deploy --only hosting
```

Firebase keeps every release; a bad one is undone from Hosting → Release
history → Rollback in the console, in seconds.

## 8. What this release ships that the audit flagged

Recorded so nobody thinks it was missed. These are the client's decisions:

- The Supabase anon key, the admin portal password and the live Stripe
  publishable key are inside the bundle in plain text. An `.aab` is a zip.
- Wallet top-up tables are writable with the anon key.
- There is no crash reporting, so a failure on a driver's phone is invisible.

## Every release, in order

1. Raise `versionCode` by one and set `versionName` to the next patch:
   1.1.0 → 1.1.1 → 1.1.2, every update however small (`android/app/build.gradle`).
2. `.env.local` absent. `.env.production` has the keys you want shipped.
3. `npm run build` → the two `grep`s → `npx cap sync android` →
   `./gradlew bundleRelease assembleRelease`.
4. `jarsigner -verify` says `jar verified.`
5. Copy the outputs as `InGo v<versionName>.aab` and `InGo v<versionName>.apk`.
   Nothing leaves this repo under any other name.
6. Internal testing → the device run in §4.
7. Production, staged rollout.
8. Sender deploy, if the sender changed.
9. Commit the version bump and tag it (`android-v1.1.0`).
