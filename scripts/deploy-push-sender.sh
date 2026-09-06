#!/usr/bin/env bash
# Deploy the driver-offer-push edge function to a Supabase project, with the
# Firebase sender credentials it needs, in one step. Non-interactive: it does not
# open a browser, so it works from a script or a CI job.
#
# USAGE
#   SUPABASE_ACCESS_TOKEN=sbp_xxx  ./scripts/deploy-push-sender.sh <project-ref>
#
#   <project-ref>          e.g. gcwrnluyaqarmrovbryj  (throwaway) — NOT the client's
#                          production ref unless that is deliberately intended.
#   SUPABASE_ACCESS_TOKEN  Dashboard → avatar → Account → Access Tokens. Account-wide;
#                          treat as a password and rotate after use. Optional when
#                          `npx supabase login` has been run on this machine.
#   PUBLIC_APP_URL         optional; the site a web-push click opens.
#
# Reads .secrets/fcm-service-account.json for FIREBASE_PROJECT_ID and
# FIREBASE_SERVICE_ACCOUNT_JSON — the exact names the function reads via Deno.env.
#
# --no-verify-jwt is REQUIRED for projects on new-format API keys (sb_publishable_…):
# the app invokes this function with the public key and no user session, and that
# key is not a JWT, so the gateway's default verification would 401 every call.
# supabase/config.toml says the same; the flag makes it explicit on the CLI too.
set -euo pipefail

REF="${1:-}"
[ -n "$REF" ] || { echo "usage: SUPABASE_ACCESS_TOKEN=... $0 <project-ref>"; exit 1; }
# Either an access token in the environment (CI) or a stored `npx supabase login`
# (a developer's machine: ~/.supabase/access-token, or %APPDATA%\supabase on Windows).
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] && [ ! -f "$HOME/.supabase/access-token" ] && [ ! -f "${APPDATA:-/nonexistent}/supabase/access-token" ]; then
  echo "SUPABASE_ACCESS_TOKEN is not set and no stored login found: run 'npx supabase login' first"; exit 1
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SA="$HERE/.secrets/fcm-service-account.json"
[ -f "$SA" ] || { echo "missing $SA — see scripts/send-test-offer.js SETUP"; exit 1; }

# Read via stdin: under Git Bash on Windows, $SA is a POSIX-style path (/d/…) that
# Node's require()/fs cannot resolve, so never hand Node a path here.
FIREBASE_PROJECT_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).project_id)" < "$SA")"
[ -n "$FIREBASE_PROJECT_ID" ] || { echo "could not read project_id from $SA"; exit 1; }

echo "→ deploying driver-offer-push to $REF (JWT verification OFF)"
npx supabase functions deploy driver-offer-push \
  --project-ref "$REF" \
  --no-verify-jwt

# The downloaded key file is pretty-printed over many lines. `secrets set NAME=VALUE`
# parses one line, so passing the file verbatim stores just "{" and the function
# then fails with "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON" (seen 2026-09-03).
# Compact it to a single line first. The private_key's "\n" escapes survive as-is;
# the function un-escapes them.
FIREBASE_SA_ONELINE="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8'))))" < "$SA")"

echo "→ setting sender secrets on $REF"
# PUBLIC_APP_URL is where a web-push click lands (e.g. https://ingo-92d5f.web.app).
# Optional; passed through only when set, so a throwaway deploy is never pointed
# at the production site by accident.
npx supabase secrets set --project-ref "$REF" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_JSON="$FIREBASE_SA_ONELINE" \
  ${PUBLIC_APP_URL:+PUBLIC_APP_URL="$PUBLIC_APP_URL"}

echo "→ done. Smoke test (expects a JSON body, not a 401):"
echo "   curl -s -X POST https://$REF.supabase.co/functions/v1/driver-offer-push \\"
echo "     -H 'apikey: <publishable key>' -H 'Content-Type: application/json' \\"
echo "     -d '{\"table\":\"customer_delivery_orders\",\"orderId\":\"00000000-0000-0000-0000-000000000000\",\"action\":\"ring\"}'"
