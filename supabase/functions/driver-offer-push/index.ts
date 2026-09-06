/**
 * Supabase Edge: **driver-offer-push** — FCM ring alert to online drivers when a booking is offered.
 *
 * Deploy: supabase functions deploy driver-offer-push --no-verify-jwt
 *
 * Secrets (Dashboard → Edge Functions → Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (usually auto)
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — full service account JSON string (preferred)
 *   OR FCM_SERVER_KEY — legacy Cloud Messaging server key
 * Optional: PUBLIC_APP_URL (e.g. https://ingo-92d5f.web.app) for notification click link
 *
 * Body: { "table": "...", "orderId": "<uuid>", "action": "ring"|"stop" }
 *   action "ring" (default) — alert online drivers about a new open offer
 *   action "stop" — tell devices to stop ringing / dismiss the offer notification
 */

import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { encodeBase64Url as base64url } from 'jsr:@std/encoding@1/base64url';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLES = new Set([
  'customer_delivery_orders',
  'taxi_bookings',
  'tuk_tuk_bookings',
  'shop_customer_orders',
]);

// How old a driver's last published position may be and still count them as
// reachable. The app publishes every 15 s only while its WebView is alive; a
// killed app publishes nothing, and push exists precisely to reach that phone.
// At 5 minutes (until 2026-09-06) a driver who closed the app was silently out
// of dispatch five minutes later — the opposite of what push is for. 30 minutes
// matches how long an open request keeps ringing in the app. A driver who
// forgot to go offline gets a notification they can decline; a driver whose
// app was closed gets the ring they were promised. The foreground service that
// would make this exact is still not built (AGENTS.md §6).
const NEARBY_FRESH_MS = 30 * 60 * 1000;
const NEARBY_RADIUS_KM = 20;

type ServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

/**
 * Geocode a pickup address with Google, or explain why not. Never throws.
 * `reason` is one of: no_address | no_key | http_<status> | zero_results | error.
 */
