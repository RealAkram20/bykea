import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DEFAULT_DRIVER_NOTIF_PREFS,
  fetchDriverNotifPrefs,
  saveDriverNotifPrefs,
} from '../lib/driverNotificationPrefs';
import { getDriverSession } from '../lib/driverSession';
import './driverProfilePremium.css';
import './driverNotifications.css';

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d="M15.5 19.5L8 12l7.5-7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IcBell() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d="M12 3a4.5 4.5 0 0 0-4.5 4.5V10l-1.2 2.4A1 1 0 0 1 7.2 14h9.6a1 1 0 0 1 .9-1.6L17 10V7.5A4.5 4.5 0 0 0 12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
      <path d="M10.5 18a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Toggle({ id, checked, disabled, onChange, label, hint }) {
  return (
    <label className={`dn-toggle${disabled ? ' dn-toggle--off' : ''}`} htmlFor={id}>
      <span className="dn-toggle__text">
        <span className="dn-toggle__label">{label}</span>
        {hint ? <span className="dn-toggle__hint">{hint}</span> : null}
      </span>
      <input
        id={id}
        type="checkbox"
        className="dn-toggle__input"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="dn-toggle__track" aria-hidden>
        <span className="dn-toggle__thumb" />
      </span>
    </label>
  );
}

export default function DriverNotificationsPage() {
  const navigate = useNavigate();
  const session = getDriverSession();
  const driverId = session?.id || null;

  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_DRIVER_NOTIF_PREFS }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!driverId) {
      navigate('/driver/login', { replace: true });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const { prefs: next, error: err } = await fetchDriverNotifPrefs(driverId);
      if (cancelled) return;
      setPrefs(next);
      if (err) setError(err);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [driverId, navigate]);

  const applyPatch = useCallback(
    async (key, value) => {
      if (!driverId) return;
      setSavingKey(key);
      setMessage('');
      setError('');

      // `push_when_closed` used to be pinned to false on every save, and the
      // sender then refused to push to any driver whose row said so — one tap
      // on "offer sound" switched every notification off for good (2026-09-06).
      // The sender no longer reads the flag; the row now says what is true:
      // offers are pushed whenever new offers are on.
      const patch = { [key]: value, push_when_closed: true };
      if (key === 'new_offers' && value === false) {
        patch.offer_sound = false;
      }
      if (key === 'offer_sound' && value === true) {
        patch.new_offers = true;
      }

      const { prefs: next, error: err } = await saveDriverNotifPrefs(driverId, patch);
      setPrefs({ ...next, push_when_closed: next.new_offers });
      if (err) setError(err);
      else setMessage('Saved.');
      setSavingKey('');
    },
    [driverId],
  );

  const masterOff = !prefs.new_offers;

  return (
    <div className="dpr dpr--premium dn-page" role="main" aria-label="Notification settings">
      <header className="dpr-nav">
        <Link to="/driver/profile" className="dn-back" aria-label="Back to profile">
          <BackIcon />
        </Link>
        <h1>Notifications</h1>
        <span className="dpr-navSpacer" aria-hidden />
      </header>

      <div className="dn-body">
        <div className="dn-hero">
          <span className="dn-hero__icon" aria-hidden>
            <IcBell />
          </span>
          <div>
            <p className="dn-hero__title">Offer alerts</p>
            <p className="dn-hero__sub">
              In-app alerts while the driver app is open. Offline push is turned off for now.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="dn-status">Loading your settings…</p>
        ) : (
          <>
            <section className="dn-card" aria-labelledby="dn-prefs-h">
              <h2 id="dn-prefs-h" className="dn-card__h">
                For this driver
              </h2>
              <div className="dn-list">
                <Toggle
                  id="dn-new-offers"
                  checked={prefs.new_offers}
                  disabled={Boolean(savingKey)}
                  onChange={(v) => applyPatch('new_offers', v)}
                  label="New booking offers"
                  hint="Toasts and alerts when a delivery, shop, or ride request is available"
                />
                <Toggle
                  id="dn-sound"
                  checked={prefs.offer_sound && prefs.new_offers}
                  disabled={Boolean(savingKey) || masterOff}
                  onChange={(v) => applyPatch('offer_sound', v)}
                  label="Ring & vibration"
                  hint="Play the phone-style ring when a new offer arrives (app open)"
                />
              </div>
            </section>

            {message ? (
              <p className="dn-flash" role="status">
                {message}
              </p>
            ) : null}
            {error ? (
              <p className="dn-flash dn-flash--err" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
