import { isUnrecognizedPlaceLabel, reverseGeocodeLatLng } from './reverseGeocode';
import { whenMedianGeolocationReady } from './medianGeolocation';
import {
  getLocationPermission,
  isNativeApp,
  readNativePosition,
  requestLocationPermission,
} from './nativePermissions';

const GEO_LOG = '[geolocation]';

/**
 * Native app: the fused provider, asked directly. ADR 0005.
 *
 * The WebView's navigator.geolocation raised no permission dialog at all on this
 * build (verified on an emulator 2026-09-06: a 10 s timeout with the app in
 * front and no prompt), so every "Allow location" tap burned its full timers and
 * reported "unavailable". Here the permission is requested explicitly first —
 * no timer runs while the driver reads the dialog — and the position comes from
 * Android's fused provider, which answers from its last known fix in well under
 * a second when `highAccuracy` is off. A precise read follows only if that fails.
 */
async function readNativeGpsPosition(interactive) {
  const perm = interactive ? await requestLocationPermission() : await getLocationPermission();
  if (perm !== 'granted' && perm !== 'coarse') {
    const err = new Error(perm === 'prompt' ? 'not asked' : 'denied');
    err.code = 1;
    throw err;
  }
  const t0 = Date.now();
  try {
    const pos = await readNativePosition({
      highAccuracy: false,
      timeoutMs: interactive ? 8_000 : 15_000,
      maximumAgeMs: 60_000,
    });
    // Serialised, not an object: in the WebView an object logs as [object Object].
    console.log(`${GEO_LOG} native fast fix ${JSON.stringify({ accuracy: pos.coords.accuracy, ms: Date.now() - t0 })}`);
    return pos;
  } catch (firstErr) {
    if (firstErr?.code === 1) throw firstErr;
    console.log(`${GEO_LOG} native fast fix failed ${JSON.stringify({ code: firstErr?.code, ms: Date.now() - t0 })}`);
    const pos = await readNativePosition({
      highAccuracy: true,
      timeoutMs: interactive ? 12_000 : 20_000,
      maximumAgeMs: 10_000,
    });
    console.log(`${GEO_LOG} native precise fix ${JSON.stringify({ accuracy: pos.coords.accuracy, ms: Date.now() - t0 })}`);
    return pos;
  }
}

/** Background / watch helpers — keep modest so the UI does not hang. */
const OPT_HIGH_ACCURACY = { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 };
const OPT_NETWORK_FALLBACK = { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 };

/** Button tap (“Allow location”) — fail fast, prefer a quick network/Wi‑Fi fix first. */
const OPT_INTERACTIVE_FAST = { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 };
const OPT_INTERACTIVE_ACCURATE = { enableHighAccuracy: true, maximumAge: 10_000, timeout: 12_000 };

const REVERSE_GEO_MS = 18000;

/**
 * Human-readable coordinates when reverse geocoding is slow or unavailable.
 * Nominatim / Google geocode can usually resolve "lat, lng" strings.
 */
export function formatLatLngForPickup(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
  return `${la.toFixed(5)}, ${lo.toFixed(5)}`;
}

export function geolocationFailureMessage(code) {
  switch (code) {
    case 1:
      return 'Location permission denied. Allow location for this site in your browser or phone settings, then try again.';
    case 2:
      return 'Location unavailable. Turn on Location / GPS, try outdoors or Wi‑Fi, then tap Allow again — or type your address.';
    case 3:
      return 'Location timed out. Turn on Location, try again outdoors, or type your pickup address.';
    case 4:
      return 'We got a location outside our Zimbabwe service area. Turn on GPS (not only approximate location) and try again.';
    default:
      return 'Could not use your location. Use HTTPS, allow Location for this app, or type your address.';
  }
}

async function readCurrentPosition(options) {
  await whenMedianGeolocationReady();
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(Object.assign(new Error('unsupported'), { code: 0 }));
      return;
    }
    let settled = false;
    const timeoutMs = Math.max(1000, Number(options?.timeout) || 15000) + 1500;
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('timeout');
      err.code = 3;
      console.error(`${GEO_LOG} getCurrentPosition hard-timeout`, { timeoutMs });
      reject(err);
    }, timeoutMs);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        console.log(`${GEO_LOG} getCurrentPosition success`, {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        resolve(position);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        console.error(`${GEO_LOG} getCurrentPosition error`, {
          code: err.code,
          message: err.message,
        });
        reject(err);
      },
      options,
    );
  });
}

/**
 * One-shot GPS read.
 * @param {{ interactive?: boolean }} [opts] interactive=true for Allow / Use current location taps
 * @returns {Promise<GeolocationPosition>}
 */
export async function readDeviceGpsPosition(opts = {}) {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    const err = new Error('insecure');
    err.code = 2;
    throw err;
  }

  const interactive = Boolean(opts.interactive);

  if (isNativeApp()) {
    return readNativeGpsPosition(interactive);
  }

  if (interactive) {
    // Fast approximate first (shows permission prompt + often works indoors), then GPS refine.
    try {
      return await readCurrentPosition(OPT_INTERACTIVE_FAST);
    } catch (firstErr) {
      const c = firstErr?.code;
      if (c === 1 || c === 0) throw firstErr;
      try {
        return await readCurrentPosition(OPT_INTERACTIVE_ACCURATE);
      } catch (secondErr) {
        throw secondErr?.code != null ? secondErr : firstErr;
      }
    }
  }

  try {
    return await readCurrentPosition(OPT_HIGH_ACCURACY);
  } catch (firstErr) {
    const c = firstErr?.code;
    if (c === 2 || c === 3) {
      return readCurrentPosition(OPT_NETWORK_FALLBACK);
    }
    throw firstErr;
  }
}

/**
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<string>} Pickup line: reverse-geocoded address, or "lat, lng".
 */
export async function pickupLineFromCoords(latitude, longitude) {
  const coordLine = formatLatLngForPickup(latitude, longitude);
  const line = await Promise.race([
    reverseGeocodeLatLng(latitude, longitude),
    new Promise((resolve) => {
      setTimeout(() => resolve(''), REVERSE_GEO_MS);
    }),
  ]);

  const trimmed = String(line || '').trim();
  // Never use country-only or "Unnamed Road" labels — they geocode badly (~300km errors)
  // and are useless for riders. Keep exact GPS coords instead; UI still has a usable pin.
  if (!trimmed || isUnrecognizedPlaceLabel(trimmed)) {
    return coordLine;
  }
  return trimmed;
}

/**
 * @returns {Promise<string>} Pickup line: reverse-geocoded address, or "lat, lng".
 */
export async function resolvePickupLineFromDeviceGps() {
  const pos = await readDeviceGpsPosition({ interactive: true });
  return pickupLineFromCoords(pos.coords.latitude, pos.coords.longitude);
}