async function geocodePickup(address: string): Promise<{ point: { lat: number; lng: number } | null; reason: string }> {
  const q = String(address || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!q || q === '—') return { point: null, reason: 'no_address' };
  const key = Deno.env.get('GOOGLE_MAPS_API_KEY')?.trim();
  if (!key) return { point: null, reason: 'no_key' };
  try {
    const params = new URLSearchParams({ address: q, key });
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
    if (!res.ok) return { point: null, reason: `http_${res.status}` };
    const data = await res.json();
    const loc = data?.results?.[0]?.geometry?.location;
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (Math.abs(lat) < 1e-8 && Math.abs(lng) < 1e-8)) {
      return { point: null, reason: data?.status === 'ZERO_RESULTS' ? 'zero_results' : `status_${data?.status || 'unknown'}` };
    }
    return { point: { lat, lng }, reason: 'ok' };
  } catch (e) {
    return { point: null, reason: `error_${(e as Error)?.message || 'unknown'}` };
  }
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number | null {
  if (![lat1, lng1, lat2, lng2].every((n) => Number.isFinite(n))) return null;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function placeLabel(raw: unknown): string {
  const t = String(raw ?? '').trim();
  if (!t) return '—';
  return t.split(',')[0].trim().slice(0, 42) || '—';
}

function shortAmount(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `$${v.toFixed(2)}`;
}

function rideCardPaymentPending(row: Record<string, unknown>): boolean {
  const pm = String(row?.payment_method || '')
    .toLowerCase()
    .trim();
  if (pm !== 'card') return false;
  const ps = String(row?.payment_status || '')
    .toLowerCase()
    .trim();
  return ps !== 'paid';
}

function kindTitle(kind: string): string {
  if (kind === 'parcel') return 'New delivery request';
  if (kind === 'shop') return 'New shop delivery';
  if (kind === 'tuktuk') return 'New Tuk-Tuk request';
  return 'New taxi request';
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function getGoogleAccessToken(sa: ServiceAccount): Promise<string> {
  const email = String(sa.client_email || '');
  const keyPem = String(sa.private_key || '').replace(/\\n/g, '\n');
  if (!email || !keyPem) throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const enc = new TextEncoder();
  const head = base64url(enc.encode(JSON.stringify(header)));
  const body = base64url(enc.encode(JSON.stringify(claim)));
  const unsigned = `${head}.${body}`;
  const cryptoKey = await importPrivateKey(keyPem);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, enc.encode(unsigned));
  const jwt = `${unsigned}.${base64url(new Uint8Array(sigBuf))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error || `Google token HTTP ${res.status}`);
  }
  return data.access_token;
}

async function sendFcmV1(
  projectId: string,
  accessToken: string,
  token: string,
  payload: { title: string; body: string; tag: string; link: string; offerKey?: string },
): Promise<{ ok: boolean; invalid?: boolean; error?: string }> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        // No top-level `notification` block, on purpose. With one, Android renders the
        // banner itself and the app runs no code, so Accept / Decline buttons cannot
        // exist. Android is data-only: OfferMessagingService (android/) draws the
        // notification with the two actions. Web still gets a display notification
        // from `webpush.notification`, iOS from `apns.payload.aps.alert`, below.
        data: {
          title: payload.title,
          body: payload.body,
          tag: payload.tag,
          link: payload.link,
          type: 'offer_ring',
          offerKey: payload.offerKey || '',
        },
        android: {
          priority: 'HIGH',
          // An offer is only worth delivering while it is still open. Without a TTL,
          // FCM holds the message for up to 4 weeks and a phone that regains signal
          // an hour later rings for a job somebody else took long ago.
          // 120s matches the webpush TTL below and the offer ring cycle in
          // src/lib/driverIncomingBookings.js (OFFER_RING_CYCLE_MS).
          ttl: '120s',
          // One order, one notification. A re-send for the same order replaces the
          // queued one instead of stacking a second banner on the driver's phone.
          collapse_key: payload.tag,
          // No `android.notification` either (see above). The channel id lives in
          // OfferMessagingService.CHANNEL_ID and src/lib/driverPush.js; docs/adr/0001.
        },
        webpush: {
          headers: { Urgency: 'high', TTL: '120' },
          notification: {
            title: payload.title,
            body: payload.body,
            requireInteraction: true,
            tag: payload.tag,
            vibrate: [500, 120, 500, 120, 500],
          },
          fcm_options: { link: payload.link },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: {
            aps: {
              alert: { title: payload.title, body: payload.body },
              sound: 'default',
              'content-available': 1,
            },
          },
        },
      },
    }),
  });
  if (res.ok) return { ok: true };
  const errBody = (await res.json().catch(() => ({}))) as {
    error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
  };
  const code = errBody?.error?.details?.[0]?.errorCode || errBody?.error?.status || '';
  const invalid = /UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/i.test(String(code + errBody?.error?.message));
  return { ok: false, invalid, error: errBody?.error?.message || `FCM HTTP ${res.status}` };
}

/** Data-only stop: closes matching notification tag and stops in-app ring. */
async function sendFcmV1Stop(
  projectId: string,
  accessToken: string,
  token: string,
  payload: { tag: string; offerKey: string },
): Promise<{ ok: boolean; invalid?: boolean; error?: string }> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        data: {
          type: 'offer_stop',
          tag: payload.tag,
          offerKey: payload.offerKey,
          title: '',
          body: '',
        },
        android: {
          priority: 'HIGH',
        },
        webpush: {
          headers: { Urgency: 'high', TTL: '30' },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: {
            aps: {
              'content-available': 1,
            },
          },
        },
      },
    }),
  });
  if (res.ok) return { ok: true };
  const errBody = (await res.json().catch(() => ({}))) as {
    error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
  };
  const code = errBody?.error?.details?.[0]?.errorCode || errBody?.error?.status || '';
  const invalid = /UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/i.test(String(code + errBody?.error?.message));
  return { ok: false, invalid, error: errBody?.error?.message || `FCM HTTP ${res.status}` };
}

async function sendFcmLegacy(
  serverKey: string,
  token: string,
  payload: { title: string; body: string; tag: string; link: string; offerKey?: string },
): Promise<{ ok: boolean; invalid?: boolean; error?: string }> {
  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      Authorization: `key=${serverKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: token,
      priority: 'high',
      collapse_key: payload.tag,
      notification: {
        title: payload.title,
        body: payload.body,
        sound: 'default',
        tag: payload.tag,
        click_action: payload.link,
      },
      data: {
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        link: payload.link,
        type: 'offer_ring',
        offerKey: payload.offerKey || '',
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    success?: number;
    failure?: number;
    results?: Array<{ error?: string }>;
  };
  if (!res.ok) return { ok: false, error: `Legacy FCM HTTP ${res.status}` };
  if (data.success && data.success > 0) return { ok: true };
  const err = data.results?.[0]?.error || 'send failed';
  const invalid = /NotRegistered|InvalidRegistration/i.test(err);
  return { ok: false, invalid, error: err };
}

async function sendFcmLegacyStop(
  serverKey: string,
  token: string,
  payload: { tag: string; offerKey: string },
): Promise<{ ok: boolean; invalid?: boolean; error?: string }> {
  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      Authorization: `key=${serverKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: token,
      priority: 'high',
      collapse_key: payload.tag,
      content_available: true,
      data: {
        type: 'offer_stop',
        tag: payload.tag,
        offerKey: payload.offerKey,
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    success?: number;
    failure?: number;
    results?: Array<{ error?: string }>;
  };
  if (!res.ok) return { ok: false, error: `Legacy FCM HTTP ${res.status}` };
  if (data.success && data.success > 0) return { ok: true };
  const err = data.results?.[0]?.error || 'send failed';
  const invalid = /NotRegistered|InvalidRegistration/i.test(err);
  return { ok: false, invalid, error: err };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const table = String(body.table ?? '').trim();
  const orderId = String(body.orderId ?? '').trim();
  const action = String(body.action ?? 'ring').toLowerCase().trim() === 'stop' ? 'stop' : 'ring';
  if (!TABLES.has(table) || !UUID_RE.test(orderId)) {
    return json({ ok: false, error: 'Invalid table or orderId' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim();
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: 'Missing Supabase env' }, 500);
  }

  const saRaw = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON')?.trim() || '';
  const legacyKey = Deno.env.get('FCM_SERVER_KEY')?.trim() || '';
  if (!saRaw && !legacyKey) {
    return json({
      ok: false,
      error: 'Set FIREBASE_SERVICE_ACCOUNT_JSON or FCM_SERVER_KEY on the edge function',
    }, 500);
  }

  let sa: ServiceAccount | null = null;
  if (saRaw) {
    try {
      sa = JSON.parse(saRaw) as ServiceAccount;
    } catch {
      return json({ ok: false, error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON' }, 500);
    }
  }

  const publicAppUrl = (Deno.env.get('PUBLIC_APP_URL') || '').replace(/\/$/, '') || '';
  const linkPath = '/driver/home';
  const link = publicAppUrl ? `${publicAppUrl}${linkPath}` : linkPath;

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const offerKey = `${table}:${orderId}`;
  const tag = `ingo-offer-${offerKey}`;

  let accessToken = '';
  let projectId = sa?.project_id || Deno.env.get('FIREBASE_PROJECT_ID') || 'ingo-92d5f';
  if (sa) {
    try {
      accessToken = await getGoogleAccessToken(sa);
      if (sa.project_id) projectId = sa.project_id;
    } catch (e) {
      return json({ ok: false, error: `Google auth failed: ${(e as Error).message}` }, 500);
    }
  }

  // ---- STOP: broadcast to all known driver tokens (offer closed / taken / cancelled) ----
  if (action === 'stop') {
    const { data: tokenRows, error: tokErr } = await supabase
      .from('driver_push_tokens')
      .select('id, driver_id, fcm_token')
      .limit(2000);

    if (tokErr) {
      if (/does not exist|schema cache|Could not find the table/i.test(tokErr.message)) {
        return json({
          ok: false,
          error: 'Run supabase/driver_push_tokens.sql in the Supabase SQL editor.',
        }, 500);
      }
      return json({ ok: false, error: tokErr.message }, 500);
    }

    const tokens = [...new Set((tokenRows || []).map((t) => String(t.fcm_token || '').trim()).filter(Boolean))];
    if (!tokens.length) {
      return json({ ok: true, action: 'stop', sent: 0, reason: 'no_tokens', tag, offerKey });
    }

    let sent = 0;
    const invalidTokens: string[] = [];
    const stopPayload = { tag, offerKey };
    for (const token of tokens) {
      const result = sa
        ? await sendFcmV1Stop(projectId, accessToken, token, stopPayload)
        : await sendFcmLegacyStop(legacyKey, token, stopPayload);
      if (result.ok) sent += 1;
      else if (result.invalid) invalidTokens.push(token);
    }

    if (invalidTokens.length) {
      await supabase.from('driver_push_tokens').delete().in('fcm_token', invalidTokens);
    }

    return json({ ok: true, action: 'stop', sent, tokens: tokens.length, tag, offerKey, table, orderId });
  }

  const { data: row, error: rowErr } = await supabase.from(table).select('*').eq('id', orderId).maybeSingle();
  if (rowErr) return json({ ok: false, error: rowErr.message }, 500);
  if (!row) return json({ ok: false, error: 'Booking not found' }, 404);

  const r = row as Record<string, unknown>;
  if (r.assigned_driver_id) return json({ ok: true, skipped: 'already_assigned', sent: 0 });

  const status = String(r.status || '').toLowerCase().trim();
  let kind = 'taxi';
  let title = '';
  let from = '';
  let to = '';
  let amount: unknown = null;

  if (table === 'customer_delivery_orders') {
    if (!['placed', 'paid'].includes(status)) {
      return json({ ok: true, skipped: 'status', sent: 0 });
    }
    kind = 'parcel';
    from = String(r.pickup_location || '');
    to = String(r.dropoff_location || '');
    amount = r.customer_offer_amount ?? r.total_amount;
  } else if (table === 'taxi_bookings' || table === 'tuk_tuk_bookings') {
    if (status !== 'requested') return json({ ok: true, skipped: 'status', sent: 0 });
    if (rideCardPaymentPending(r)) return json({ ok: true, skipped: 'payment_pending', sent: 0 });
    kind = table === 'tuk_tuk_bookings' ? 'tuktuk' : 'taxi';
    from = String(r.pickup_location || '');
    to = String(r.destination_location || '');
    amount = r.customer_offer_amount ?? r.quoted_price;
  } else if (table === 'shop_customer_orders') {
    if (status !== 'ready for delivery') return json({ ok: true, skipped: 'status', sent: 0 });
    kind = 'shop';
    from = 'Shop';
    to = String(r.customer_address || '');
    amount = r.delivery_fee ?? r.subtotal;
    try {
      const { data: lines } = await supabase
        .from('shop_customer_order_lines')
        .select('shop_owner_id')
        .eq('order_id', orderId)
        .limit(5);
      const ownerId = lines?.[0]?.shop_owner_id;
      if (ownerId) {
        const { data: shop } = await supabase
          .from('shop_owners')
          .select('business_name, business_address')
          .eq('id', ownerId)
          .maybeSingle();
        if (shop?.business_name) from = String(shop.business_name);
        else if (shop?.business_address) from = String(shop.business_address);
      }
    } catch {
      /* ignore */
    }
  }

  const bidStatus = String(r.bid_status || 'open').toLowerCase();
  if (bidStatus === 'matched' || bidStatus === 'cancelled') {
    return json({ ok: true, skipped: 'bid_status', sent: 0 });
  }

  title = kindTitle(kind);
  const bodyText = [
    placeLabel(from),
    placeLabel(to) !== '—' ? `→ ${placeLabel(to)}` : null,
    shortAmount(amount) || null,
  ]
    .filter(Boolean)
    .join(' · ');

  const payload = { title, body: bodyText || 'Open the app to accept or reject.', tag, link, offerKey };

  const cutoff = new Date(Date.now() - NEARBY_FRESH_MS).toISOString();
  // `driver_live_updated_at` is written only with a real fix (nearbyDrivers.js
  // publishDriverOnlineLocation): an online driver who has never had one keeps
  // it null and would never be rung, however many times the app says "online".
  // Null is "no position yet", not "gone"; going offline clears `is_online`.
  type DriverRow = Record<string, unknown> & { id: string | number };
  let drivers: DriverRow[] | null = null;
  let drvErr: { message?: string } | null = null;
  {
    const res = await supabase
      .from('driver_registrations')
      .select('id, driver_live_lat, driver_live_lng, driver_live_updated_at, is_online, vehicle_type')
      .eq('status', 'approved')
      .eq('is_online', true)
      .or(`driver_live_updated_at.gte.${cutoff},driver_live_updated_at.is.null`)
      .limit(200);
    drivers = res.data as DriverRow[] | null;
    drvErr = res.error;
  }

  // Production ran without supabase/driver_online_location.sql until 2026-09-06:
  // `driver_registrations.driver_live_lat does not exist`, and every real ring
  // answered 500 while the zero-uuid probes (which stop at the row lookup)
  // said the function was fine. A missing column must not silence dispatch:
  // ring every online approved driver, say which migration is missing, and if
  // even `is_online` is absent, say so instead of guessing.
  let schemaGap = '';
  if (drvErr && /driver_live_(lat|lng|updated_at)/.test(drvErr.message || '')) {
    schemaGap = 'run supabase/driver_online_location.sql on this project';
    console.error(`[driver-offer-push] ${drvErr.message} — ${schemaGap}; ringing every online driver without a radius`);
    const res = await supabase
      .from('driver_registrations')
      .select('id, is_online, vehicle_type')
      .eq('status', 'approved')
      .eq('is_online', true)
      .limit(200);
    drivers = res.data as DriverRow[] | null;
    drvErr = res.error;
  }
  if (drvErr) {
    const hint = /is_online/.test(drvErr.message || '') ? 'run supabase/driver_online_location.sql on this project' : schemaGap;
    return json({ ok: false, error: drvErr.message, hint: hint || undefined }, 500);
  }

  let driverIds = (drivers || []).map((d) => String(d.id));

  // Proximity without a schema change (2026-09-03): bookings carry the pickup as
  // text, so it is geocoded here at ring time when GOOGLE_MAPS_API_KEY is set, and
  // the radius filter below applies. No key, or a failed lookup, keeps today's
  // behaviour (every fresh online driver) and says so in the response.
  let pickupLat = Number(r.pickup_lat ?? r.from_lat);
  let pickupLng = Number(r.pickup_lng ?? r.from_lng);
  let proximity: Record<string, unknown> = { source: 'row' };
  if (!(Number.isFinite(pickupLat) && Number.isFinite(pickupLng))) {
    const g = await geocodePickup(from);
    if (g.point) {
      pickupLat = g.point.lat;
      pickupLng = g.point.lng;
      proximity = { source: 'geocoded', radiusKm: NEARBY_RADIUS_KM };
    } else {
      proximity = { source: 'none', reason: g.reason, radiusKm: null };
      console.warn(`[driver-offer-push] no pickup coordinates (${g.reason}); ringing all fresh drivers`);
    }
  }
  if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng) && drivers?.length) {
    const near = drivers.filter((d) => {
      // `Number(null)` is 0, a real point in the Gulf of Guinea; a row with no
      // fix must become null here, not a distance to (0, 0).
      const hasFix = d.driver_live_lat != null && d.driver_live_lng != null;
      const dist = hasFix
        ? haversineKm(pickupLat, pickupLng, Number(d.driver_live_lat), Number(d.driver_live_lng))
        : null;
      // No published fix is "unknown", not "far": keep the driver.
      return dist == null || dist <= NEARBY_RADIUS_KM;
    });
    if (near.length) {
      driverIds = near.map((d) => String(d.id));
    } else {
      // Nobody within the radius, but drivers are online. Either the pickup text
      // geocoded to the wrong place (a bare "CBD", a suburb name that exists in
      // two countries) or the fleet is simply elsewhere. The app's own poll shows
      // this order to every online driver regardless, so the push must never be
      // the stricter of the two: a driver who hears the in-app ring and gets no
      // notification reads it as "push is broken" (2026-09-06, a real phone).
      // Ring them all and say so; the app shows the distance, or "unknown", and
      // the driver declines.
      proximity = { ...proximity, fallback: 'all_online', online: drivers.length };
      console.warn(
        `[driver-offer-push] no driver within ${NEARBY_RADIUS_KM} km of the pickup; ringing all ${drivers.length} fresh online drivers`,
      );
    }
  }

  if (!driverIds.length) {
    return json({
      ok: true,
      sent: 0,
      reason: (drivers || []).length ? 'no_nearby_drivers' : 'no_online_drivers',
      proximity,
    });
  }

  // Respect Profile → Notifications: skip drivers who turned new offers off.
  // Missing prefs row = enabled.
  //
  // `push_when_closed` is deliberately NOT honoured here (since 2026-09-06). The
  // app's client default for it was `false`, and saving any toggle on the
  // Notifications page upserted the whole row, so one tap on "offer sound"
  // silently switched every push off for that driver for good — while the
  // in-app poll kept ringing them. The sender cannot know whether the app is
  // closed, so the only honest reading of that switch is none at all.
  {
    const { data: prefRows, error: prefErr } = await supabase
      .from('driver_notification_prefs')
      .select('driver_id, new_offers, push_when_closed')
      .in('driver_id', driverIds);

    if (prefErr) {
      if (!/does not exist|schema cache|Could not find the table/i.test(prefErr.message || '')) {
        return json({ ok: false, error: prefErr.message }, 500);
      }
      // Table not created yet — keep previous behaviour (push all).
    } else if (prefRows?.length) {
      const blocked = new Set(
        prefRows
          .filter((p) => p.new_offers === false)
          .map((p) => String(p.driver_id)),
      );
      driverIds = driverIds.filter((id) => !blocked.has(String(id)));
    }
  }

  if (!driverIds.length) {
    return json({ ok: true, sent: 0, reason: 'prefs_disabled' });
  }

  const { data: tokenRows, error: tokErr } = await supabase
    .from('driver_push_tokens')
    .select('id, driver_id, fcm_token')
    .in('driver_id', driverIds);

  if (tokErr) {
    if (/does not exist|schema cache|Could not find the table/i.test(tokErr.message)) {
      return json({
        ok: false,
        error: 'Run supabase/driver_push_tokens.sql in the Supabase SQL editor.',
      }, 500);
    }
    return json({ ok: false, error: tokErr.message }, 500);
  }

  const tokens = [...new Set((tokenRows || []).map((t) => String(t.fcm_token || '').trim()).filter(Boolean))];
  if (!tokens.length) {
    return json({ ok: true, sent: 0, reason: 'no_tokens' });
  }

  let sent = 0;
  let failed = 0;
  const invalidTokens: string[] = [];
  for (const token of tokens) {
    // One phone's send must never take the others down with it. A transient
    // network failure to FCM used to throw out of this loop and answer 500
    // with nobody rung (seen 2026-09-06, a DNS blip); now it is counted and
    // the next token is tried.
    try {
      const result = sa
        ? await sendFcmV1(projectId, accessToken, token, payload)
        : await sendFcmLegacy(legacyKey, token, payload);
      if (result.ok) sent += 1;
      else if (result.invalid) invalidTokens.push(token);
      else failed += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[driver-offer-push] send failed: ${(e as Error)?.message || e}`);
    }
  }

  if (invalidTokens.length) {
    await supabase.from('driver_push_tokens').delete().in('fcm_token', invalidTokens);
  }

  return json({ ok: true, action: 'ring', sent, failed, drivers: driverIds.length, tokens: tokens.length, kind, table, orderId, proximity, schemaGap: schemaGap || undefined });
});
