import { useCallback, useEffect, useRef, useState } from 'react';
import { readDeviceGpsPosition } from '../lib/devicePickupLocation';
import {
  GEO_CACHE_MAX_AGE_MS,
  isAcceptableDeviceFix,
  isReliableGpsLatLng,
} from '../lib/googleMapsConfig';
import { whenMedianGeolocationReady } from '../lib/medianGeolocation';
import {
  getLocationPermission,
  isNativeApp,
  requestLocationPermission,
  watchNativePosition,
} from '../lib/nativePermissions';

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
  /* Bumped when the driver grants location from the Allow button, so the native
     watch (which waits for the permission rather than prompting on mount) starts. */
  const [watchEpoch, setWatchEpoch] = useState(0);
  /* The OS permission as last read: 'granted' | 'coarse' | 'prompt' | 'denied' |
     'unknown', or null before the first read. On the native app this — not a
     cached coordinate — decides whether the driver must be asked. A fix cached
     from an earlier session used to count as "located" even after the permission
     had been revoked, so the prompt never came back (seen 2026-09-06). */
  const [permission, setPermission] = useState(null);
  const permissionRef = useRef(null);
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

  /**
   * Re-reads the OS permission. When it turns into a grant (the driver said yes
   * in the dialog, or came back from Settings) the native watch is started and a
   * fix is fetched without another tap.
   */
  const refreshPermission = useCallback(async () => {
    const next = await getLocationPermission();
    const prev = permissionRef.current;
    permissionRef.current = next;
    setPermission(next);
    const usable = (p) => p === 'granted' || p === 'coarse';
    if (isNativeApp() && usable(next) && !usable(prev)) {
      setWatchEpoch((n) => n + 1);
      readDeviceGpsPosition()
        .then((pos) => ingestPosition(pos, { forceMapUpdate: true }))
        .catch(() => {});
    }
    return next;
  }, [ingestPosition]);

  const refreshFromUserGesture = useCallback(async () => {
    if (!isNativeApp() && (typeof navigator === 'undefined' || !navigator.geolocation)) {
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
        if (isNativeApp()) {
          // Ask first, and the moment the answer is yes start the continuous watch
          // in parallel with the one-shot read below. A handset without a network
          // fix (the emulator; some phones indoors) times the low-power read out
          // before GPS is even asked; the watch has a fix by then. First one wins.
          const perm = await requestLocationPermission();
          permissionRef.current = perm;
          setPermission(perm);
          if (perm === 'granted' || perm === 'coarse') setWatchEpoch((n) => n + 1);
        }
        const pos = await readDeviceGpsPosition({ interactive: true });
        const ok = ingestPosition(pos, { forceMapUpdate: true });
        if (!ok) {
          setGeoError('out_of_area');
          const e = new Error('out_of_area');
          e.code = 4;
          throw e;
        }
        setGeoError(null);
        setWatchEpoch((n) => n + 1);
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
        // Whatever happened in the dialog, the permission row must say it.
        getLocationPermission()
          .then((p) => {
            permissionRef.current = p;
            setPermission(p);
          })
          .catch(() => {});
      }
    })();
    refreshInFlightRef.current = run;
    return run;
  }, [ingestPosition]);

  /** Permission on mount and whenever the app comes back to the foreground. */
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      if (!cancelled) refreshPermission().catch(() => {});
    };
    read();
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshPermission]);

  useEffect(() => {
    if (!navigator.geolocation && !isNativeApp()) {
      setGeoError('unsupported');
      return undefined;
    }
    let cancelled = false;
    let watchId = null;
    let nativeWatch = null;
    (async () => {
      try {
        if (isNativeApp()) {
          // Start only once the permission exists. The plugin would otherwise raise
          // the OS dialog on mount; the Allow button is where that belongs, and it
          // bumps watchEpoch so this effect runs again afterwards.
          const perm = await getLocationPermission();
          if (cancelled || (perm !== 'granted' && perm !== 'coarse')) return;
          nativeWatch = await watchNativePosition(
            { highAccuracy: true, timeoutMs: 25_000, maximumAgeMs: 15_000 },
            (pos) => ingestPosition(pos, { forceMapUpdate: false }),
            (err) => {
              console.error(`${GEO_LOG} native watchPosition error`, { code: err.code, message: err.message });
              setGeoError((prev) => {
                if (prev === 'denied') return prev;
                return err.code === 1 ? 'denied' : prev || 'unavailable';
              });
            },
          );
          if (cancelled) nativeWatch.clear();
          console.log(`${GEO_LOG} native watchPosition started`);
          return;
        }
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
      if (nativeWatch) nativeWatch.clear();
    };
  }, [ingestPosition, watchEpoch]);

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

  const hasFix = lat != null && lng != null;
  // Native: the OS decides, not a cached coordinate. Web: the browser prompts on
  // first use, so "needs permission" is only ever a known refusal.
  const needsPermission = isNativeApp()
    ? permission != null && permission !== 'granted' && permission !== 'coarse'
    : permission === 'denied';

  return {
    lat,
    lng,
    accuracy,
    mapCenter,
    headingDeg,
    geoError,
    hasFix,
    permission,
    needsPermission,
    /**
     * A real position this app may use right now: a fix, and the right to have
     * it. On native that right is unknown until the first permission read, so a
     * coordinate seeded from the cache is not "located" until then; the offers
     * provider publishes on mount, and used to publish that cached point once.
     */
    located: hasFix && !needsPermission && (!isNativeApp() || permission != null),
    refreshFromUserGesture,
    refreshPermission,
  };
}
