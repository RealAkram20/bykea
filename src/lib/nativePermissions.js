import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

/**
 * One place that answers "may this phone locate the driver and ring them?", and
 * opens the settings screen that changes the answer. ADR 0005.
 *
 * Native (the Android app): permissions come from the platform through the
 * Capacitor Geolocation and PushNotifications plugins, and the extra facts the
 * plugins cannot read (location services switched on, full-screen intent on
 * Android 14+, battery optimisation) come from IngoPermissionsPlugin.java.
 * Web: the browser's own APIs, and no settings screens to open.
 *
 * Every reader returns one of: 'granted' | 'coarse' | 'prompt' | 'denied' | 'unknown'.
 * 'unknown' means the platform could not be asked; callers must never show it
 * to a driver as "blocked".
 */

const LOG = '[permissions]';

const IngoPermissions = registerPlugin('IngoPermissions');

export function isNativeApp() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Facts only the native side can read. `null` on the web or if the plugin is missing. */
export async function getNativeState() {
  if (!isNativeApp()) return null;
  try {
    return await IngoPermissions.getState();
  } catch (e) {
    console.warn(`${LOG} getState failed`, e?.message || e);
    return null;
  }
}

function normaliseLocation(p) {
  const fine = p?.location;
  const coarse = p?.coarseLocation;
  if (fine === 'granted') return 'granted';
  if (coarse === 'granted') return 'coarse';
  if (fine === 'denied' || coarse === 'denied') return 'denied';
  if (fine === 'prompt' || fine === 'prompt-with-rationale' || coarse === 'prompt' || coarse === 'prompt-with-rationale') return 'prompt';
  return 'unknown';
}

export async function getLocationPermission() {
  if (isNativeApp()) {
    try {
      return normaliseLocation(await Geolocation.checkPermissions());
    } catch (e) {
      console.warn(`${LOG} checkPermissions failed`, e?.message || e);
      return 'unknown';
    }
  }
  try {
    if (navigator.permissions?.query) {
      const s = await navigator.permissions.query({ name: 'geolocation' });
      if (s.state === 'granted') return 'granted';
      if (s.state === 'denied') return 'denied';
      return 'prompt';
    }
  } catch {
    /* Safari has no permissions.query for geolocation */
  }
  return 'unknown';
}

/**
 * Shows the OS location dialog (native). Resolves as soon as the driver answers,
 * with no timer racing the dialog. A permanently denied permission resolves
 * 'denied' immediately without a dialog: that is the state the Permissions
 * panel turns into "Open settings".
 */
export async function requestLocationPermission() {
  if (!isNativeApp()) return getLocationPermission();
  try {
    return normaliseLocation(await Geolocation.requestPermissions({ permissions: ['location'] }));
  } catch (e) {
    console.warn(`${LOG} requestPermissions failed`, e?.message || e);
    return 'denied';
  }
}

async function pushPlugin() {
  const injected = window.Capacitor?.Plugins?.PushNotifications;
  if (injected) return injected;
  try {
    const mod = await import('@capacitor/push-notifications');
    return mod.PushNotifications;
  } catch {
    return null;
  }
}

function normaliseReceive(v) {
  if (v === 'granted') return 'granted';
  if (v === 'denied') return 'denied';
  if (v === 'prompt' || v === 'prompt-with-rationale') return 'prompt';
  return 'unknown';
}

export async function getNotificationPermission() {
  if (isNativeApp()) {
    const P = await pushPlugin();
    if (!P) return 'unknown';
    try {
      return normaliseReceive((await P.checkPermissions())?.receive);
    } catch {
      return 'unknown';
    }
  }
  if (typeof Notification === 'undefined') return 'unknown';
  return Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'prompt';
}

export async function requestNotificationPermission() {
  if (isNativeApp()) {
    const P = await pushPlugin();
    if (!P) return 'unknown';
    try {
      return normaliseReceive((await P.requestPermissions())?.receive);
    } catch {
      return 'denied';
    }
  }
  if (typeof Notification === 'undefined') return 'unknown';
  try {
    const r = await Notification.requestPermission();
    return r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'unknown';
  }
}

