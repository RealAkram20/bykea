/**
 * Google Maps — set `REACT_APP_GOOGLE_MAPS_API_KEY` in `.env` / `.env.local` (see `.env.example`).
 * Route preview uses Maps Embed API (`/embed/v1/directions`): enable Maps Embed API + billing in Cloud Console.
 * Customer home uses **Maps JavaScript API** when `REACT_APP_GOOGLE_MAPS_API_KEY` is set (default red pin from `google.maps.Marker`). Set `REACT_APP_HOME_USE_MAPS_EMBED_ONLY=true` to use Maps Embed only (no JS load). Fix **ApiTargetBlockedMapError** in Google Cloud → Credentials → browser key → **HTTP referrers** (include your exact dev/prod origins) and allow **Maps JavaScript API**.
 * If the console shows **ApiTargetBlockedMapError** or **RefererNotAllowedMapError**, open Google Cloud Console → Credentials → your browser key →
 * **Application restrictions** → **HTTP referrers** and add every origin you use, e.g. `http://localhost:3000/*`, `http://127.0.0.1:3000/*`, and your production `https://yourdomain.com/*` (localhost vs 127.0.0.1 are different referrers). Under **API restrictions**, include **Maps JavaScript API** (and Embed / Places / Geocoding as needed).
 * Address autocomplete and typed-address geocoding go through **Supabase Edge** (`places-autocomplete`, `places-geocode`) so the browser never calls Google’s JSON endpoints (CORS). Set `GOOGLE_MAPS_API_KEY` as a Supabase secret; enable **Places API** and **Geocoding API** on that key.
 * The browser key here is still used for Maps JS / embeds. Without Supabase, OSM may be used for suggestions when no key is set; with a key but no Edge deploy, autocomplete stays empty and geocode falls back to direct Geocoding where the browser allows it.
 */
export function getGoogleMapsApiKey() {
  return (process.env.REACT_APP_GOOGLE_MAPS_API_KEY || '').trim();
}

/** Maps JS failed at runtime (referrer restrictions, wrong API enabled, invalid key, etc.). */
export function isGoogleMapsJavaScriptBlockingMessage(msg) {
  const s = String(msg || '');
  return (
    /ApiTargetBlockedMapError|RefererNotAllowedMapError|InvalidKeyMapError|MissingKeyMapError|ApiNotActivatedMapError|ClientIdMissingMapError|ExpiredKeyMapError|BillingNotEnabledMapError|NotAuthorizedMapError/i.test(
      s,
    ) || /Google Maps JavaScript API error/i.test(s)
  );
}

/**
 * Reject coordinates that would break embeds or are common garbage (NaN, out of range, null island).
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean}
 */
export function isReliableGpsLatLng(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return false;
  if (Math.abs(la) < 1e-8 && Math.abs(lo) < 1e-8) return false;
  return true;
}

function directionsEmbedUrlWithKey(origin, destination, waypoints = []) {
  const key = getGoogleMapsApiKey();
  const o = String(origin || '').trim();
  const d = String(destination || '').trim();
  if (!key || !o || !d) return '';
  const mids = (waypoints || []).map((w) => String(w || '').trim()).filter(Boolean);
  let url = `https://www.google.com/maps/embed/v1/directions?key=${encodeURIComponent(key)}&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&mode=driving`;
  if (mids.length) {
    url += `&waypoints=${mids.map((w) => encodeURIComponent(w)).join('%7C')}`;
  }
  return url;
}

/** Directions embed using coordinates (most reliable inside iframes). */
function directionsEmbedCoordsUrlWithKey(oLat, oLng, dLat, dLng, waypointLatLngPairs = []) {
  const key = getGoogleMapsApiKey();
  if (!key) return '';
  const olat = Number(oLat);
  const olng = Number(oLng);
  const dlat = Number(dLat);
  const dlng = Number(dLng);
  if (![olat, olng, dlat, dlng].every(Number.isFinite)) return '';

  const origin = `${olat},${olng}`;
  const destination = `${dlat},${dlng}`;
  let url = `https://www.google.com/maps/embed/v1/directions?key=${encodeURIComponent(key)}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=driving`;

  const mids = (waypointLatLngPairs || []).filter(
    ([lat, lng]) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)),
  );
  if (mids.length) {
    const wp = mids.map(([lat, lng]) => `${Number(lat)},${Number(lng)}`).join('|');
    url += `&waypoints=${encodeURIComponent(wp)}`;
  }
  return url;
}

