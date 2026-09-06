import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isCurrentDriverApprovedForWork } from '../../lib/driverApproval';
import { clearDriverSession, getDriverSession } from '../../lib/driverSession';

/** How long a "yes" from the database is trusted before it is re-asked. */
const FRESH_MS = 5 * 60 * 1000;

/** The last driver the database said yes to, and when. Module scope: one answer per app process. */
let verified = { id: '', at: 0 };

function isFresh(id) {
  return Boolean(id) && verified.id === id && Date.now() - verified.at < FRESH_MS;
}

/**
 * Call after a successful sign-in, which has just read the driver's status from
 * the database itself, so the first screen does not ask the same question again.
 */
export function markDriverVerified(id) {
  if (id) verified = { id: String(id), at: Date.now() };
}

/**
 * Ensures signed-in drivers are still approved in the database before using the portal.
 *
 * The check used to run on every route change and blank the screen with
 * "Checking driver account…" until Supabase answered — on a slow link every
 * navigation flickered, and a tap could land on whichever screen mounted next
 * (recorded 2026-09-03). Now the answer is trusted for FRESH_MS: the first screen
 * after sign-in shows nothing extra, later screens render at once, and a stale
 * answer is re-asked in the background without hiding anything. Only an explicit
 * "no" from the database ends the session, as before.
 */
export default function DriverApprovalGate({ children }) {
  const location = useLocation();
  const [status, setStatus] = useState(() => {
    const id = getDriverSession()?.id;
    if (!id) return 'denied';
    // Blank the screen only for an id this process has never verified (a cold
    // start with a stored session). An id verified earlier, even if the answer
    // is older than FRESH_MS, renders at once and is re-asked in the background
    // by the effect below. The chain routes mount a fresh gate each, so without
    // this every Home ⇄ job hop after five minutes showed "Checking…" again.
    return verified.id === String(id) ? 'ok' : 'checking';
  });

  useEffect(() => {
    let cancelled = false;
    const session = getDriverSession();
    if (!session?.id) {
      setStatus('denied');
      return undefined;
    }
    if (isFresh(session.id)) {
      setStatus('ok');
      return undefined;
    }

    (async () => {
      const ok = await isCurrentDriverApprovedForWork(session.id);
      if (cancelled) return;
      // Only an explicit "no" from the database ends the session. `null` means the
      // check itself failed; the driver stays signed in and the next route change
      // checks again.
      if (ok === false) {
        clearDriverSession();
        verified = { id: '', at: 0 };
        setStatus('denied');
        return;
      }
      if (ok === true) verified = { id: session.id, at: Date.now() };
      setStatus('ok');
    })();

    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  if (status === 'checking') {
    return (
      <div
        className="driver-app"
        style={{
          minHeight: '40vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#07408f',
          fontWeight: 600,
          fontSize: '0.9rem',
        }}
        role="status"
        aria-live="polite"
      >
        Checking driver account…
      </div>
    );
  }

  if (status === 'denied') {
    return (
      <Navigate
        to="/driver/login"
        replace
        state={{
          pendingApproval: true,
          emailVerified: true,
          from: location.pathname,
        }}
      />
    );
  }

  return children;
}
