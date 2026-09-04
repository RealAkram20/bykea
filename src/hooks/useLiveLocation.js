import { useCallback, useEffect, useRef, useState } from 'react';
import { readDeviceGpsPosition } from '../lib/devicePickupLocation';
import {
  GEO_CACHE_MAX_AGE_MS,
  isAcceptableDeviceFix,
  isReliableGpsLatLng,
} from '../lib/googleMapsConfig';
import { whenMedianGeolocationReady } from '../lib/medianGeolocation';

const GEO_LOG = '[geolocation]';

const LAST_FIX_KEY = 'ingo_last_geo_fix_v2';

function clearCachedFix() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(LAST_FIX_KEY);
    localStorage.removeItem('ingo_last_geo_fix');
  } catch {
    // ignore
  }
}

function readCachedFix() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LAST_FIX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const lat = Number(parsed?.lat);
    const lng = Number(parsed?.lng);
    const ts = Number(parsed?.ts);
    if (!isAcceptableDeviceFix(lat, lng)) {
      clearCachedFix();
      return null;
    }
    if (!Number.isFinite(ts) || Date.now() - ts > GEO_CACHE_MAX_AGE_MS) {
      clearCachedFix();
      return null;
    }
    return { lat, lng, ts };
  } catch {
    return null;
  }
}

function saveCachedFix(lat, lng) {
  if (!isAcceptableDeviceFix(lat, lng)) return;
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat, lng, ts: Date.now() }));
  } catch {
    // ignore
  }
}

/** ~meters between two WGS84 points (good enough for “did we move?”). */
function metersApart(a, b) {
  if (!a || !b) return Infinity;
  const la = Number(a.lat);
  const lo = Number(a.lng);
  const lb = Number(b.lat);
  const ln = Number(b.lng);
  if (![la, lo, lb, ln].every(Number.isFinite)) return Infinity;
  const R = 6371000;
  const dLat = ((lb - la) * Math.PI) / 180;
  const dLng = ((ln - lo) * Math.PI) / 180;
  const m =
    dLat * dLat +
    Math.cos((la * Math.PI) / 180) * Math.cos((lb * Math.PI) / 180) * dLng * dLng;
  return R * Math.sqrt(Math.max(0, m));
}

/**
 * Live geolocation + optional compass heading for map overlays.
 * `mapCenter` only updates on first fix, forced refresh, or meaningful movement
 * (throttled while moving). Time alone must not refresh embeds — that reloads
 * iframes endlessly while a rider is stationary.
 *
 * `refreshFromUserGesture()` — call from a click handler (e.g. “Use my current location”).
 * Updates lat/lng/map immediately; helps installed PWAs / iOS where watch-only is slow.
 */
/** The last fix this device stored (any page), or null. For screens that have no watch of their own. */
export function readLastDeviceFix() {
  const c = readCachedFix();
  return c ? { lat: c.lat, lng: c.lng } : null;
}

