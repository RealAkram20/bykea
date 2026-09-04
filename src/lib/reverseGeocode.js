import { getGoogleMapsApiKey } from './googleMapsConfig';
import { isSupabaseConfigured, supabase } from './supabaseClient';

/**
 * Country bias for address search and geocoding (ISO 3166-1 alpha-2).
 * Defaults to Zimbabwe, the client's market. Set REACT_APP_ADDRESS_COUNTRY (e.g.
 * `ug`) for a build tested elsewhere; since 2026-09-03 the device fix itself is
 * trusted anywhere, and this is the only remaining country assumption.
 */
const ADDRESS_COUNTRY_CODE = String(process.env.REACT_APP_ADDRESS_COUNTRY || 'zw').trim().toLowerCase() || 'zw';

/** Logs once per function name per tab when Edge returns OK (verify wiring without spamming autocomplete). */
const mapsEdgeVerifiedLogged = new Set();

/**
 * Internal — calls Supabase Edge map functions by name.
 * Used by: `fetchAddressAutocompleteSuggestions` → Edge **`places-autocomplete`**;
 * `forwardGeocodeAddress` / `reverseGeocodeLatLng` → Edge **`places-geocode`**.
 *
 * @param {string} functionName
 * @param {Record<string, unknown>} body
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function invokeMapsEdge(functionName, body) {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const { data, error } = await supabase.functions.invoke(functionName, { body });
    if (error) {
      console.warn(`[Bykea maps Edge] ${functionName} failed`, error.message || String(error));
      return null;
    }
    if (data && typeof data === 'object') {
      if (!mapsEdgeVerifiedLogged.has(functionName)) {
        mapsEdgeVerifiedLogged.add(functionName);
        // eslint-disable-next-line no-console
        console.info(
          `[Bykea maps Edge] ${functionName} — response from Supabase Edge (first OK in this tab; further calls are silent)`,
        );
      }
      return /** @type {Record<string, unknown>} */ (data);
    }
    return null;
  } catch (e) {
    console.warn(`[Bykea maps Edge] ${functionName} invoke threw`, e);
    return null;
  }
}

/** True when a Google geocode result is in the configured country (or carries no country at all). */
function isGoogleGeocodeZimbabwe(result) {
  const comps = result?.address_components;
  if (!Array.isArray(comps)) return true;
  const country = comps.find((c) => Array.isArray(c.types) && c.types.includes('country'));
  if (!country) return true;
  return String(country.short_name || '').toLowerCase() === ADDRESS_COUNTRY_CODE;
}

/** Country-only / too-coarse labels we must not use as pickup. */
function isCoarsePlaceLabel(line) {
  const s = String(line || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!s) return true;
  if (s === 'zimbabwe' || s === 'zw') return true;
  // "Zimbabwe" with nothing more specific
  if (/^zimbabwe(\s*,\s*africa)?$/i.test(s)) return true;
  return false;
}

/**
 * Unrecognised / unhelpful reverse-geocode labels common in gated communities in ZW.
 * Prefer a nearby named suburb / landmark instead (inDrive-style).
 */
export function isUnrecognizedPlaceLabel(line) {
  const s = String(line || '').trim();
  if (!s || isCoarsePlaceLabel(s)) return true;
  const lower = s.toLowerCase();
  // "Unnamed Road, Zimbabwe" / "Unnamed Street" / "Unnamed Road"
  if (/\bunnamed\b/i.test(s)) return true;
  // Plus codes alone (e.g. "5G8F+XX Zimbabwe") — not human-usable for dispatch
  if (/^[a-z0-9]{4,}\+[a-z0-9]{2,}\b/i.test(s) && !/,/.test(s.split('+')[0] || '')) {
    const withoutPlus = s.replace(/^[a-z0-9+]+\s*,?\s*/i, '').trim();
    if (!withoutPlus || isCoarsePlaceLabel(withoutPlus)) return true;
  }
  if (/^[a-z0-9]{4,}\+[a-z0-9]{2,}(\s*,\s*zimbabwe)?$/i.test(lower)) return true;
  // Bare "Road" / "Street" with no name
  if (/^(road|street|avenue|drive|lane|close|way)(\s*,\s*zimbabwe)?$/i.test(lower)) return true;
  return false;
}

