#!/usr/bin/env node
/**
 * Send one driver-offer push to a single device, locally, without deploying anything.
 *
 * WHY THIS EXISTS
 * The real sender is the Supabase edge function `driver-offer-push`. Deploying that
 * to the client's production project just to find out whether a notification renders
 * is the wrong loop: slow, and it touches a live system. This script sends the
 * BYTE-IDENTICAL FCM v1 message to one token you choose, from your machine.
 *
 * Keep the message shape here in sync with
 * `supabase/functions/driver-offer-push/index.ts`. If they drift, this stops being
 * a test of the real thing and becomes a test of itself.
 *
 * SETUP (all in a throwaway Firebase project — never the client's `ingo-92d5f`)
 *   1. console.firebase.google.com → Add project (anything, e.g. "ingo-local-test")
 *   2. Add an Android app with package name  com.kigatta.ingo
 *   3. Download google-services.json → android/app/google-services.json
 *   4. Project settings → Service accounts → Generate new private key
 *      → save as  .secrets/fcm-service-account.json   (gitignored)
 *
 * USAGE
 *   node scripts/send-test-offer.js <device-token> [--stop]
 *   OFFER_KEY=customer_delivery_orders:<uuid> node scripts/send-test-offer.js <token>
 *
 * Get <device-token> from logcat after a driver signs in:
 *   adb logcat -d | grep "push token stored"
 * or from the driver_push_tokens table in whichever Supabase project you point at.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_PATH = path.join(__dirname, '..', '.secrets', 'fcm-service-account.json');

const token = process.argv[2];
const isStop = process.argv.includes('--stop');

if (!token) {
  console.error('usage: node scripts/send-test-offer.js <device-token> [--stop]');
  process.exit(1);
}
if (!fs.existsSync(KEY_PATH)) {
  console.error(`Missing ${KEY_PATH}`);
  console.error('See the SETUP block at the top of this file.');
  process.exit(1);
}

const sa = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const projectId = sa.project_id;

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a short-lived access token for the FCM v1 API, same as the edge function does. */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(sa.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

// OFFER_KEY=<table>:<uuid> makes the notification's Accept / Decline act on a real
// row in the project the app is pointed at (the same `table:id` encoding the
// sender uses). Without it the buttons target a placeholder and the app answers
// "no longer available", which still proves delivery and rendering.
const orderId = process.env.OFFER_KEY || 'local-test-0001';
const tag = `ingo-offer-${orderId}`;

/** Mirrors sendRing() in the edge function. */
const ringMessage = {
  token,
  // Data-only on purpose (ADR 0002): OfferMessagingService draws the notification
  // with Accept / Decline. A `notification` block here would make Android render
  // it instead and the buttons would vanish.
  data: {
    title: 'New InGo delivery',
    body: 'Harare CBD to Avondale, 4.2 km. Tap to accept or decline.',
    tag,
    link: '/driver/home',
    type: 'offer_ring',
    offerKey: orderId,
  },
  android: {
    priority: 'HIGH',
    ttl: '120s',
    collapse_key: tag,
  },
};

/** Mirrors the data-only stop message in the edge function. */
const stopMessage = {
  token,
  data: { tag, type: 'offer_stop', offerKey: orderId },
  android: { priority: 'HIGH' },
};

(async () => {
  const accessToken = await getAccessToken();
  const message = isStop ? stopMessage : ringMessage;

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`sent ${isStop ? 'STOP' : 'RING'} to project ${projectId}`);
    console.log(JSON.stringify(body, null, 2));
    console.log('\nNow check the device:');
    console.log('  adb logcat -d | grep -i driverpush');
  } else {
    console.error(`FCM ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
