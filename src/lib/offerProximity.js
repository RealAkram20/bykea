/**
 * Driver-side proximity for offers, with no schema change (decision 2026-09-03).
 *
 * Bookings store the pickup as text only. The distance a driver sees is computed
 * at use: the pickup address is geocoded once through the existing
 * `places-geocode` edge function, cached, and measured against the driver's live
 * fix with the same haversine the customer side uses. When the pickup cannot be
 * located there is no distance — the screen says so rather than inventing one.
 */
import { useEffect, useRef, useState } from 'react';
import { forwardGeocodeAddress } from './reverseGeocode';
import { haversineKm } from './routeEstimate';
import { isReliableGpsLatLng } from './googleMapsConfig';

const CACHE_KEY = 'ingo_pickup_geo_v1';
/** A street address does not move; a week is generous and keeps the cache small. */
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed lookup is retried after ten minutes, not on every poll. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

/** @type {Map<string, { lat?: number, lng?: number, miss?: boolean, ts: number }>} */
const memory = new Map();
/** @type {Map<string, Promise<{ lat: number, lng: number } | null>>} */
const inflight = new Map();
let loaded = false;

/** Lower-case, single-spaced, without a trailing "(Shop name)" the shop offers append. */
export function normalizeAddress(address) {
  return String(address || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Accepts the shapes the geocode helpers return; null when there is no usable point. */
export function pointFromGeocode(res) {
  if (!res || typeof res !== 'object') return null;
  const cands = [
    [res.lat, res.lng],
    [res.latitude, res.longitude],
    [res.location?.lat, res.location?.lng],
    [res.geometry?.location?.lat, res.geometry?.location?.lng],
  ];
  for (const [la, lo] of cands) {
    const lat = typeof la === 'function' ? la() : la;
    const lng = typeof lo === 'function' ? lo() : lo;
    if (isReliableGpsLatLng(lat, lng)) return { lat: Number(lat), lng: Number(lng) };
  }
  return null;
}

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === 'object' && Number.isFinite(Number(v.ts))) memory.set(k, v);
      }
    }
  } catch {
    /* a corrupt cache is an empty cache */
  }
}

function saveCache() {
  try {
    if (typeof localStorage === 'undefined') return;
    // Newest last; drop the oldest beyond the cap.
    const entries = [...memory.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(-MAX_ENTRIES);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage full or unavailable: memory cache still works this session */
  }
}

/** Test seam. */
export function _resetProximityCache() {
  memory.clear();
  inflight.clear();
  loaded = false;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The pickup's coordinates, geocoded once and cached, or null.
 * @param {string} address
 * @param {(q: string) => Promise<unknown>} [geocoder] injected in tests
 * @returns {Promise<{ lat: number, lng: number } | null>}
 */
export async function geocodePickupCached(address, geocoder = forwardGeocodeAddress) {
  const key = normalizeAddress(address);
  if (!key || key === '—') return null;
  loadCache();
  const hit = memory.get(key);
  const now = Date.now();
  if (hit) {
    if (hit.miss && now - hit.ts < NEGATIVE_TTL_MS) return null;
    if (!hit.miss && now - hit.ts < POSITIVE_TTL_MS && isReliableGpsLatLng(hit.lat, hit.lng)) {
      return { lat: hit.lat, lng: hit.lng };
    }
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    let point = null;
    try {
      point = pointFromGeocode(await geocoder(key));
    } catch {
      point = null;
    }
    memory.set(key, point ? { lat: point.lat, lng: point.lng, ts: Date.now() } : { miss: true, ts: Date.now() });
    saveCache();
    inflight.delete(key);
    return point;
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Beyond this a "distance to pickup" is not a distance, it is a geocoder that
 * matched the wrong place: a country-biased lookup of "Stratford, London E15"
 * landed in Zimbabwe and a driver in Kampala was told the pickup was 2193 km
 * away (2026-09-06). The sender's own radius is 20 km; nothing legitimate is
 * hundreds of km off. Unknown is the honest answer, and the screen says so.
 */
export const MAX_PLAUSIBLE_PICKUP_KM = 500;

/** Km between two points, or null when either is unusable or the result is implausible. */
export function distanceKm(from, to) {
  if (!from || !to) return null;
  if (!isReliableGpsLatLng(from.lat, from.lng) || !isReliableGpsLatLng(to.lat, to.lng)) return null;
  const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
  if (!Number.isFinite(km)) return null;
  return km > MAX_PLAUSIBLE_PICKUP_KM ? null : km;
}

/** "850 m", "1.2 km", "12 km"; '' when unknown. Never rounds an unknown to zero. */
export function formatDistanceKm(km) {
  if (km == null || !Number.isFinite(km) || km < 0) return '';
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** Nearest first; offers with no distance keep their existing order after the known ones. */
export function sortOffersByDistance(offers, distances) {
  const keyOf = (o) => `${o.table}:${o.id}`;
  return [...offers]
    .map((o, i) => ({ o, i, d: distances?.get?.(keyOf(o)) ?? null }))
    .sort((a, b) => {
      if (a.d == null && b.d == null) return a.i - b.i;
      if (a.d == null) return 1;
      if (b.d == null) return -1;
      return a.d - b.d || a.i - b.i;
    })
    .map((x) => x.o);
}

/**
 * Distances from the driver to each offer's pickup, resolving geocodes as they
 * land. `distances` maps `table:id` → km or null (unknown); `pending` is true
 * while any lookup is still running.
 * @param {Array<{ table: string, id: string, from?: string }>} offers
 * @param {{ lat: number, lng: number } | null | undefined} driverPos
 */
export function useOfferDistances(offers, driverPos) {
  const [points, setPoints] = useState(() => new Map());
  const [pendingCount, setPendingCount] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const keys = offers.map((o) => `${o.table}:${o.id}`).join('|');
  useEffect(() => {
    let cancelled = false;
    const todo = offers.filter((o) => !points.has(`${o.table}:${o.id}`));
    if (!todo.length) return undefined;
    setPendingCount((n) => n + todo.length);
    const settle = (k, pt) => {
      if (cancelled || !alive.current) return;
      setPoints((prev) => {
        const next = new Map(prev);
        next.set(k, pt);
        return next;
      });
      setPendingCount((n) => Math.max(0, n - 1));
    };
    todo.forEach((o) => {
      const k = `${o.table}:${o.id}`;
      void geocodePickupCached(o.from).then((pt) => settle(k, pt));
    });
    return () => {
      cancelled = true;
    };
    // `keys` is the identity of the offer list; `points` is read, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  const distances = new Map();
  for (const o of offers) {
    const k = `${o.table}:${o.id}`;
    distances.set(k, distanceKm(driverPos, points.get(k) || null));
  }
  return { distances, pending: pendingCount > 0 };
}
