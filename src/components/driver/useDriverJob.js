/**
 * One accepted job, resolved for whichever screen is showing it.
 *
 * Before this existed, the job after Accept lived only in `location.state.order`
 * and every screen in the chain fell back to `DEFAULT_DRIVER_ORDER` when that was
 * gone — so a reload, a killed process, a cold start from a notification or the
 * back button showed the driver a fixture (`ING-00881`, "Sara Khan", $3.20) as
 * though it were real work. Router state does not survive any of those.
 *
 * So the job has an address. The route carries `table:id` — the same encoding
 * `/driver/offer/:offerKey` already uses — and this hook resolves, in order:
 *
 *   1. `location.state.order`, when the previous screen handed it over. This is
 *      the fast path and the only one carrying in-flight edits (the package
 *      photo taken a second ago is not in the database yet).
 *   2. a fetch by key, through the same `fetchActiveOrdersForDriver` the Orders
 *      page uses, so there is one row→order mapping and it cannot drift.
 *   3. nothing — and the screen says so, instead of inventing a customer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { fetchActiveOrdersForDriver } from '../../lib/driverIncomingBookings';
import { getDriverSession } from '../../lib/driverSession';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';

/** `table:id` for an order that already carries its identity. */
export function jobKeyOf(order) {
  const table = String(order?.bookingTable || '').trim();
  const id = String(order?.supabaseOrderId || '').trim();
  if (!table || !id) return '';
  return `${table}:${id}`;
}

/**
 * Route for a chain screen carrying its job identity, e.g.
 * `jobPath('active-delivery', order)` → `/driver/active-delivery/customer_delivery_orders%3Aa8a7…`.
 *
 * Falls back to the bare route when the order has no identity — a legacy or
 * synthetic order still navigates, it just cannot be recovered after a reload.
 */
export function jobPath(base, order) {
  const key = jobKeyOf(order);
  const root = `/driver/${String(base || '').replace(/^\/+|\/+$/g, '')}`;
  return key ? `${root}/${encodeURIComponent(key)}` : root;
}

/** Split a `table:id` route param. The id itself never contains a colon. */
function parseJobKey(raw) {
  let key = String(raw || '');
  try {
    key = decodeURIComponent(key);
  } catch {
    /* keep the raw value; a malformed key simply will not match */
  }
  const at = key.indexOf(':');
  if (at <= 0) return null;
  const table = key.slice(0, at).trim();
  const id = key.slice(at + 1).trim();
  if (!table || !id) return null;
  return { table, id };
}

/**
 * @returns {{
 *   order: Record<string, unknown> | null,
 *   status: 'ready' | 'loading' | 'missing' | 'error',
 *   error: string,
 *   jobKey: string,
 *   reload: () => void,
 * }}
 */
export function useDriverJob() {
  const { state } = useLocation();
  const { jobKey: param } = useParams();

  const fromState = state && state.order ? state.order : null;
  const identity = useMemo(() => {
    if (fromState) {
      const key = jobKeyOf(fromState);
      if (key) return parseJobKey(key);
    }
    return parseJobKey(param);
  }, [fromState, param]);

  const [fetched, setFetched] = useState(null);
  const [status, setStatus] = useState(fromState ? 'ready' : identity ? 'loading' : 'missing');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const cancelledRef = useRef(false);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    cancelledRef.current = false;
    // Router state wins: it is current, and it holds edits the database has not
    // seen yet. Nothing to fetch.
    if (fromState) {
      setStatus('ready');
      setError('');
      return () => {
        cancelledRef.current = true;
      };
    }
    if (!identity) {
      setStatus('missing');
      return () => {
        cancelledRef.current = true;
      };
    }
    const driverId = getDriverSession()?.id || null;
    if (!isSupabaseConfigured || !supabase || !driverId) {
      setStatus('missing');
      return () => {
        cancelledRef.current = true;
      };
    }

    setStatus('loading');
    setError('');
    (async () => {
      try {
        const rows = await fetchActiveOrdersForDriver(supabase, driverId);
        if (cancelledRef.current) return;
        const hit = rows.find(
          (r) =>
            String(r?.order?.bookingTable || '') === identity.table &&
            String(r?.order?.supabaseOrderId || '') === identity.id,
        );
        if (!hit) {
          // Not an error: the job is finished, cancelled, or belongs to someone
          // else now. The screen says that rather than showing a stale one.
          setStatus('missing');
          return;
        }
        setFetched(hit.order);
        setStatus('ready');
      } catch (e) {
        if (cancelledRef.current) return;
        setError(e?.message || String(e));
        setStatus('error');
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [fromState, identity, attempt]);

  const order = fromState || fetched;

  return {
    order: status === 'ready' ? order : null,
    status,
    error,
    jobKey: identity ? `${identity.table}:${identity.id}` : '',
    reload,
  };
}
