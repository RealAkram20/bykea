# AGENTS.md — working in this repository

Read this before your agent writes a line. It is self-contained: it assumes no
access to anyone's notes, machine or chat history.

**InGo** is KIGATTA INVESTMENTS' taxi, tuk-tuk, parcel delivery and shop-order
app. One React SPA serves four portals — customer, driver, shop owner, admin.

---

## 1. Three things that will bite you in the first hour

**1. `npm start` talks to the LIVE production system.** Production Supabase, a
Stripe `pk_live_` key and the Paynow production API are hardcoded as fallbacks
in source, including in `.env.development`. **There is no staging.** A test
registration creates a real user; a test order creates a real order; a test
payment is a real payment.

> Before any work that writes data, point the app at a throwaway Supabase
> project. The schema is checked in as a one-paste bundle:
> `supabase/bundle/all-in-order.sql`. Set `REACT_APP_SUPABASE_URL` and
> `REACT_APP_SUPABASE_ANON_KEY` in `.env.local` and confirm they are not
> production before you run anything.

**2. The repository already contains live credentials, and it is public.** The
admin password is hardcoded in `src/lib/adminAuth.js`; the Supabase anon key is
in source. This is a known, reported finding — **do not add more, and do not
treat the existing ones as permission to add more.** Never commit a
`service_role` key, a `sb_secret_` key or a Firebase service-account JSON.

**3. `android/` in this repo is NOT the shipped app.** It is a local Capacitor
spike used to test and measure. The Android and iOS apps on the stores are built
from a different source. **Anything you change under `android/` ships to nobody
unless it is re-applied where the store builds are produced.** See §5.

---

## 2. Running it

```bash
npm install
cp .env.example .env.local     # then fill it in — see the warning above
npm start                      # dev server
npm run build                  # production build; this must pass before you push
npm test                       # react-scripts test
```

- **CRA 5 + React 19**, JavaScript, no TypeScript.
- `react-scripts@5.0.1` is deprecated upstream. That is the source of nearly all
  `npm audit` noise: build-chain transitives, not runtime.
  **Do not run `npm audit fix --force`** — it breaks the build and fixes nothing
  that ships.
- **There is one test file for ~59k lines.** Assume no safety net. If you change
  behaviour, verify it by running the app, not by running the suite.
- `REACT_APP_GOOGLE_MAPS_API_KEY` is usually unset, so map pages render
  degraded. That is expected locally, not a bug you need to chase.

## 3. How the system is shaped

- **There is no backend tier.** The browser talks straight to Supabase with the
  public anon key. Auth is hand-rolled — `supabase.auth` is used zero times.
- **Supabase is the database, and it is Postgres.** Firebase here is only push
  notifications and hosting.
- **Server-side logic lives in Supabase Edge Functions** (`supabase/functions/`),
  deployed separately from the app.
- Anything that must be trustworthy (stock, money, claiming a job) cannot be made
  correct from the client. Put it in an edge function or an RPC, not in the SPA.

## 4. Rules for agents in this repo

1. **Read `docs/worklog.md` first**, especially before touching push, offers or
   driver session. It is the append-only record of what was built, what was
   verified, and what deliberately was not.
2. **Add your worklog entry before your first edit**, listing the files you own
   and the shared files you must touch. An entry written afterwards is a
   collision report, not a plan.
3. **Read `docs/adr/`.** Decisions with consequences are recorded there. If you
   make a decision with consequences, add the next-numbered ADR.
4. **Never fork a shared module.** If something close exists, extend it. A second
   near-identical helper is how this codebase rots.
5. **Report security findings; do not silently re-architect a live system.**
   Other people depend on it running.
6. **Say what you did not verify.** That line is worth more than the code.

## 5. The driver offer push path — the part most likely to be handed to you

A driver must be reachable when the phone is in a pocket, asleep or locked. The
mechanism is documented in `docs/adr/0001`, `0002` and `0003`. What matters
operationally:

