# InGo — KIGATTA INVESTMENTS

<!-- AIOS link. Added 2026-08-29 by project-intake. Keep this section at the top. -->

## ⚠ Read this before anything else

**This is a client's live production system. Rio does not own it.** KIGATTA
INVESTMENTS owns the repo, the Supabase project, the Firebase project and the
payment accounts. Rio was given access on 2026-08-29 to do features and
debugging.

**Two things will bite a session that skips this file:**

1. **`npm start` talks to the client's LIVE database and live payment flows.**
   Production Supabase, Stripe `pk_live_`, and the Paynow production API are
   hardcoded as fallbacks in source — including in `.env.development`. There is
   no staging. A test registration creates a real user. Read
   `D:\OS\ingo-os\Production Exposure.md` before any write-path work.

2. **The "cut Firebase to MySQL/Postgres" request is mis-aimed.** Firebase here
   is push notifications + hosting, 3 files. **Supabase is the database — and
   Supabase already is Postgres.** Removing Firebase deletes driver push and
   changes no database. Do not start ripping it out. Read
   `D:\OS\ingo-os\Migration.md`.

**There is also an unresolved security exposure** (plaintext passwords, 29
tables open to the public anon key). Read `D:\OS\ingo-os\Security.md`. Rio is a
contractor here: **report findings, do not silently re-architect a live system.**

## This project is registered in the AIOS

Rio's operating system and long-term memory live at **`D:\OS`**.

**Its knowledge base is `D:\OS\ingo-os\`.** Read `D:\OS\ingo-os\index.md`
before answering anything about this project's status, client, commercials or
history. Do not re-derive from the code what the wiki already records.

**Before starting work, read:**

1. `D:\OS\ingo-os\index.md`, then `D:\OS\ingo-os\CLAUDE.md`
2. `~/.claude/skills/` — the machine-wide standards. `worklog` before your
   first edit, then `screen` / `ui-performance` / `engineering-standards` as
   the work demands.

**Before finishing, use `self-improve`:**

| What you learned | Where it goes |
|---|---|
| A rule for all projects | `~/.claude/skills/` |
| A rule for this project only | this file |
| A business decision | `D:\OS\decisions\log.md` |
| A fact about the client, money or status | `D:\OS\ingo-os\` as a wiki page |
| Session state, gotchas, what you did NOT build | the worklog in this repo |

**The trigger is the second time.** First occurrence is an incident. Second is
a pattern, and a pattern belongs in a standard.

## Repo facts worth not rediscovering

- **Upstream is the client's.** `origin` = `RealAkram20/bykea` (Rio's fork),
  `upstream` = `KIGATTA-INVESTMENTS/bykea`. Branch `master`.
- **CRA 5 + React 19**, no TypeScript. `react-scripts@5.0.1` is deprecated
  upstream — that is the source of most `npm audit` noise. Those are build-chain
  transitives, not runtime; `npm audit fix --force` risks the build for no gain.
- **Admin portal:** `/admin/login`, `admin@ingo.com` / `Admin@123`, hardcoded in
  `src/lib/adminAuth.js`. Client-side only, trivially bypassed.
- **No backend tier exists.** The browser talks straight to Supabase. Auth is
  hand-rolled; `supabase.auth` is used 0 times.
- **`REACT_APP_GOOGLE_MAPS_API_KEY` is unset**, so map pages render degraded.
- **1 test file** for ~59k lines. Assume no safety net.
- **Do not confuse this with `d:\xampp\htdocs\ingo`** — that is Rio's own
  Laravel fleet log. Same brand, different product, different owner.
- **`android/` and `capacitor.config.json` are a local spike, not the shipped
  apps.** Created 2026-08-30 to measure and test. The Android and iOS apps on the
  stores were built elsewhere and **their source is not in this repository.**
  Anything changed under `android/` must be re-applied wherever the store builds
  are actually produced, or it ships to nobody.
- **Driver push: the channel id is duplicated and unchecked.**
  `DRIVER_OFFER_CHANNEL_ID` in `src/lib/driverPush.js` must equal
  `android.notification.channel_id` in
  `supabase/functions/driver-offer-push/index.ts`. Nothing validates this. A
  mismatch is delivered on the default channel, silently, at ordinary importance.
  Rename in both files in the same commit. See `docs/adr/0001`.
- **Read `docs/worklog.md` before touching push, offers or driver session.**