export function useLiveLocation(options = {}) {
  const throttleMs = options.mapThrottleMs ?? 4000;
  const movePublishM = options.movePublishMeters ?? 55;
  const [lat, setLat] = useState(() => readCachedFix()?.lat ?? null);
  const [lng, setLng] = useState(() => readCachedFix()?.lng ?? null);
  const [accuracy, setAccuracy] = useState(null);
  const [mapCenter, setMapCenter] = useState(() => {
    const fix = readCachedFix();
    return fix ? { lat: fix.lat, lng: fix.lng } : null;
  });
  const [headingDeg, setHeadingDeg] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const lastMapTick = useRef(0); /* 0 => first fix always updates map center */
  const lastPublishedMapCenterRef = useRef(null);
  const gpsHeadingRef = useRef(null);
  const refreshInFlightRef = useRef(null);

  const ingestPosition = useCallback(
    (position, opts = {}) => {
      const { forceMapUpdate = false } = opts;
      const { latitude, longitude, heading, accuracy: acc } = position.coords;
      if (!isReliableGpsLatLng(latitude, longitude)) {
        return false;
      }
      if (!isAcceptableDeviceFix(latitude, longitude)) {
        console.warn(`${GEO_LOG} ignoring unusable fix`, {
          lat: latitude,
          lng: longitude,
          accuracy: acc,
        });
        return false;
      }
      setGeoError(null);
      setLat(latitude);
      setLng(longitude);
      setAccuracy(typeof acc === 'number' ? acc : null);
      saveCachedFix(latitude, longitude);
      if (typeof heading === 'number' && !Number.isNaN(heading) && heading >= 0) {
        gpsHeadingRef.current = heading;
        setHeadingDeg(heading);
      } else {
        gpsHeadingRef.current = null;
      }
      const nextCenter = { lat: latitude, lng: longitude };
      const now = Date.now();
      const prev = lastPublishedMapCenterRef.current;
      const firstFix = prev == null;
      const movedEnough = firstFix || metersApart(prev, nextCenter) >= movePublishM;
      // Never refresh the map on a timer alone — that reloads embed iframes endlessly while idle.
      // Update only on first fix, user force, or meaningful movement (with throttle while moving).
      const dueByTime = now - lastMapTick.current >= throttleMs;
      if (forceMapUpdate || firstFix || (movedEnough && dueByTime)) {
        lastMapTick.current = now;
        lastPublishedMapCenterRef.current = nextCenter;
        setMapCenter(nextCenter);
      }
      return true;
    },
    [throttleMs, movePublishM],
  );

  const refreshFromUserGesture = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      const e = new Error('unsupported');
      e.code = 0;
      setGeoError('unsupported');
      throw e;
    }
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }
    const run = (async () => {
      try {
        const pos = await readDeviceGpsPosition({ interactive: true });
        const ok = ingestPosition(pos, { forceMapUpdate: true });
        if (!ok) {
          setGeoError('out_of_area');
          const e = new Error('out_of_area');
          e.code = 4;
          throw e;
        }
        setGeoError(null);
        return pos.coords;
      } catch (err) {
        const code = typeof err?.code === 'number' ? err.code : 2;
        if (code === 1) setGeoError('denied');
        else if (code === 4) setGeoError('out_of_area');
        else if (code === 0) setGeoError('unsupported');
        else setGeoError('unavailable');
        throw err;
      } finally {
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = run;
    return run;
  }, [ingestPosition]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoError('unsupported');
      return undefined;
    }
    let cancelled = false;
    let watchId = null;
    (async () => {
      try {
        await whenMedianGeolocationReady();
        if (cancelled || !navigator.geolocation) return;
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            ingestPosition(pos, { forceMapUpdate: false });
          },
          (err) => {
            console.error(`${GEO_LOG} watchPosition error`, {
              code: err.code,
              message: err.message,
            });
            // Don't overwrite a successful fix with a later watch timeout.
            setGeoError((prev) => {
              if (prev === 'denied') return prev;
              return err.code === 1 ? 'denied' : prev || 'unavailable';
            });
          },
          {
            enableHighAccuracy: true,
            maximumAge: 15_000,
            timeout: 25_000,
          },
        );
        console.log(`${GEO_LOG} watchPosition started`);
      } catch (e) {
        console.error(`${GEO_LOG} watchPosition setup failed`, e);
        setGeoError((prev) => prev || 'unavailable');
      }
    })();
    return () => {
      cancelled = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, [ingestPosition]);

  /** Soft background refresh only — never compete with the Allow-location button. */
  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    let cancelled = false;
    readDeviceGpsPosition()
      .then((pos) => {
        if (!cancelled) ingestPosition(pos, { forceMapUpdate: true });
      })
      .catch(() => {
        /* watch / Allow button may still deliver */
      });
    return () => {
      cancelled = true;
    };
  }, [ingestPosition]);

  /** User left the tab or closed laptop, then came back — re-read real position. */
  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      readDeviceGpsPosition()
        .then((pos) => {
          ingestPosition(pos, { forceMapUpdate: true });
        })
        .catch(() => {});
    };
    const onPageShow = (e) => {
      if (e.persisted) onVisible();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [ingestPosition]);

  useEffect(() => {
    if (!navigator.permissions?.query) return undefined;
    let perm;
    const onChange = () => {
      if (perm && perm.state === 'granted') {
        refreshFromUserGesture().catch(() => {});
      }
    };
    let cancelled = false;
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((p) => {
        if (cancelled) return;
        perm = p;
        p.addEventListener('change', onChange);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (perm) perm.removeEventListener('change', onChange);
    };
  }, [refreshFromUserGesture]);

  useEffect(() => {
    const onOrient = (e) => {
      if (gpsHeadingRef.current != null) return;
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
        setHeadingDeg(e.webkitCompassHeading);
        return;
      }
      if (e.absolute && typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
        setHeadingDeg((360 - e.alpha + 360) % 360);
      }
    };
    window.addEventListener('deviceorientation', onOrient, true);
    return () => window.removeEventListener('deviceorientation', onOrient, true);
  }, []);

  return {
    lat,
    lng,
    accuracy,
    mapCenter,
    headingDeg,
    geoError,
    hasFix: lat != null && lng != null,
    refreshFromUserGesture,
  };
}