function isUnnamedRoadToken(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  return /\bunnamed\b/i.test(s) || /^(road|street|avenue|drive|lane|close|way)$/i.test(s);
}

/**
 * Score Google Geocode results — higher = better for a pickup pin.
 * @param {Record<string, unknown>} result
 */
function googleResultSpecificityScore(result) {
  const types = Array.isArray(result?.types) ? result.types.map(String) : [];
  if (types.includes('street_address') || types.includes('premise') || types.includes('subpremise')) return 100;
  if (types.includes('route') || types.includes('intersection')) return 80;
  if (types.includes('neighborhood') || types.includes('sublocality') || types.includes('sublocality_level_1')) return 60;
  if (types.includes('locality') || types.includes('postal_town')) return 40;
  if (types.includes('administrative_area_level_2')) return 25;
  if (types.includes('administrative_area_level_1')) return 10;
  if (types.includes('country')) return 0;
  return 30;
}

/**
 * Build a street-ish line from address_components when formatted_address is coarse.
 * Skips "Unnamed Road" and similar — falls back to neighbourhood / suburb / locality
 * so gated communities still get a recognisable dispatch label.
 * @param {Record<string, unknown>} result
 */
function formatGoogleResultLine(result) {
  const comps = Array.isArray(result?.address_components) ? result.address_components : [];
  const byType = (t) => {
    const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(t));
    return c ? String(c.long_name || c.short_name || '').trim() : '';
  };
  const streetNum = byType('street_number');
  const routeRaw = byType('route');
  const route = isUnnamedRoadToken(routeRaw) ? '' : routeRaw;
  const premise = byType('premise') || byType('establishment') || byType('point_of_interest');
  const neighborhood =
    byType('neighborhood') ||
    byType('sublocality_level_1') ||
    byType('sublocality') ||
    byType('sublocality_level_2');
  const locality =
    byType('locality') || byType('postal_town') || byType('administrative_area_level_2');

  const line1 =
    [streetNum, route].filter(Boolean).join(' ').trim() ||
    (premise && !isUnnamedRoadToken(premise) ? premise : '');
  const parts = [line1, neighborhood, locality].filter((p) => p && !isUnnamedRoadToken(p));
  const built = parts.join(', ').trim();
  if (built && !isUnrecognizedPlaceLabel(built)) return built;

  // Neighbourhood-only is still useful for riders (e.g. "Borrowdale, Harare")
  const areaOnly = [neighborhood, locality].filter((p) => p && !isUnnamedRoadToken(p)).join(', ').trim();
  if (areaOnly && !isUnrecognizedPlaceLabel(areaOnly)) return areaOnly;

  const formatted = String(result?.formatted_address || '').trim();
  if (formatted && !isUnrecognizedPlaceLabel(formatted)) return formatted;
  return '';
}

/**
 * Internal — parses best street-level `formatted_address` from a Google Geocode JSON payload.
 * Used by: **`reverseGeocodeLatLng`** only.
 *
 * @param {Record<string, unknown> | null} data
 */
function parseGeocodeFirstFormattedAddress(data) {
  if (!data || typeof data !== 'object') return '';
  const st = String(data.status || '');
  if (st !== 'OK' || !Array.isArray(data.results) || !data.results.length) return '';

  const zwResults = data.results.filter((r) => isGoogleGeocodeZimbabwe(r));
  const pool = zwResults.length ? zwResults : data.results;
  const ranked = [...pool].sort(
    (a, b) => googleResultSpecificityScore(b) - googleResultSpecificityScore(a),
  );

  for (const result of ranked) {
    const line = formatGoogleResultLine(result);
    if (line && !isUnrecognizedPlaceLabel(line)) return line;
  }
  return '';
}