function viewEmbedUrlWithKey(lat, lng, zoom = 13) {
  const key = getGoogleMapsApiKey();
  if (!key) return '';
  return `https://www.google.com/maps/embed/v1/view?key=${encodeURIComponent(key)}&center=${lat},${lng}&zoom=${zoom}&maptype=roadmap`;
}

function placeEmbedUrlWithKey(query) {
  const key = getGoogleMapsApiKey();
  const q = String(query || '').trim();
  if (!key || !q) return '';
  return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}`;
}

/** Keyed Embed API URL only (no `output=embed` fallback). Use for debugging vs legacy. */
export function mapsKeyedPlaceEmbedUrl(query) {
  return placeEmbedUrlWithKey(query);
}

/** No API key — classic embed (enable if Embed API / billing blocks the keyed iframe). */
export function mapsLegacyPlaceEmbedUrl(query) {
  const q = String(query || '').trim();
  if (!q) return '';
  return `https://www.google.com/maps?q=${encodeURIComponent(q)}&hl=en&z=14&output=embed`;
}

/**
 * Driving directions embed (no API key). Uses Maps URL scheme:
 * https://developers.google.com/maps/documentation/urls/get-started
 */
export function mapsLegacyDirectionsEmbedUrl(origin, destination, waypoints = []) {
  const o = String(origin || '').trim();
  const d = String(destination || '').trim();
  if (!o || !d) return '';
  const mids = (waypoints || []).map((w) => String(w || '').trim()).filter(Boolean);
  const daddr = mids.length ? `${mids.join(' to:')} to:${d}` : d;
  return `https://maps.google.com/maps?saddr=${encodeURIComponent(o)}&daddr=${encodeURIComponent(daddr)}&dirflg=d&hl=en&output=embed`;
}

/** Legacy directions iframe using lat,lng — avoids broken parsing on very long postal addresses. */
export function mapsLegacyDirectionsCoordsEmbedUrl(oLat, oLng, dLat, dLng) {
  const olat = Number(oLat);
  const olng = Number(oLng);
  const dlat = Number(dLat);
  const dlng = Number(dLng);
  if (![olat, olng, dlat, dlng].every(Number.isFinite)) return '';
  const saddr = `${olat},${olng}`;
  const daddr = `${dlat},${dlng}`;
  return `https://maps.google.com/maps?saddr=${encodeURIComponent(saddr)}&daddr=${encodeURIComponent(daddr)}&dirflg=d&hl=en&output=embed`;
}

export function mapsLegacyViewEmbedUrl(lat, lng, zoom = 12) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${Number(lat)},${Number(lng)}`)}&z=${zoom}&output=embed`;
}

export function publicPlaceMapUrl(query) {
  return placeEmbedUrlWithKey(query) || mapsLegacyPlaceEmbedUrl(query);
}

/** Keyed Embed API first; classic `output=embed` only if the key is missing. */
export function publicPlaceMapUrlRobust(query) {
  return placeEmbedUrlWithKey(query) || mapsLegacyPlaceEmbedUrl(query);
}

export function publicDirectionsMapUrl(origin, destination, waypoints = []) {
  return (
    directionsEmbedUrlWithKey(origin, destination, waypoints) ||
    mapsLegacyDirectionsEmbedUrl(origin, destination, waypoints)
  );
}

export function publicDirectionsMapUrlRobust(origin, destination, waypoints = []) {
  return (
    directionsEmbedUrlWithKey(origin, destination, waypoints) ||
    mapsLegacyDirectionsEmbedUrl(origin, destination, waypoints)
  );
}

/** Prefer this after geocoding pickup + destination — shows a real route much more reliably. */
export function publicDirectionsCoordsMapUrl(oLat, oLng, dLat, dLng, waypointLatLngPairs = []) {
  return (
    directionsEmbedCoordsUrlWithKey(oLat, oLng, dLat, dLng, waypointLatLngPairs) ||
    mapsLegacyDirectionsCoordsEmbedUrl(oLat, oLng, dLat, dLng)
  );
}