async function openNative(method) {
  if (!isNativeApp()) return false;
  try {
    const r = await IngoPermissions[method]();
    return Boolean(r?.opened);
  } catch (e) {
    console.warn(`${LOG} ${method} failed`, e?.message || e);
    return false;
  }
}

export const openAppSettings = () => openNative('openAppSettings');
export const openLocationSettings = () => openNative('openLocationSettings');
export const openNotificationSettings = () => openNative('openNotificationSettings');
export const openOfferChannelSettings = () => openNative('openOfferChannelSettings');
export const openFullScreenIntentSettings = () => openNative('openFullScreenIntentSettings');
export const openBatterySettings = () => openNative('openBatterySettings');
export const openDndSettings = () => openNative('openDndSettings');

/** The native push plugin, for callers that need to create the offer channel. */
export const getPushPlugin = () => (isNativeApp() ? pushPlugin() : Promise.resolve(null));

/** Posts a sample offer notification through the real ring path. Native only. */
export async function sendTestOffer() {
  if (!isNativeApp()) return false;
  try {
    const r = await IngoPermissions.sendTestOffer();
    return Boolean(r?.posted);
  } catch (e) {
    console.warn(`${LOG} sendTestOffer failed`, e?.message || e);
    return false;
  }
}

/**
 * True when at least one thing on this phone would stop an offer from popping
 * on screen: notifications blocked, the offer channel silent, or the Android 14+
 * full-screen access withheld. Used by the Home screen to point at the panel.
 */
export async function offersMayArriveSilently() {
  if (!isNativeApp()) return false;
  const [notifications, native] = await Promise.all([getNotificationPermission(), getNativeState()]);
  if (notifications === 'denied') return true;
  if (!native) return false;
  if (native.offerChannel && native.offerChannel.exists && native.offerChannel.headsUp === false) return true;
  if (native.fullScreenIntent === 'denied') return true;
  if (native.doNotDisturb === true) return true;
  return false;
}

/* ---------- position reads through the fused provider ---------- */

function toPosition(p) {
  const c = p?.coords || {};
  return {
    coords: {
      latitude: c.latitude,
      longitude: c.longitude,
      accuracy: typeof c.accuracy === 'number' ? c.accuracy : null,
      heading: typeof c.heading === 'number' ? c.heading : null,
      speed: typeof c.speed === 'number' ? c.speed : null,
      altitude: typeof c.altitude === 'number' ? c.altitude : null,
    },
    timestamp: typeof p?.timestamp === 'number' ? p.timestamp : Date.now(),
  };
}

/** Same numeric codes as the browser's GeolocationPositionError, so callers need one mapping. */
function toGeoError(e) {
  const msg = String(e?.message || e || '');
  const err = new Error(msg || 'unavailable');
  if (/permission|denied|not granted/i.test(msg)) err.code = 1;
  else if (/time ?d? ?out/i.test(msg)) err.code = 3;
  else err.code = 2;
  return err;
}

/**
 * One position from the fused provider. With `highAccuracy` false and a
 * `maximumAgeMs` the provider answers from its last known fix, usually in well
 * under a second. Callers check the permission first; the plugin would
 * otherwise raise the OS dialog itself.
 */
export async function readNativePosition({ highAccuracy = false, timeoutMs = 10000, maximumAgeMs = 60000 } = {}) {
  try {
    const p = await Geolocation.getCurrentPosition({
      enableHighAccuracy: highAccuracy,
      timeout: timeoutMs,
      maximumAge: maximumAgeMs,
    });
    return toPosition(p);
  } catch (e) {
    throw toGeoError(e);
  }
}

/** Continuous fixes. Returns a handle with `clear()`. */
export async function watchNativePosition(
  { highAccuracy = true, timeoutMs = 25000, maximumAgeMs = 15000 } = {},
  onPosition,
  onError,
) {
  const id = await Geolocation.watchPosition(
    { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: maximumAgeMs },
    (p, err) => {
      if (err) {
        onError?.(toGeoError(err));
        return;
      }
      if (p) onPosition?.(toPosition(p));
    },
  );
  return {
    clear: () => Geolocation.clearWatch({ id }).catch(() => {}),
  };
}