/**
 * Internal — parses first `geometry.location` from a Google Geocode JSON payload (from Edge **`places-geocode`** or browser fallback).
 * Used by: **`forwardGeocodeAddress`** only.
 *
 * @param {Record<string, unknown> | null} data
 */
function parseGeocodeFirstLatLng(data) {
  if (!data || typeof data !== 'object') return null;
  const st = String(data.status || '');
  if (st !== 'OK' || !Array.isArray(data.results) || !data.results.length) return null;
  const first = data.results[0];
  if (!isGoogleGeocodeZimbabwe(first)) return null;
  const loc = first?.geometry?.location;
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

const NOMINATIM_DELAY_MS = 600;
let nominatimLastAt = 0;

/**
 * Internal — rate-limits OpenStreetMap Nominatim (public etiquette).
 * Used by: **`fetchAddressAutocompleteSuggestions`** only (before OSM search).
 */
async function nominatimThrottle() {
  const now = Date.now();
  const wait = nominatimLastAt + NOMINATIM_DELAY_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nominatimLastAt = Date.now();
}

/**
 * @typedef {{ id: string, label: string }} AddressSuggestion
 */

/**
 * Internal — one Nominatim search hit → single-line label for dropdowns.
 * Used by: **`fetchAddressAutocompleteSuggestions`** (OSM path only).
 */
/**
 * True when a Nominatim hit is in the configured country. Needs `addressdetails=1`
 * on the request: without it `hit.address` is absent and every hit was rejected,
 * which is why the forward-geocode fallback had never returned a point
 * (found 2026-09-03 while adding driver-side proximity).
 */
function isNominatimZimbabwe(hit) {
  const code = String(hit?.address?.country_code || '').trim().toLowerCase();
  if (code) return code === ADDRESS_COUNTRY_CODE;
  return /zimbabwe/i.test(String(hit?.address?.country || '')) && ADDRESS_COUNTRY_CODE === 'zw';
}

function formatNominatimLabel(hit) {
  const a = hit.address || {};
  const numName = [a.house_number, a.house_name, a.building].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const roadRaw = a.road || a.pedestrian || a.path || a.residential || '';
  const road = isUnnamedRoadToken(roadRaw) ? '' : roadRaw;
  let line1 = [numName, road].filter(Boolean).join(' ').trim();
  if (!line1 && a.shop && !isUnnamedRoadToken(a.shop)) {
    line1 = [a.shop, road].filter(Boolean).join(', ').trim();
  }
  if (!line1 && a.amenity && !isUnnamedRoadToken(a.amenity)) {
    line1 = road ? `${a.amenity}, ${road}` : String(a.amenity);
  }
  const suburb = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.residential;
  const parts = [
    line1,
    suburb && !isUnnamedRoadToken(suburb) ? suburb : '',
    a.city || a.town || a.village || a.hamlet,
    a.postcode,
  ].filter(Boolean);
  if (parts.length) {
    const label = parts.join(', ');
    if (!isUnrecognizedPlaceLabel(label)) return label;
  }
  // Suburb + city alone when road is unnamed (gated communities).
  const areaOnly = [suburb, a.city || a.town || a.village || a.hamlet].filter((p) => p && !isUnnamedRoadToken(p)).join(', ');
  if (areaOnly && !isUnrecognizedPlaceLabel(areaOnly)) return areaOnly;
  const dn = String(hit.display_name || '').trim();
  if (!dn || isUnrecognizedPlaceLabel(dn)) return '';
  return dn
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !/^zimbabwe$/i.test(p) && !isUnnamedRoadToken(p))
    .slice(0, 4)
    .join(', ');
}

/**
 * Internal — sorts OSM hits when the user typed a house number.
 * Used by: **`fetchAddressAutocompleteSuggestions`** (OSM path only).
 */
