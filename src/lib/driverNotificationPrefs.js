/**
 * Driver notification preferences (Profile → Notifications).
 * Cached in localStorage; synced to Supabase when configured.
 */
import { isSupabaseConfigured, supabase } from './supabaseClient';

const CACHE_PREFIX = 'ingo_driver_notif_prefs:';

/** @typedef {{ new_offers: boolean, offer_sound: boolean, push_when_closed: boolean }} DriverNotifPrefs */

export const DEFAULT_DRIVER_NOTIF_PREFS = /** @type {DriverNotifPrefs} */ ({
  new_offers: true,
  offer_sound: true,
  // Matches the database default (true). It was false here until 2026-09-06,
  // and the sender treated a saved false as "never push to this driver".
  push_when_closed: true,
});

function cacheKey(driverId) {
  return `${CACHE_PREFIX}${String(driverId || '').trim()}`;
}

/**
 * @param {unknown} raw
 * @returns {DriverNotifPrefs}
 */
export function normalizeDriverNotifPrefs(raw) {
  const base = { ...DEFAULT_DRIVER_NOTIF_PREFS };
  if (!raw || typeof raw !== 'object') return base;
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.new_offers === 'boolean') base.new_offers = o.new_offers;
  if (typeof o.offer_sound === 'boolean') base.offer_sound = o.offer_sound;
  if (typeof o.push_when_closed === 'boolean') base.push_when_closed = o.push_when_closed;
  // Sound / push only apply when new offers are on
  if (!base.new_offers) {
    base.offer_sound = false;
    base.push_when_closed = false;
  }
  return base;
}

/**
 * @param {string | null | undefined} driverId
 * @returns {DriverNotifPrefs}
 */
export function readCachedDriverNotifPrefs(driverId) {
  const id = String(driverId || '').trim();
  if (!id) return { ...DEFAULT_DRIVER_NOTIF_PREFS };
  try {
    const raw = localStorage.getItem(cacheKey(id));
    if (!raw) return { ...DEFAULT_DRIVER_NOTIF_PREFS };
    return normalizeDriverNotifPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DRIVER_NOTIF_PREFS };
  }
}

/**
 * @param {string | null | undefined} driverId
 * @param {DriverNotifPrefs} prefs
 */
export function writeCachedDriverNotifPrefs(driverId, prefs) {
  const id = String(driverId || '').trim();
  if (!id) return;
  try {
    localStorage.setItem(cacheKey(id), JSON.stringify(normalizeDriverNotifPrefs(prefs)));
  } catch {
    // ignore
  }
}

/**
 * @param {string | null | undefined} driverId
 * @returns {Promise<{ prefs: DriverNotifPrefs, error?: string }>}
 */
export async function fetchDriverNotifPrefs(driverId) {
  const id = String(driverId || '').trim();
  const cached = readCachedDriverNotifPrefs(id);
  if (!id || !isSupabaseConfigured || !supabase) {
    return { prefs: cached };
  }

  const { data, error } = await supabase
    .from('driver_notification_prefs')
    .select('new_offers, offer_sound, push_when_closed')
    .eq('driver_id', id)
    .maybeSingle();

  if (error) {
    if (/does not exist|schema cache|Could not find the table/i.test(error.message || '')) {
      return {
        prefs: cached,
        error: 'Run supabase/driver_notification_prefs.sql in the Supabase SQL editor.',
      };
    }
    return { prefs: cached, error: error.message };
  }

  if (!data) {
    writeCachedDriverNotifPrefs(id, cached);
    return { prefs: cached };
  }

  const prefs = normalizeDriverNotifPrefs(data);
  writeCachedDriverNotifPrefs(id, prefs);
  return { prefs };
}

/**
 * @param {string | null | undefined} driverId
 * @param {Partial<DriverNotifPrefs>} patch
 * @returns {Promise<{ prefs: DriverNotifPrefs, error?: string }>}
 */
export async function saveDriverNotifPrefs(driverId, patch) {
  const id = String(driverId || '').trim();
  const next = normalizeDriverNotifPrefs({
    ...readCachedDriverNotifPrefs(id),
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  writeCachedDriverNotifPrefs(id, next);

  if (!id || !isSupabaseConfigured || !supabase) {
    return { prefs: next };
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from('driver_notification_prefs').upsert(
    {
      driver_id: id,
      new_offers: next.new_offers,
      offer_sound: next.offer_sound,
      push_when_closed: next.push_when_closed,
      updated_at: now,
    },
    { onConflict: 'driver_id' },
  );

  if (error) {
    if (/does not exist|schema cache|Could not find the table/i.test(error.message || '')) {
      return {
        prefs: next,
        error: 'Run supabase/driver_notification_prefs.sql in the Supabase SQL editor.',
      };
    }
    return { prefs: next, error: error.message };
  }

  return { prefs: next };
}
