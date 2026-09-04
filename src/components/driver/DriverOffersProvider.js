import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  fetchBidAcceptedJobsForDriver,
  fetchOpenOffersForDriver,
  fetchRecentForDriver,
  driverHasLeftAcceptedDelivery,
  driverHasAutoOpenedAcceptedDelivery,
  markDriverAutoOpenedAcceptedDelivery,
  offerToActiveDeliveryOrder,
  OFFER_RING_CYCLE_MS,
  OPEN_OFFER_MAX_AGE_MS,
  recordDriverViewedOffer,
  driverAcceptOffer,
  driverRejectOffer,
} from '../../lib/driverIncomingBookings';
import {
  getDriverOnlinePreference,
  getDriverSession,
  setDriverOnlinePreference,
} from '../../lib/driverSession';
import { fetchDriverNotifPrefs, readCachedDriverNotifPrefs } from '../../lib/driverNotificationPrefs';
import { playDriverNewOfferRing, unlockDriverOfferAudio, notifyDriverNewOffer, startDriverOfferRing, stopDriverOfferRing, stopAllDriverOfferRings, handleDriverOfferStopSignal } from '../../lib/driverOfferRing';
import { ORDER_ALREADY_ACCEPTED_MSG } from '../../lib/claimOpenBooking';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';
import { publishDriverOnlineLocation } from '../../lib/nearbyDrivers';
import { useLiveLocation } from '../../hooks/useLiveLocation';
import { jobPath } from './useDriverJob';
import ConfirmDialog from '../ConfirmDialog';
import './driverNewOfferNotifier.css';

const POLL_MS = 2500;
const AUTO_DISMISS_MS = 14000;

const DriverOffersContext = createContext(null);

function offerKey(o) {
  return `${o.table}:${o.id}`;
}

/** Route of the full-screen offer for a `table:id` key or a bare order id. */
export function offerPath(key) {
  return `/driver/offer/${encodeURIComponent(String(key || ''))}`;
}

/**
 * The offer a push tag, offer key or route param refers to, or undefined. One
 * matcher for the notification buttons and the offer screen: a key may be
 * `table:id`, a bare id, or a tag ending in the id.
 */
export function findOfferForKey(offers, key, tag = '') {
  const k = String(key || '');
  const t = String(tag || '');
  return offers.find((o) => {
    const id = String(o.id);
    return offerKey(o) === k || id === k || (t !== '' && t.endsWith(id)) || (k !== '' && k.endsWith(id));
  });
}

function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

/** Hard cap on how long a notification button waits for its offer; the real gate is two completed polls. */
const NOTIFICATION_ACTION_WAIT_MS = 90000;

/** Withdraw the OS notification for an offer once a button on it has been acted on. */
function withdrawOfferNotification(tag) {
  if (!tag) return;
  void import('../../lib/driverPush')
    .then((m) => m.removeDeliveredOfferNotification(tag))
    .catch(() => {});
}

/** @param {string} table @param {Record<string, unknown> | null | undefined} row */
function bookingStillOpenForRing(table, row) {
  if (!row) return false;
  if (row.assigned_driver_id) return false;
  const status = String(row.status || '').toLowerCase().trim();
  const bid = String(row.bid_status || 'open').toLowerCase().trim();
  if (bid === 'matched' || bid === 'cancelled') return false;
  if (status === 'cancelled' || status === 'delivered' || status === 'completed') return false;

  if (table === 'customer_delivery_orders') return status === 'placed' || status === 'paid';
  if (table === 'taxi_bookings' || table === 'tuk_tuk_bookings') return status === 'requested';
  if (table === 'shop_customer_orders') return status === 'ready for delivery';
  return false;
}

function placeLabel(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '—';
  return t.split(',')[0].trim().slice(0, 42) || '—';
}

function kindTitle(kind) {
  if (kind === 'parcel') return 'New delivery request';
  if (kind === 'shop') return 'New shop delivery';
  if (kind === 'tuktuk') return 'New Tuk-Tuk request';
  return 'New taxi request';
}