function rankNominatimHits(hits, query) {
  const q = String(query || '').trim();
  const wantsNumber = /\d/.test(q);
  if (!wantsNumber || !Array.isArray(hits)) return hits;
  return [...hits].sort((a, b) => {
    const ah = a.address?.house_number ? 1 : 0;
    const bh = b.address?.house_number ? 1 : 0;
    if (bh !== ah) return bh - ah;
    const ab = a.address?.building ? 1 : 0;
    const bb = b.address?.building ? 1 : 0;
    return bb - ab;
  });
}

/**
 * Internal — display string for one Google Places Autocomplete prediction (from Edge **`places-autocomplete`**).
 * Used by: **`fetchAddressAutocompleteSuggestions`** only.
 */
function googleAutocompleteLabel(p) {
  const desc = String(p.description || '').trim();
  const sf = p.structured_formatting;
  const main = sf && typeof sf.main_text === 'string' ? sf.main_text.trim() : '';
  const sec = sf && typeof sf.secondary_text === 'string' ? sf.secondary_text.trim() : '';
  const composed = [main, sec].filter(Boolean).join(', ');
  if (desc && composed && desc.length > composed.length + 8) return desc;
  if (desc) return desc;
  return composed;
}

/**
 * Internal — sorts Google predictions when the user typed digits (prefer street_address / premise).
 * Used by: **`fetchAddressAutocompleteSuggestions`** only.
 */
function rankGooglePredictions(preds, query) {
  const q = String(query || '').trim();
  const wantsNumber = /\d/.test(q);
  if (!wantsNumber || !Array.isArray(preds)) return preds;
  const score = (p) => {
    const t = Array.isArray(p.types) ? p.types : [];
    if (t.includes('street_address') || t.includes('premise') || t.includes('subpremise')) return 3;
    if (t.includes('route')) return 0;
    if (t.includes('geocode')) return 1;
    return 2;
  };
  return [...preds].sort((a, b) => score(b) - score(a));
}

/**
 * **Address typeahead** — pickup / destination search boxes.
 * Edge: **`places-autocomplete`**. UI: **`AddressSuggestInput`** → used on **`/request-delivery`**, **`/book-ride`**, etc.
 * Prefer Google via Edge. If Places is denied/broken (e.g. billing), fall back to Nominatim.
 * Skip OSM only when Google returned a clean ZERO_RESULTS / empty OK.
 *
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<AddressSuggestion[]>}
 */