**These files must be re-applied wherever the store builds are produced.** They
are not in the store app's source:

- `android/app/src/main/java/com/kigatta/ingo/OfferMessagingService.java`
- `android/app/src/main/java/com/kigatta/ingo/MainActivity.java`
- `android/app/src/main/AndroidManifest.xml` — the service declaration,
  `USE_FULL_SCREEN_INTENT`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, and the location
  permissions
- `android/variables.gradle`, `android/app/build.gradle`
- `android/app/src/main/res/drawable/ic_stat_offer.xml`

**Roll out the app before the sender.** The Android leg is data-only, so:

| | Old sender | New sender |
|---|---|---|
| **Old app** | works, no buttons | **silent on a killed app** |
| **New app** | works, no buttons | full behaviour |

So: **app first, sender second.** Never the reverse.

### Invariants — breaking these fails silently

- **The notification channel id is duplicated and nothing validates it.**
  `DRIVER_OFFER_CHANNEL_ID` in `src/lib/driverPush.js` must equal
  `android.notification.channel_id` in
  `supabase/functions/driver-offer-push/index.ts`. A mismatch is delivered on the
  default channel, silently, at ordinary importance. **Rename in both files in
  the same commit.** (ADR 0001)
- **The push payload is never trusted for the offer itself.** A tap carries only
  a link and an offer key; the offer is re-fetched by the poll. This is what
  makes an order somebody else took say "no longer available" instead of showing
  stale detail. (ADR 0002)
- **There is one accept path.** The notification buttons, the offer screen and
  the home card all end in `driverAcceptOffer` / `driverRejectOffer`. Do not add
  a second.
- **No coordinates are persisted for proximity.** Pickup addresses are geocoded
  at use and cached client-side. Do not add lat/lng columns to booking tables to
  "fix" distance. (ADR 0004)
- **On Android 14+, `USE_FULL_SCREEN_INTENT` is a special app access** that Play
  grants automatically only to calling and alarm apps. A store build may run
  without it and silently fall back to a ~5 second banner. The service logs
  `canUseFullScreenIntent()` on every ring so this is visible in logcat rather
  than indistinguishable from success.

## 6. Known open items

These are recorded, not forgotten. Do not "discover" and silently fix them.

- **Passwords are stored in plaintext**, and tables are broadly readable with the
  public anon key. Reported to the client; the fix is theirs to authorise.
- **`ecocash-notify` marks a driver top-up paid on the say-so of the POST body** —
  no signature check. Its sibling `paynow-result` verifies a SHA-512 hash; that
  is the fix pattern, already in this repo.
- **Shop stock is decremented from the browser**, so two customers can buy the
  last unit. The fix is one RPC with `FOR UPDATE`; the client never writes stock.
- **Currency is inconsistent** — database columns say GBP, the UI says USD, and
  values are never converted. Needs a decision from the client, not a patch.
- **The admin portal is client-side only** (`/admin/login`) and trivially
  bypassed. It is not a security boundary; treat it as a convenience.
- **Driver location stops updating when the app is backgrounded.** The sender
  treats a driver as online only if `driver_live_updated_at` is under 5 minutes
  old, so a backgrounded driver silently leaves dispatch after ~5 minutes. A
  foreground service is the fix; it is not built.

## 7. Where to look

| You need | Read |
|---|---|
| What was built, verified, and left undone | `docs/worklog.md` |
| Why something is the way it is | `docs/adr/` |
| Driver offer push, end to end | `docs/adr/0001`–`0003`, `docs/push-local-testing.md` |
| The database schema, in one paste | `supabase/bundle/all-in-order.sql` |
| Server-side logic | `supabase/functions/` |
| Driver screens | `src/pages/Driver*.js`, `src/components/driver/` |

---

*This file is the shared handover and is meant to stay self-contained. If you add
a rule that every future agent needs, add it here rather than in a private note.*