/** Which 2‑minute (or configured) re-offer cycle an offer is in. */
function offerCycleIndex(iso) {
  const placed = new Date(iso || 0).getTime();
  if (!Number.isFinite(placed) || placed <= 0) return -1;
  const elapsed = Date.now() - placed;
  if (elapsed < 0 || elapsed >= OPEN_OFFER_MAX_AGE_MS) return -1;
  return Math.floor(elapsed / OFFER_RING_CYCLE_MS);
}

function shortAmount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `$${v.toFixed(2)}`;
}

export function DriverOffersProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const session = getDriverSession();
  const driverId = session?.id || null;
  const driverVehicleType = session?.vehicle_type || '';
  const [driverRegisteredAt, setDriverRegisteredAt] = useState(session?.created_at || null);

  const [online, setOnlineState] = useState(() => getDriverOnlinePreference());
  const [offers, setOffers] = useState([]);
  const [recent, setRecent] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [toasts, setToasts] = useState([]);
  const [ringingOfferKeys, setRingingOfferKeys] = useState(() => new Set());
  const [takenNotice, setTakenNotice] = useState('');
  /** Outcome of an Accept / Decline pressed on the notification itself. */
  const [actionNotice, setActionNotice] = useState('');
  const [actionTick, setActionTick] = useState(0);
  const [, setSecTick] = useState(0);

  // One GPS watch for the whole driver area. Until 2026-09-03 DriverHomePage owned
  // the watch and the 15 s publish loop, and its unmount cleanup published
  // is_online=false — so opening any other tab, or the offer screen, took the
  // driver out of the dispatch pool (found when the driver row read
  // is_online=false with a stale position after a ring). Now the loop lives
  // here, under every /driver/* route, and the offline publish happens only
  // when the driver goes offline or leaves the driver area.
  const live = useLiveLocation({ mapThrottleMs: 12000, movePublishMeters: 80 });
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (!driverId || !isSupabaseConfigured || !supabase) return undefined;
    if (!online) {
      void publishDriverOnlineLocation(supabase, driverId, null, null, false);
      return undefined;
    }
    const push = async () => {
      const { lat, lng, hasFix } = liveRef.current;
      const withFix = hasFix && lat != null && lng != null;
      const res = await publishDriverOnlineLocation(supabase, driverId, withFix ? lat : null, withFix ? lng : null, true);
      if (!res?.ok) console.warn('[DriverOffers] publish location failed', res?.error || 'unknown');
      else if (!withFix) console.info('[DriverOffers] published online with no fix yet');
    };
    void push();
    const id = window.setInterval(() => void push(), 15_000);
    return () => {
      window.clearInterval(id);
      void publishDriverOnlineLocation(supabase, driverId, null, null, false);
    };
  }, [driverId, online]);

  const onlineRef = useRef(online);
  const knownOfferKeysRef = useRef(new Set());
  const offersPrimedRef = useRef(false);
  const cycleRingedRef = useRef(new Map());
  /** Offer keys currently ringing — stopped only when backend says the trip is gone. */
  const activeRingKeysRef = useRef(new Set());
  const viewedReportedRef = useRef(new Set());
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  /** A notification button press waiting for its offer: { action, offerKey, tag, at }. */
  const pendingActionRef = useRef(null);
  /** Completed offer polls, success or failure. Lets a parked action wait for real data, not a clock. */
  const pollsDoneRef = useRef(0);

  useEffect(() => {
    onlineRef.current = online;
  }, [online]);

  // Blueprint piece 7 — act on a notification tap.
  //
  // Two arrivals to handle. A cold start, where the OS launched the app into the
  // push listener before this component existed and driverPushBootstrap parked the
  // tap; and a warm tap while the app is already running, which arrives as an event.
  // Both land here, and both are routed once.
  useEffect(() => {
    // One tap can arrive twice: parked by driverPushBootstrap on a cold start
    // and again as the window event. Drop the duplicate, and nothing else. The
    // previous "handle once per mount" guard silently ignored every button press
    // after the first for as long as the app process lived (found 2026-09-03 in
    // a live demo: the second Accept of the day did nothing).
    const last = { key: '', at: 0 };
    const goToOffer = (detail) => {
      if (!detail) return;
      const key = `${detail.tag || detail.offerKey || detail.link || ''}|${detail.action || ''}`;
      const now = Date.now();
      if (key === last.key && now - last.at < 3000) return;
      last.key = key;
      last.at = now;
      const action = String(detail.action || '');
      if (action === 'accept' || action === 'decline') {
        // A button on the notification itself (OfferMessagingService, Android).
        // Parked here; the effect further down acts on it once the offer is in
        // `offers`. The payload is never trusted for the offer itself: an order
        // somebody else took resolves to "already accepted", not to a stale claim.
        pendingActionRef.current = {
          action,
          offerKey: String(detail.offerKey || ''),
          tag: String(detail.tag || ''),
          at: Date.now(),
          pollsAtPark: pollsDoneRef.current,
        };
        console.info(`[DriverOffers] notification button ${JSON.stringify(pendingActionRef.current)}`);
        setActionTick((n) => n + 1);
      }
      // Any tap that names an offer opens the offer screen; the payload's link
      // is only the fallback for a tap that names nothing.
      const ref = String(detail.offerKey || '').trim() || String(detail.tag || '').replace(/^ingo-offer-/, '').trim();
      const link = ref ? offerPath(ref) : String(detail.link || '/driver/home');
      console.info('[DriverOffers] routing to tapped offer', link);
      // The tap deliberately carries only a link and an offer key. The offer itself
      // is re-fetched by the poll below, so an offer somebody else already took
      // opens to "already accepted" rather than to stale detail from the payload.
      try {
        navigateRef.current(link.startsWith('/') ? link : `/${link}`);
      } catch {
        /* router not ready; the poll still surfaces the offer */
      }
    };

    void import('../../lib/driverPushBootstrap')
      .then((m) => goToOffer(m.consumePendingOfferTap()))
      .catch(() => {});

    const onTap = (e) => {
      goToOffer(e?.detail);
      // The bootstrap parked a copy before dispatching this event. Clear it so a
      // later mount does not replay an old button press.
      void import('../../lib/driverPushBootstrap')
        .then((m) => m.consumePendingOfferTap())
        .catch(() => {});
    };
    window.addEventListener('ingo-driver-offer-tap', onTap);
    return () => window.removeEventListener('ingo-driver-offer-tap', onTap);
  }, []);

  const setOnline = useCallback((next) => {
    setOnlineState((prev) => {
      const value = typeof next === 'function' ? next(prev) : Boolean(next);
      setDriverOnlinePreference(value);
      return value;
    });
  }, []);

  useEffect(() => {
    const unlock = () => unlockDriverOfferAudio();
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!driverId) return undefined;
    let cancelled = false;
    void fetchDriverNotifPrefs(driverId).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  useEffect(() => {
    if (!driverId || driverRegisteredAt || !isSupabaseConfigured || !supabase) return undefined;
    let cancelled = false;
    supabase
      .from('driver_registrations')
      .select('created_at')
      .eq('id', driverId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data?.created_at) setDriverRegisteredAt(data.created_at);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId, driverRegisteredAt]);

  const stopRingForKey = useCallback((key) => {
    if (!key) return;
    activeRingKeysRef.current.delete(key);
    stopDriverOfferRing(key);
    setRingingOfferKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const syncRingsToOpenOffers = useCallback(
    (openKeys) => {
      const open = openKeys instanceof Set ? openKeys : new Set(openKeys || []);
      for (const key of [...activeRingKeysRef.current]) {
        if (!open.has(key)) stopRingForKey(key);
      }
    },
    [stopRingForKey],
  );

  const alertNewOffers = useCallback((newOffers, { toast } = { toast: true }) => {
    if (!newOffers.length) return;
    const prefs = readCachedDriverNotifPrefs(driverId);
    if (!prefs.new_offers) return;

    const first = newOffers[0];
    const amountBit = shortAmount(first.amount);
    const firstKey = offerKey(first);
    notifyDriverNewOffer({
      title: kindTitle(first.kind),
      body: [
        first.ref ? `#${first.ref}` : null,
        placeLabel(first.from),
        placeLabel(first.to) !== '—' ? `→ ${placeLabel(first.to)}` : null,
        amountBit || null,
        newOffers.length > 1 ? `(+${newOffers.length - 1} more)` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      tag: `ingo-offer-${firstKey}`,
      offerKey: firstKey,
      onClickPath: '/driver/home',
      sound: prefs.offer_sound,
      banner: true,
      loop: true,
      maxMs: OFFER_RING_CYCLE_MS,
    });
    // Extra one-shot burst if more than one new offer arrived together
    if (prefs.offer_sound && newOffers.length > 1) {
      window.setTimeout(() => playDriverNewOfferRing(), 900);
    }
    const keys = newOffers.map(offerKey);
    for (const k of keys) {
      activeRingKeysRef.current.add(k);
      if (prefs.offer_sound && k !== firstKey) {
        startDriverOfferRing(k, { maxMs: OFFER_RING_CYCLE_MS });
      }
    }
    setRingingOfferKeys((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });

    if (isNativeApp()) {
      // In the app the request is a screen, not a toast (2026-09-03, client).
      // A re-ring re-opens it unless the driver is already looking at it.
      const target = offerPath(firstKey);
      if (pathRef.current !== target) {
        try {
          navigateRef.current(target);
        } catch {
          /* router not ready; the poll still surfaces the offer on home */
        }
      }
      return;
    }

    if (!toast) return;
    setToasts((prev) => [
      ...prev,
      ...newOffers.map((o) => ({
        key: offerKey(o),
        title: kindTitle(o.kind),
        ref: o.ref,
        pickup: placeLabel(o.from),
        dropoff: placeLabel(o.to),
        amount: shortAmount(o.amount),
      })),
    ]);
  }, [driverId]);

  const dismissToast = useCallback((key) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  const dropTakenOffer = useCallback(
    (table, id, assignedDriverId) => {
      if (!id || !assignedDriverId) return;
      if (driverId && String(assignedDriverId) === String(driverId)) {
        // This driver accepted — stop local ring; FCM stop is sent from claimOpenBooking.
        stopRingForKey(`${table}:${id}`);
        return;
      }
      const k = `${table}:${id}`;
      stopRingForKey(k);
      if (!knownOfferKeysRef.current.has(k)) return;
      knownOfferKeysRef.current.delete(k);
      cycleRingedRef.current.delete(k);
      setOffers((prev) => prev.filter((o) => offerKey(o) !== k));
      dismissToast(k);
      setTakenNotice(ORDER_ALREADY_ACCEPTED_MSG);
    },
    [driverId, dismissToast, stopRingForKey],
  );

  /** Backend row changed — stop ring if the trip is no longer an open offer. */
  const onBookingRealtime = useCallback(
    (table, row) => {
      const id = row?.id;
      if (!id) return;
      const k = `${table}:${id}`;
      if (row?.assigned_driver_id) {
        dropTakenOffer(table, id, row.assigned_driver_id);
        return;
      }
      if (!bookingStillOpenForRing(table, row)) {
        stopRingForKey(k);
        if (knownOfferKeysRef.current.has(k)) {
          knownOfferKeysRef.current.delete(k);
          cycleRingedRef.current.delete(k);
          setOffers((prev) => prev.filter((o) => offerKey(o) !== k));
          dismissToast(k);
        }
      }
    },
    [dropTakenOffer, stopRingForKey, dismissToast],
  );

  const tickRef = useRef(async () => {});

  useEffect(() => {
    tickRef.current = async () => {
      if (!driverId || !isSupabaseConfigured || !supabase) {
        setOffers([]);
        setRecent([]);
        if (!isSupabaseConfigured || !supabase) {
          setLoadErr('Supabase is not configured. Add keys to use live customer bookings.');
        }
        return;
      }

      try {
        const rec = await fetchRecentForDriver(supabase, driverId);
        setRecent(rec);

        try {
          const accepted = await fetchBidAcceptedJobsForDriver(supabase, driverId);
          if (accepted.length) {
            const job = accepted.find(
              (j) =>
                !driverHasLeftAcceptedDelivery(j.table, j.id) &&
                !driverHasAutoOpenedAcceptedDelivery(j.table, j.id),
            );
            if (job) {
              markDriverAutoOpenedAcceptedDelivery(job.table, job.id);
              const active = offerToActiveDeliveryOrder(job);
              navigateRef.current(jobPath('active-delivery', active), { state: { order: active } });
            }
          }
        } catch {
          /* bid columns may not exist yet */
        }

        if (!onlineRef.current) {
          setOffers([]);
          knownOfferKeysRef.current = new Set();
          offersPrimedRef.current = false;
          cycleRingedRef.current = new Map();
          activeRingKeysRef.current = new Set();
          stopAllDriverOfferRings();
          setRingingOfferKeys(new Set());
          setLoadErr('');
          return;
        }

        const next = await fetchOpenOffersForDriver(
          supabase,
          driverId,
          driverVehicleType,
          driverRegisteredAt,
        );
        setOffers(next);

        for (const offer of next) {
          const k = offerKey(offer);
          if (viewedReportedRef.current.has(k)) continue;
          viewedReportedRef.current.add(k);
          void recordDriverViewedOffer(supabase, offer, driverId);
        }

        const keys = next.map(offerKey);
        const current = new Set(keys);

        // Backend is source of truth: stop any ring whose offer is no longer open
        // (accepted by anyone, cancelled, expired past open window).
        syncRingsToOpenOffers(current);

        if (!offersPrimedRef.current) {
          knownOfferKeysRef.current = current;
          offersPrimedRef.current = true;
          for (const o of next) {
            cycleRingedRef.current.set(offerKey(o), offerCycleIndex(o.created_at));
          }
          setLoadErr('');
          return;
        }

        const brandNew = next.filter((o) => !knownOfferKeysRef.current.has(offerKey(o)));
        knownOfferKeysRef.current = current;

        if (brandNew.length) {
          for (const o of brandNew) {
            cycleRingedRef.current.set(offerKey(o), offerCycleIndex(o.created_at));
          }
          // Always show in-app banner (native WebViews often block system Notification API).
          alertNewOffers(brandNew, { toast: true });
        } else {
          // Re-ring when a still-open offer enters a new cycle (was advertised but never wired).
          const reRing = [];
          for (const o of next) {
            const k = offerKey(o);
            const cycle = offerCycleIndex(o.created_at);
            if (cycle < 0) continue;
            const prevCycle = cycleRingedRef.current.get(k);
            if (prevCycle == null) {
              cycleRingedRef.current.set(k, cycle);
              continue;
            }
            if (cycle > prevCycle) {
              cycleRingedRef.current.set(k, cycle);
              reRing.push(o);
            }
          }
          if (reRing.length) alertNewOffers(reRing, { toast: true });
        }

        // Drop cycle map entries for offers that disappeared
        for (const k of [...cycleRingedRef.current.keys()]) {
          if (!current.has(k)) cycleRingedRef.current.delete(k);
        }

        setLoadErr('');
      } catch (e) {
        setLoadErr(e?.message || String(e));
      } finally {
        pollsDoneRef.current += 1;
        // A parked notification action re-evaluates after every poll, even one
        // that returned the same (possibly empty) list.
        if (pendingActionRef.current) setActionTick((n) => n + 1);
      }
    };
  }, [driverId, driverVehicleType, driverRegisteredAt, location.pathname, alertNewOffers, syncRingsToOpenOffers]);

  useEffect(() => {
    if (!driverId || !isSupabaseConfigured || !supabase) return undefined;
    let cancelled = false;
    let timer = null;

    const run = async () => {
      if (cancelled) return;
      await tickRef.current();
    };

    run();
    timer = window.setInterval(run, POLL_MS);

    const onVis = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);

    /** Near-instant refresh when Realtime is enabled on these tables. */
    const channel = supabase
      .channel(`driver-offers-${driverId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customer_delivery_orders' },
        (payload) => {
          onBookingRealtime('customer_delivery_orders', payload?.new);
          void run();
        },
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'taxi_bookings' }, (payload) => {
        onBookingRealtime('taxi_bookings', payload?.new);
        void run();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tuk_tuk_bookings' }, (payload) => {
        onBookingRealtime('tuk_tuk_bookings', payload?.new);
        void run();
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shop_customer_orders' },
        (payload) => {
          onBookingRealtime('shop_customer_orders', payload?.new);
          void run();
        },
      )
      .subscribe();

    const onPushStop = (ev) => {
      const detail = ev?.detail || {};
      handleDriverOfferStopSignal(detail.offerKey, detail.tag);
    };
    window.addEventListener('ingo-driver-offer-stop', onPushStop);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('ingo-driver-offer-stop', onPushStop);
      void supabase.removeChannel(channel);
      stopAllDriverOfferRings();
      activeRingKeysRef.current = new Set();
    };
  }, [driverId, online, driverVehicleType, driverRegisteredAt, dropTakenOffer, onBookingRealtime]);

  useEffect(() => {
    if (!online) return undefined;
    const id = window.setInterval(() => setSecTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [online]);

  useEffect(() => {
    if (!toasts.length) return undefined;
    const timers = toasts.map((t) => window.setTimeout(() => dismissToast(t.key), AUTO_DISMISS_MS));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts, dismissToast]);

  const removeOfferLocally = useCallback((table, id) => {
    const k = `${table}:${id}`;
    stopRingForKey(k);
    // The OS notification carries live Accept / Decline buttons. Once this driver
    // has answered the offer anywhere (screen, home card, notification), a stale
    // row in the shade would answer "no longer available" later. Same tag the
    // sender uses: `ingo-offer-<table:id>`. Found 2026-09-03 after a decline on
    // the offer screen left the notification behind.
    withdrawOfferNotification(`ingo-offer-${k}`);
    setOffers((prev) => prev.filter((o) => offerKey(o) !== k));
    knownOfferKeysRef.current.delete(k);
    cycleRingedRef.current.delete(k);
    dismissToast(k);
  }, [dismissToast, stopRingForKey]);

  const refreshOffers = useCallback(async () => {
    await tickRef.current();
  }, []);

  // Accept / Decline pressed on the notification. Runs the same functions the
  // in-app card runs (driverAcceptOffer / driverRejectOffer), so there is one
  // accept path, not two. Waits up to NOTIFICATION_ACTION_WAIT_MS for the poll to
  // surface the offer, then reports it gone. Every outcome is logged and shown.
  useEffect(() => {
    const p = pendingActionRef.current;
    if (!p || !driverId || !supabase) return undefined;
    const offer = findOfferForKey(offers, p.offerKey, p.tag);
    if (!offer) {
      // Give up only once the poll has completed twice since the tap without
      // returning the offer, or at the hard cap. A cold start's first poll can
      // take longer than any fixed wait: on 2026-09-03 the offer arrived at
      // ~25 s and a 20 s clock reported it gone while it was still open.
      const pollsSince = pollsDoneRef.current - (p.pollsAtPark || 0);
      const left = NOTIFICATION_ACTION_WAIT_MS - (Date.now() - p.at);
      if (pollsSince < 2 && left > 0) {
        const t = setTimeout(() => setActionTick((n) => n + 1), left + 50);
        return () => clearTimeout(t);
      }
      pendingActionRef.current = null;
      console.info(`[DriverOffers] notification button: offer not found ${JSON.stringify(p)}`);
      withdrawOfferNotification(p.tag);
      setActionNotice('That request is no longer open. It was already answered, taken by another driver, or timed out.');
      return undefined;
    }
    pendingActionRef.current = null;
    void (async () => {
      console.info(`[DriverOffers] notification button ${p.action} -> ${offerKey(offer)}`);
      if (p.action === 'decline') {
        const res = await driverRejectOffer(supabase, offer, driverId);
        console.info(`[DriverOffers] decline result ${JSON.stringify(res)}`);
        if (!res.ok) {
          setActionNotice(res.error || 'Could not save your decline.');
          return;
        }
        removeOfferLocally(offer.table, offer.id);
        withdrawOfferNotification(p.tag);
        setActionNotice('Declined. You will not be asked about this request again.');
        return;
      }
      const res = await driverAcceptOffer(supabase, offer, driverId, driverVehicleType);
      console.info(`[DriverOffers] accept result ${JSON.stringify(res)}`);
      if (!res.ok) {
        if (/already accepted/i.test(String(res.error || ''))) {
          removeOfferLocally(offer.table, offer.id);
          withdrawOfferNotification(p.tag);
          setTakenNotice(res.error || ORDER_ALREADY_ACCEPTED_MSG);
          return;
        }
        setActionNotice(res.error || 'Could not accept this request.');
        return;
      }
      withdrawOfferNotification(p.tag);
      if (res.pending) {
        // Parcel / taxi / tuk: the offer waits for the customer to choose this driver.
        setActionNotice('Offer sent. Waiting for the customer to choose you.');
        void tickRef.current();
        return;
      }
      removeOfferLocally(offer.table, offer.id);
      setRecent(await fetchRecentForDriver(supabase, driverId));
      const job = offerToActiveDeliveryOrder(offer);
      navigateRef.current(jobPath('active-delivery', job), { state: { order: job } });
    })();
    return undefined;
  }, [offers, actionTick, driverId, driverVehicleType, removeOfferLocally]);

  const value = useMemo(
    () => ({
      online,
      setOnline,
      live,
      offers,
      recent,
      setRecent,
      loadErr,
      ringingOfferKeys,
      driverId,
      driverVehicleType,
      driverRegisteredAt,
      removeOfferLocally,
      refreshOffers,
      setTakenNotice,
    }),
    [
      online,
      setOnline,
      live,
      offers,
      recent,
      loadErr,
      ringingOfferKeys,
      driverId,
      driverVehicleType,
      driverRegisteredAt,
      removeOfferLocally,
      refreshOffers,
    ],
  );

  return (
    <DriverOffersContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        <div className="drvNoteStack" role="region" aria-label="New delivery requests">
          {toasts.map((t) => (
            <div key={t.key} className="drvNote" role="alert">
              <span className="drvNote__pulse" aria-hidden />
              <div className="drvNote__icon" aria-hidden>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                  <path d="m4 7 8 4 8-4M12 11v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
              <div className="drvNote__body">
                <p className="drvNote__title">{t.title}</p>
                <p className="drvNote__meta">
                  {t.ref} · {t.pickup} → {t.dropoff}
                  {t.amount ? ` · ${t.amount}` : ''}
                </p>
                <button
                  type="button"
                  className="drvNote__cta"
                  onClick={() => {
                    dismissToast(t.key);
                    unlockDriverOfferAudio();
                    navigate(offerPath(t.key));
                  }}
                >
                  View request
                </button>
              </div>
              <button
                type="button"
                className="drvNote__close"
                aria-label="Dismiss"
                onClick={() => dismissToast(t.key)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <ConfirmDialog
        open={Boolean(takenNotice)}
        title="Order already accepted"
        message={takenNotice || ORDER_ALREADY_ACCEPTED_MSG}
        confirmLabel="OK"
        hideCancel
        danger={false}
        onConfirm={() => setTakenNotice('')}
        onCancel={() => setTakenNotice('')}
      />
      <ConfirmDialog
        open={Boolean(actionNotice)}
        title="Delivery request"
        message={actionNotice}
        confirmLabel="OK"
        hideCancel
        danger={false}
        onConfirm={() => setActionNotice('')}
        onCancel={() => setActionNotice('')}
      />
    </DriverOffersContext.Provider>
  );
}

export function useDriverOffers() {
  const ctx = useContext(DriverOffersContext);
  if (!ctx) {
    throw new Error('useDriverOffers must be used within DriverOffersProvider');
  }
  return ctx;
}
