import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { unlockDriverOfferAudio } from '../../lib/driverOfferRing';
import { isNativeApp, offersMayArriveSilently, openAppSettings } from '../../lib/nativePermissions';
import '../LocationPermissionPrompt.css';
import './driverPermissionPrompts.css';
import './driverPermissionsPanel.css';

/**
 * What the Home screen says while the driver is online and the phone is not
 * ready. ADR 0005.
 *
 * Location, in order of what the OS actually says (never a cached coordinate):
 *   - permission refused for good  → "Location is off", Open settings
 *   - permission not granted yet    → "Allow location", which shows the OS dialog
 *   - permission fine, no fix yet   → "Finding your location…", Retry
 * Plus a pointer to the Permissions panel when an offer would arrive silently
 * (notifications blocked, offer channel silent, full-screen access withheld).
 */
export default function DriverPermissionPrompts({ live, online }) {
  const [locBusy, setLocBusy] = useState(false);
  const [locDismissed, setLocDismissed] = useState(false);
  const [silentRisk, setSilentRisk] = useState(false);

  useEffect(() => {
    if (!online) return undefined;
    // Unlock in-app ring on first tap anywhere (no offline push prompt).
    const unlock = () => unlockDriverOfferAudio();
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, [online]);

  // A dismissal lasts until the situation changes: a new refusal, or a fix that
  // later goes missing, asks again.
  useEffect(() => {
    if (live?.located) setLocDismissed(false);
  }, [live?.located]);

  // Re-read whenever the app comes back to the foreground: the driver may have
  // just returned from Settings, and the pointer must disappear on its own.
  useEffect(() => {
    if (!online || !isNativeApp()) return undefined;
    let cancelled = false;
    const check = () => {
      offersMayArriveSilently()
        .then((v) => {
          if (!cancelled) setSilentRisk(v);
        })
        .catch(() => {});
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [online]);

  const enableLocation = useCallback(async () => {
    if (!live?.refreshFromUserGesture) return;
    setLocBusy(true);
    try {
      await live.refreshFromUserGesture();
    } catch {
      /* geoError and permission are reflected on live */
    } finally {
      setLocBusy(false);
    }
  }, [live]);

  if (!online || !live) return null;

  const native = isNativeApp();
  const refused = live.permission === 'denied' || (!native && live.geoError === 'denied');
  const needLoc = !locDismissed && !live.located && live.geoError !== 'unsupported';

  let title = '';
  let text = '';
  let primary = null;
  if (needLoc) {
    if (refused) {
      title = 'Location is off';
      text = native
        ? 'Location was refused for InGo. Open settings, allow location while using the app, then come back.'
        : 'Allow location for this site in your browser or phone settings, then tap Retry. Customers nearby need your live position.';
      primary = native
        ? { label: 'Open settings', run: () => openAppSettings() }
        : { label: locBusy ? 'Checking…' : 'Retry location', run: enableLocation, busy: locBusy };
    } else if (live.needsPermission || live.permission == null) {
      title = 'Turn on location';
      text = 'Allow location so nearby customers can find you and you can receive nearby bookings while online.';
      primary = { label: locBusy ? 'Asking…' : 'Allow location', run: enableLocation, busy: locBusy };
    } else {
      title = 'Finding your location…';
      text =
        live.geoError === 'unavailable'
          ? 'No fix yet. Make sure Location is on and try again, ideally near a window or outdoors.'
          : 'Location is allowed. Waiting for the first fix from your phone.';
      primary = { label: locBusy ? 'Locating…' : 'Retry', run: enableLocation, busy: locBusy };
    }
  }

  return (
    <div className="drv-perm-stack" aria-live="polite">
      {silentRisk ? (
        <Link to="/driver/profile" className="dpp-alert" aria-label="Check permissions">
          <span>
            <span className="dpp-alert__title">Offers may arrive silently</span>
            Notifications, offer alerts or full-screen access are off on this phone.
          </span>
          <span className="dpp-alert__cta">Fix</span>
        </Link>
      ) : null}

      {needLoc ? (
        <aside className="loc-perm loc-perm--driver" role="alert" aria-label="Location permission">
          <p className="loc-perm__title">{title}</p>
          <p className="loc-perm__text">{text}</p>
          <div className="loc-perm__actions">
            <button
              type="button"
              className="loc-perm__btn loc-perm__btn--primary"
              disabled={Boolean(primary?.busy)}
              onClick={() => primary?.run()}
            >
              {primary?.label}
            </button>
            <button type="button" className="loc-perm__btn loc-perm__btn--ghost" onClick={() => setLocDismissed(true)}>
              Not now
            </button>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