export function publicDirectionsCoordsMapUrlRobust(oLat, oLng, dLat, dLng, waypointLatLngPairs = []) {
  return (
    directionsEmbedCoordsUrlWithKey(oLat, oLng, dLat, dLng, waypointLatLngPairs) ||
    mapsLegacyDirectionsCoordsEmbedUrl(oLat, oLng, dLat, dLng)
  );
}

export function publicViewMapUrl(lat, lng, zoom = 13) {
  return viewEmbedUrlWithKey(lat, lng, zoom) || mapsLegacyViewEmbedUrl(lat, lng, zoom);
}

export function publicViewMapUrlRobust(lat, lng, zoom = 13) {
  return viewEmbedUrlWithKey(lat, lng, zoom) || mapsLegacyViewEmbedUrl(lat, lng, zoom);
}

/**
 * Driver portal maps — prefer classic `output=embed` so the map still renders when
 * Maps Embed API / billing / HTTP referrers block the keyed iframe (common after
 * reopen / login on localhost and native WebViews).
 */
export function publicViewMapUrlDriver(lat, lng, zoom = 13) {
  return mapsLegacyViewEmbedUrl(lat, lng, zoom) || viewEmbedUrlWithKey(lat, lng, zoom);
}

export function publicPlaceMapUrlDriver(query) {
  return mapsLegacyPlaceEmbedUrl(query) || placeEmbedUrlWithKey(query);
}

export function publicDirectionsMapUrlDriver(origin, destination, waypoints = []) {
  return (
    mapsLegacyDirectionsEmbedUrl(origin, destination, waypoints) ||
    directionsEmbedUrlWithKey(origin, destination, waypoints)
  );
}

export function publicDirectionsCoordsMapUrlDriver(oLat, oLng, dLat, dLng, waypointLatLngPairs = []) {
  return (
    mapsLegacyDirectionsCoordsEmbedUrl(oLat, oLng, dLat, dLng) ||
    directionsEmbedCoordsUrlWithKey(oLat, oLng, dLat, dLng, waypointLatLngPairs)
  );
}

/** Default map center when GPS is denied or unavailable (Harare, Zimbabwe). */
export const DEFAULT_MAP_FALLBACK = Object.freeze({
  lat: -17.8292,
  lng: 31.0522,
  zoom: 13,
  label: 'Harare, Zimbabwe',
});

/** Zimbabwe — reject wrong-continent network geolocation (e.g. London IP/Wi‑Fi fixes). */
export const SERVICE_AREA_BOUNDS = Object.freeze({
  minLat: -22.75,
  maxLat: -15.45,
  minLng: 25.0,
  maxLng: 33.9,
});

/** Persisted GPS cache TTL — stale fixes must not pin the map to an old city. */
export const GEO_CACHE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean}
 */
export function isInServiceArea(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!isReliableGpsLatLng(la, lo)) return false;
  return (
    la >= SERVICE_AREA_BOUNDS.minLat &&
    la <= SERVICE_AREA_BOUNDS.maxLat &&
    lo >= SERVICE_AREA_BOUNDS.minLng &&
    lo <= SERVICE_AREA_BOUNDS.maxLng
  );
}

/**
 * Device GPS we trust for maps / pickup: any real fix.
 *
 * Until 2026-09-03 this required the fix to fall inside the Zimbabwe box above,
 * which threw away every fix taken outside Zimbabwe — a driver testing from
 * Kampala saw a map of Harare and was published online with no coordinates, so
 * nothing about proximity could work. Decision (Rio): trust the device; Harare
 * is only the fallback when there is no fix at all. `isInServiceArea` stays
 * available for callers that genuinely need the box.
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean}
 */
export function isAcceptableDeviceFix(lat, lng) {
  return isReliableGpsLatLng(lat, lng);
}

/**
 * Map center for display: the live fix when there is one, otherwise the Harare fallback.
 * @param {{ lat?: number, lng?: number } | null | undefined} center
 * @param {{ lat: number, lng: number }} [fallback]
 */
export function trustedMapCenter(center, fallback = DEFAULT_MAP_FALLBACK) {
  if (center && isAcceptableDeviceFix(center.lat, center.lng)) {
    return { lat: Number(center.lat), lng: Number(center.lng) };
  }
  return { lat: fallback.lat, lng: fallback.lng };
}

