# InGo — system map

What this product is made of, which service does which job, and where every
identity and secret lives. Written 2026-09-06 because in two days two people
asked "are we on Firebase or Supabase?", and because the answer decides whether
an app update keeps 468 users' data or loses it.

Every statement is marked:

- **verified** — someone ran it or fetched it and saw the result.
- **read** — taken from code or config in this repo, not executed.
- **unknown** — nobody has looked yet. Do not guess; the section at the end
  says how to find out.

---

## 1. In one paragraph

InGo is a React web application (Create React App, no TypeScript) with **no
server of its own**. The same build runs in three places: as a website hosted
on Firebase, as an Android app that wraps the website in a WebView (Capacitor),
and as an admin portal under `/admin`. The browser or WebView talks **directly
to a Supabase Postgres database** with a public key. A handful of Supabase Edge
Functions do the things that need a secret: payment callbacks, password reset,
and sending push notifications. **Firebase is used for two things only:
hosting the website and delivering push notifications.** A small Node service
on Railway starts Paynow and EcoCash payments.

## 2. Services, and what each one does

| Service | Identity | Job | Status |
|---|---|---|---|
| **Supabase** | project `iaorixerxnqedwgkqxtz` (production), named "rodneykiggundu@gmail.com's Project", org `lkyskxlueaozftafcewn`. **Owned by `rodneykiggundu@gmail.com`**, the same account as Firebase; the `it@ingo.co.zw` account holds only the test project (verified 2026-09-06 via `supabase projects list` under both logins) | **The database.** Every user, order, wallet, driver location, chat message. Also file storage (the brand logo is served from its storage bucket) and realtime subscriptions | **verified** 2026-09-06: the website Firebase hosts references this project 13 times in its bundle; `src/lib/supabaseClient.js` hardcodes it |
| **Supabase Edge Functions** | same project, 12 functions in `supabase/functions/` | `driver-offer-push` (send push), `paynow-initiate`, `paynow-result`, `ecocash-payment`, `ecocash-notify`, `stripe-payment`, `password-reset`, `customer-email-verify`, `places-autocomplete`, `places-geocode`, `shop-order-placed-notify`, `shop-order-picked-up-notify` | **verified** 2026-09-06 with `supabase functions list`: production runs 13, all ACTIVE — the 12 here plus `shop-order-status-notify`, which is not in this repo. `driver-offer-push` is v22, deployed from this repo 2026-09-06 15:08 UTC and byte-identical to it (v14 at 13:46 made it boot; v18–v22 ring all fresh online drivers when nobody is within 20 km, use a 30 min freshness window, keep online drivers with no fix yet, and ignore `push_when_closed`), `verify_jwt=false`; a no-op `stop` through it reached 2 registered phones; the other 12 have `verify_jwt=true` and were last deployed between 2026-05-13 and 2026-08-26 by someone else |
| **Firebase** | project `ingo-92d5f` | (a) **Hosting** the website at `https://ingo-92d5f.web.app`; (b) **Cloud Messaging** (FCM) to deliver push to phones. Used in three source files. No Firestore, no Realtime Database, no Firebase Auth | hosting **verified** 2026-09-06; FCM **verified** 2026-09-03 on an emulator |
| **Railway** | `bykea-production.up.railway.app`, source in `server/` | Starts Paynow and EcoCash payments (the edge functions could not reach Paynow) | read. Local builds point at this production URL too |
| **Stripe** | live publishable key in `.env.production` | Card payments via `stripe-payment` | read |
| **Paynow / EcoCash** | `paynow.co.zw`, `payonline.ecocash.co.zw` | Zimbabwe mobile money | read |
| **Google Play** | `com.world.fi.ingo` — Production, 468 installs, one bundle ever, uploaded 2026-05-20, targets API 35. `zw.co.ingo` — unpublished, 8 installs | The store identity of the Android app | **verified** from Play Console 2026-09-05 |
| **GitHub** | `KIGATTA-INVESTMENTS/bykea` (the client's, upstream); `RealAkram20/bykea` (fork, where work happens); `RealAkram20/Ingo-app` (a public mirror of the same code) | Source | verified |

## 3. "Are we on Firebase or Supabase?"

**Both, for different jobs, and it is not a choice anyone here made.** The
original developer built it this way (13 of the repository's first 14 commits
are theirs).

- **Supabase is the database.** `supabase-js` is imported in over a hundred
  files. Seventy SQL migrations in `supabase/` define the tables.
- **Firebase is push and hosting.** The `firebase` package is imported in
  exactly three files: `src/lib/firebase.js`, `src/lib/driverPush.js`,
  `public/firebase-messaging-sw.js`. There is no Firestore and no Realtime
  Database anywhere in the code.
- **The website Firebase hosts is this code talking to Supabase** (verified
  2026-09-06: `https://ingo-92d5f.web.app` serves `main.bb832a68.js`, 2.2 MB,
  containing the production Supabase URL 13 times and the same admin password
  this repo contains; the two occurrences of the word "firestore" are inside
  the Firebase SDK, not app code).

What that means in practice:

- Removing Firebase deletes push notifications and the website's hosting. It
  changes nothing about where the data is.
- Removing Supabase deletes the product.
- A "move to Postgres" is already done: Supabase *is* Postgres.

**What is still unknown: the app on the phones.** The APK on Google Play
(`com.world.fi.ingo`, version 1) was not built from this repository, and
nobody here has opened it. It is *probably* the same website in a WebView,
because that is what Capacitor produces and the Play listing was published a
day after the hosted site's build, but *probably* is not good enough before
updating 468 installs. §9 says how to find out in five minutes.

## 4. Where the web app is hosted

`https://ingo-92d5f.web.app` and `https://ingo-92d5f.firebaseapp.com` (Firebase
Hosting, project `ingo-92d5f`; site owner account `rodneykiggundu@gmail.com`).
Deployed from this repo with `firebase deploy --only hosting` after a verified
production `npm run build` — not `npm run deploy:hosting`, whose rebuild would
read `.env.local`. **On Node 24 the Firebase CLI cannot log in** (its HTTP
library fails on Google's token endpoint); run it under Node 20, see
`docs/release-android.md` §7b. Last deployed 2026-09-06 22:38 from the uncommitted working tree of this
repo (`main.9942591e.js`, byte-identical to the bundle inside `InGo v1.1.6`). Whether a custom domain is attached is **unknown**.

## 5. The Android app

- **Built from this repository** since 2026-09-05: `npm run build` → `npx cap
  sync android` → Gradle. Step by step in `docs/release-android.md`.
- **Package identity on Play:** `com.world.fi.ingo`. Set as `applicationId` in
  `android/app/build.gradle`. The Java package and Gradle `namespace` stay
  `com.kigatta.ingo`; that is allowed and changes nothing for users.
- **Firebase registration:** `ingo-92d5f` has Android apps for both
  `com.kigatta.ingo` (the test package) and **`com.world.fi.ingo`** (registered
  2026-09-06 00:40), plus an Apple app `com.kigatta.ingo` and a web app.
  `android/app/google-services.json` carries both Android clients. Before that
  night the live package was not registered, so the store app could never
  receive push from this project.
- **Signing:** Play App Signing is on (the app was created after August 2021).
  An upload key was generated on 2026-09-05 (`android/ingo-upload.jks`, SHA-1
  `76:1B:9D:40:3C:FF:D4:01:06:73:EE:05:41:6D:22:8A:6F:5E:4B:D8`). Whether it
  matches the upload certificate registered in Play Console is **unknown**;
  the first upload tells you, and a mismatch is fixed with an upload key reset.
- **iOS:** no `ios/` project in this repository. Where the iOS app came from is
  **unknown**.

## 6. Authentication

Hand-rolled. `supabase.auth` is called zero times. Sessions are kept in the
browser's storage by `customerSession.js`, `driverSession.js`, and
`adminAuth.js`, over an `app_users` table whose password column is plaintext.
The admin portal password is hardcoded in `src/lib/adminAuth.js`. Both are
known, reported findings; do not build on them and do not add more.

## 7. The four portals

| Portal | Routes | Who |
|---|---|---|
| Customer | `/`, `/home`, `/live-tracking`, … | people ordering deliveries, taxis, shop goods |
| Driver | `/driver/*` | drivers; offers, active delivery chain, wallet |
| Shop owner | `/shop-owner/*` | shops selling through the app |
| Admin | `/admin/*` | KIGATTA staff |

All four ship in one bundle to every user; there is no code splitting to speak
of.

## 8. Identities and where each secret lives

| Thing | Where it is | Secret? |
|---|---|---|
| Supabase production URL and anon key | hardcoded in `src/lib/supabaseClient.js`, and in every built bundle | public by design (it is the browser key); the danger is the table permissions, not the key |
| Supabase `service_role` key | Supabase dashboard only; injected into edge functions automatically | **yes, never in the repo** |
| Firebase service-account JSON | `.secrets/fcm-service-account.json` (gitignored); set as the `FIREBASE_SERVICE_ACCOUNT_JSON` secret on `driver-offer-push` | **yes** |
| Firebase web push VAPID key | `.env.production` | public (browser key) |
| Stripe publishable key | `.env.production` | public; the Stripe *secret* is a Supabase function secret |
| Paynow / EcoCash keys | Railway environment | **yes** |
| Admin portal password | `src/lib/adminAuth.js` | should be secret; is not (known finding) |
| Android upload keystore and passwords | `android/ingo-upload.jks`, `android/keystore.properties` (both gitignored) | **yes** |
| `google-services.json` | `android/app/` (gitignored) | not secret, but project-specific |
| Google Maps key | `REACT_APP_GOOGLE_MAPS_API_KEY`, unset everywhere as of 2026-09-06 | public (browser key, restrict by referrer) |

## 9. The store APK: how to find out what it talks to

Play Console → Release → **App bundle explorer** → version 1 → **Downloads** →
"Signed, universal APK". Then, on any machine:

```bash
mkdir apk && cd apk && unzip -q ../ingo-store.apk
grep -rl iaorixerxnqedwgkqxtz . | head          # Supabase production URL
grep -rl "ingo-92d5f.web.app" . | head          # a WebView pointing at the hosted site
grep -rl -i firestore . | head                  # Firestore usage (expect only SDK strings, if any)
ls assets/public 2>/dev/null | head             # Capacitor's web bundle, if it is a Capacitor app
```

| What you find | What it means for the update |
|---|---|
| `assets/public/` with `index.html` and the Supabase URL | Same shape as this repo. Update is safe; users keep their data |
| A WebView loading `ingo-92d5f.web.app` | A thin wrapper of the hosted site. Update is safe; the new app bundles the site instead of loading it |
| Firestore or another database URL and no Supabase | A different product. **Stop.** An update would cut users off from their data |

## 10. Environments

There is **one** environment: production. `npm start` on a developer machine
talks to the production database and production payment endpoints.

For testing there is a throwaway Supabase project, `gcwrnluyaqarmrovbryj`,
created from `supabase/bundle/all-in-order.sql`, with a seeded test driver
(`testdriver@bykea.test`). A local `.env.local` points a build at it. **That
file also affects `npm run build`**, so it must be renamed away before any
release build; `docs/release-android.md` has the guard.

## 11. How a build reaches users

| Target | Command | Then |
|---|---|---|
| Website | `npm run deploy:hosting` | live at `ingo-92d5f.web.app` immediately |
| Android | `docs/release-android.md` | Play Console upload, internal testing, production |
| Edge function | `npx supabase functions deploy <name> --project-ref iaorixerxnqedwgkqxtz` | live immediately; secrets set separately |

## 12. Before you change anything

1. **Know which project a build points at.** `grep -c gcwrnluyaqarmrovbryj
   build/static/js/main.*.js` must print `0` for anything that reaches a user.
2. **Never test a payment locally.** Even local builds call the production
   Railway API. Use cash-on-delivery in tests.
3. **Do not remove Firebase believing it is the database.** Do not remove
   Supabase believing it is a cache.
4. **Two package names exist on Play.** Only `com.world.fi.ingo` has users.
5. **Read `AGENTS.md`, then `docs/worklog.md`** before touching push, offers
   or driver sessions. Read `docs/release-android.md` before any release.
6. **Anything you learn that is not in this file belongs in this file.**

## 13. Known unknowns

- What the APK on Play actually contains (§9).
- ~~Whether `driver-offer-push` is deployed on production~~ **Resolved
  2026-09-06 13:46 UTC:** redeployed from this repo (v14) and it boots; before
  that every call returned 503 `BOOT_ERROR` and push had never worked from
  production. All 13 deployed functions and the 23 secret names are now listed
  in §2. Whether a real order rings a real phone is the next check.
- Who owns production Supabase: **resolved**, `rodneykiggundu@gmail.com` (§2).
  Whether that person is KIGATTA staff or the original developer is not.
- **Which of the repo's migrations production actually has.** Found
  2026-09-06 18:45 UTC by ringing the sender for a real order:
  `driver_registrations.driver_live_lat does not exist`, so
  `supabase/driver_online_location.sql` had never been run there, every real
  ring had failed with 500, and no driver had ever received a push from
  production. **That one file was run at ~19:00 UTC; the next ring reached
  two phones (19:06 UTC).** The other 69 are still unaudited; start with
  `driver_live_tracking.sql`.
- Whether a custom domain points at the hosted site.
- Where the iOS app was built and what it talks to.
- Whether the upload key generated here matches the one Play expects.
- Commercial terms and who at KIGATTA signs off a release.