export async function fetchAddressAutocompleteSuggestions(query, options = {}) {
  const limit = Math.min(8, Math.max(1, Number(options.limit) || 5));
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const lang = String(process.env.REACT_APP_GOOGLE_PLACES_LANGUAGE || 'en').trim() || 'en';
  const country = ADDRESS_COUNTRY_CODE;

  const digitQuery = /\d/.test(q);
  const attempts = digitQuery ? [false, true] : [false];

  let googleDeniedOrBroken = false;

  for (const typesAddress of attempts) {
    const payload = { input: q, language: lang, country, typesAddress };

    const data = await invokeMapsEdge('places-autocomplete', payload);

    if (data == null || typeof data !== 'object') {
      googleDeniedOrBroken = true;
      continue;
    }

    if (data.error && !Array.isArray(data.predictions)) {
      console.warn('[addressSuggest]', data.error, data.hint || '');
      googleDeniedOrBroken = true;
      continue;
    }

    const st = String(data.status || '');
    if (st !== 'OK' && st !== 'ZERO_RESULTS') {
      if (st && st !== 'INVALID_REQUEST') {
        console.warn('[addressSuggest] Places', st, data.error_message || '');
      }
      // Billing / key / API not enabled → do not treat as empty; fall through to OSM.
      if (st === 'REQUEST_DENIED' || st === 'OVER_QUERY_LIMIT' || st === 'UNKNOWN_ERROR') {
        googleDeniedOrBroken = true;
      }
      continue;
    }

    let preds = Array.isArray(data.predictions) ? data.predictions : [];
    preds = rankGooglePredictions(preds, q);
    const mapped = preds.slice(0, limit).map((p) => ({
      id: String(p.place_id || p.description),
      label: googleAutocompleteLabel(p),
    }));
    if (mapped.length) return mapped;
  }

  // Skip OSM only when Google responded cleanly with zero hits (not when Edge/billing failed).
  if (getGoogleMapsApiKey() && !googleDeniedOrBroken) {
    return [];
  }

  try {
    await nominatimThrottle();
    const fetchLimit = /\d/.test(q) ? Math.min(12, limit + 5) : limit;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${fetchLimit}&addressdetails=1&countrycodes=${ADDRESS_COUNTRY_CODE}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const ranked = rankNominatimHits(data, q).filter(isNominatimZimbabwe);
    return ranked
      .slice(0, limit)
      .map((hit, i) => {
        const label = formatNominatimLabel(hit);
        if (!label) return null;
        const id = hit.place_id != null ? `osm-${hit.place_id}` : `osm-${i}-${hit.lat}-${hit.lon}`;
        const lat = parseFloat(hit.lat);
        const lng = parseFloat(hit.lon);
        const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
        return {
          id: String(id),
          label,
          ...(hasCoords ? { lat, lng } : null),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * **GPS → readable address** (e.g. device location label).
 * Edge: **`places-geocode`** (`latlng`). Callers: **`devicePickupLocation.js`**, customer/driver flows that show “you are here” text.
 * Fallback: browser Geocoding if key set, else Nominatim.
 * If the pin sits on an unrecognised / unnamed road (common in gated communities),
 * prefer the nearest named neighbourhood, landmark, or suburb — like inDrive.
 */
export async function reverseGeocodeLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return '';
  }

  const lang = String(process.env.REACT_APP_GOOGLE_PLACES_LANGUAGE || 'en').trim() || 'en';
  const edgePayload = await invokeMapsEdge('places-geocode', {
    latlng: `${lat},${lng}`,
    language: lang,
    country: ADDRESS_COUNTRY_CODE,
  });
  const edgeLine = parseGeocodeFirstFormattedAddress(edgePayload);
  if (edgeLine && !isUnrecognizedPlaceLabel(edgeLine)) return edgeLine;

  // Nearest named place (POI / establishment) when reverse only has "Unnamed Road".
  const nearbyLine = parseNearbyPlaceLabel(
    await invokeMapsEdge('places-geocode', {
      latlng: `${lat},${lng}`,
      language: lang,
      country: ADDRESS_COUNTRY_CODE,
      nearby: true,
    }),
  );
  if (nearbyLine && !isUnrecognizedPlaceLabel(nearbyLine)) return nearbyLine;

  const key = getGoogleMapsApiKey();
  if (key) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(`${lat},${lng}`)}&key=${encodeURIComponent(key)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const line = parseGeocodeFirstFormattedAddress(data);
        if (line && !isUnrecognizedPlaceLabel(line)) return line;
      }
    } catch {
      // fall through to Nominatim
    }
  }

  // Progressive Nominatim zoom: street → neighbourhood → suburb/city (named areas).
  for (const zoom of [18, 16, 14, 12]) {
    try {
      await nominatimThrottle();
      const url =
        `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(String(lat))}` +
        `&lon=${encodeURIComponent(String(lng))}&format=json&addressdetails=1&zoom=${zoom}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!isNominatimZimbabwe(data)) continue;
      const labeled = formatNominatimLabel(data);
      if (labeled && !isUnrecognizedPlaceLabel(labeled)) return labeled;
    } catch {
      // try next zoom
    }
  }

  return '';
}

/**
 * Parse Places Nearby Search response from Edge `places-geocode` `{ nearby: true }`.
 * @param {Record<string, unknown> | null} data
 */
function parseNearbyPlaceLabel(data) {
  if (!data || typeof data !== 'object') return '';
  const st = String(data.status || '');
  if (st !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    // Edge may return `{ place: { name, vicinity } }` shape
    const place = data.place && typeof data.place === 'object' ? data.place : null;
    if (place) {
      const name = String(place.name || '').trim();
      const vicinity = String(place.vicinity || place.formatted_address || '').trim();
      const line = [name, vicinity].filter((p) => p && !isUnrecognizedPlaceLabel(p)).join(', ');
      if (line && !isUnrecognizedPlaceLabel(line)) return line;
      if (name && !isUnrecognizedPlaceLabel(name)) return name;
    }
    return '';
  }

  for (const r of data.results) {
    const name = String(r?.name || '').trim();
    const vicinity = String(r?.vicinity || r?.formatted_address || '').trim();
    if (name && isUnrecognizedPlaceLabel(name)) continue;
    if (name && vicinity && !isUnrecognizedPlaceLabel(vicinity)) {
      // Avoid "Shop Name, Shop Name, Harare" duplication
      if (vicinity.toLowerCase().startsWith(name.toLowerCase())) return vicinity;
      return `${name}, ${vicinity}`;
    }
    if (name && !isUnrecognizedPlaceLabel(name)) return name;
    if (vicinity && !isUnrecognizedPlaceLabel(vicinity)) return vicinity;
  }
  return '';
}

/**
 * **Typed address → map coordinates** (route pins, distance, navigation).
 * Edge: **`places-geocode`** (`address`). Callers: **`TaxiBookingPage`**, **`RequestDeliveryPage`**, **`LiveTrackingPage`**, **`DriverActiveDeliveryPage`**, **`DriverNavigationPage`**, etc.
 * Fallback: browser Geocoding if key set, else Nominatim.
 *
 * @param {string} query
 * @returns {Promise<{ lat: number, lng: number } | null>}
 */
export async function forwardGeocodeAddress(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  // Country-only queries resolve to a national centroid — useless for routes.
  if (/^zimbabwe(\s*,\s*africa)?$/i.test(q) || /^zw$/i.test(q)) return null;
  // "Unnamed Road" forward-geocodes unpredictably and caused ~300km fake distances.
  if (isUnrecognizedPlaceLabel(q)) return null;

  // "lat, lng" from GPS fallback — use exact coordinates (no geocode round-trip).
  const coordMatch = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coordMatch) {
    const lat = Number(coordMatch[1]);
    const lng = Number(coordMatch[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }

  const country = ADDRESS_COUNTRY_CODE;
  const lang = String(process.env.REACT_APP_GOOGLE_PLACES_LANGUAGE || 'en').trim() || 'en';

  const edgePt = parseGeocodeFirstLatLng(
    await invokeMapsEdge('places-geocode', {
      address: q,
      language: lang,
      country,
    }),
  );
  if (edgePt) return edgePt;

  const key = getGoogleMapsApiKey();
  if (key) {
    try {
      const params = new URLSearchParams({
        address: q,
        key,
      });
      if (country) {
        params.set('components', `country:${country}`);
      }
      if (lang) params.set('language', lang);

      const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const st = String(data.status || '');
      if (st !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
        if (st && st !== 'ZERO_RESULTS') {
          console.warn('[forwardGeocode] Geocoding API', st, data.error_message || '');
        }
        return null;
      }
      const loc = data.results[0]?.geometry?.location;
      if (!isGoogleGeocodeZimbabwe(data.results[0])) return null;
      const lat = Number(loc?.lat);
      const lng = Number(loc?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    } catch (e) {
      console.warn('[forwardGeocode] Google geocode failed', e);
      return null;
    }
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1&countrycodes=${ADDRESS_COUNTRY_CODE}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data?.find(isNominatimZimbabwe);
    if (!hit) return null;
    const lat = parseFloat(hit.lat);
    const lng = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}