/** Map embed URL centered on Harare when live GPS is unavailable. */
export function publicDefaultViewMapUrl(zoom = DEFAULT_MAP_FALLBACK.zoom) {
  return publicViewMapUrlRobust(DEFAULT_MAP_FALLBACK.lat, DEFAULT_MAP_FALLBACK.lng, zoom);
}

const DRIVER_MAP_FALLBACK = DEFAULT_MAP_FALLBACK;

/**
 * Driver active-delivery / navigation map — address route immediately, GPS+coords when ready.
 * Pass `routedOrigin` (first stable GPS fix) so the iframe URL does not change every second.
 * @param {{
 *   pickup?: string,
 *   dropoff?: string,
 *   navTarget?: string,
 *   toDropoff?: boolean,
 *   routedOrigin?: { lat: number, lng: number } | null,
 *   pickupGeo?: { lat: number, lng: number } | null,
 *   dropoffGeo?: { lat: number, lng: number } | null,
 *   destGeo?: { lat: number, lng: number } | null,
 * }} opts
 */
export function buildDriverRouteMapUrl(opts = {}) {
  const pu = String(opts.pickup || '').trim();
  const dr = String(opts.dropoff || pu).trim();
  const toDropoff = Boolean(opts.toDropoff);
  const target = String(opts.navTarget || (toDropoff ? dr : pu)).trim() || pu || dr;
  const origin = opts.routedOrigin;
  const pickupGeo = opts.pickupGeo;
  const dropoffGeo = opts.dropoffGeo;
  const destGeo = opts.destGeo;
  const hasOrigin =
    origin &&
    Number.isFinite(Number(origin.lat)) &&
    Number.isFinite(Number(origin.lng)) &&
    isReliableGpsLatLng(origin.lat, origin.lng);

  if (hasOrigin && destGeo) {
    const leg = publicDirectionsCoordsMapUrlDriver(origin.lat, origin.lng, destGeo.lat, destGeo.lng);
    if (leg) return leg;
    const legAddr = publicDirectionsMapUrlDriver(`${origin.lat},${origin.lng}`, target);
    if (legAddr) return legAddr;
  }

  if (pickupGeo && dropoffGeo) {
    if (hasOrigin && !toDropoff) {
      const viaPickup = publicDirectionsCoordsMapUrlDriver(
        origin.lat,
        origin.lng,
        dropoffGeo.lat,
        dropoffGeo.lng,
        [[pickupGeo.lat, pickupGeo.lng]],
      );
      if (viaPickup) return viaPickup;
    }
    const full = publicDirectionsCoordsMapUrlDriver(pickupGeo.lat, pickupGeo.lng, dropoffGeo.lat, dropoffGeo.lng);
    if (full) return full;
  }

  if (pu && dr) {
    const route = publicDirectionsMapUrlDriver(pu, dr);
    if (route) return route;
  }

  if (target) {
    const place = publicPlaceMapUrlDriver(target);
    if (place) return place;
  }

  return publicViewMapUrlDriver(DRIVER_MAP_FALLBACK.lat, DRIVER_MAP_FALLBACK.lng, DRIVER_MAP_FALLBACK.zoom);
}

/**
 * Prefer `publicDirectionsMapUrl` in app code. These names match the Maps Embed API and
 * delegate to the same `public*` behavior (keyed embed, then `output=embed` fallback).
 */
export function mapsEmbedDirectionsUrl(origin, destination, waypoints = []) {
  return publicDirectionsMapUrl(origin, destination, waypoints);
}

export function mapsEmbedViewUrl(lat, lng, zoom = 13) {
  return publicViewMapUrl(lat, lng, zoom);
}

export function mapsEmbedPlaceUrl(query) {
  return publicPlaceMapUrl(query);
}

/** Opens full Google Maps turn-by-turn (works even when the embed iframe looks blank). */
export function googleMapsDirectionsAppUrl(origin, destination) {
  const o = String(origin || '').trim();
  const d = String(destination || '').trim();
  if (!o || !d) return '';
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&travelmode=driving`;
}

/** Directions from the user’s current location (Google picks origin) to one destination. */
export function googleMapsDirectionsDestOnlyUrl(destination) {
  const d = String(destination || '').trim();
  if (!d) return '';
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(d)}&travelmode=driving`;
}
