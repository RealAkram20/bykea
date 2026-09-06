import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { readDeviceGpsPosition } from '../../lib/devicePickupLocation';
import { fetchDriverNotifPrefs } from '../../lib/driverNotificationPrefs';
import { ensureOfferChannel, registerDriverPushToken } from '../../lib/driverPush';
import { getDriverSession } from '../../lib/driverSession';
import {
  getLocationPermission,
  getNativeState,
  getNotificationPermission,
  getPushPlugin,
  isNativeApp,
  openAppSettings,
  openBatterySettings,
  openDndSettings,
  openFullScreenIntentSettings,
  openLocationSettings,
  openNotificationSettings,
  openOfferChannelSettings,
  requestLocationPermission,
  requestNotificationPermission,
  sendTestOffer,
} from '../../lib/nativePermissions';
import './driverPermissionsPanel.css';

const LOG = '[permissions]';

/**
 * Every permission an offer needs to reach this phone, with its real state and
 * the one action that changes it. Lives on the driver Profile. ADR 0005.
 *
 * States are read, not remembered: on mount, after every action, and whenever
 * the app comes back to the foreground (a driver returns from Settings by the
 * back button, and the row must already say the new truth).
 */
export default function DriverPermissionsPanel() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    const driverId = getDriverSession()?.id;
    const [location, notifications, native, prefsRes] = await Promise.all([
      getLocationPermission(),
      getNotificationPermission(),
      getNativeState(),
      driverId ? fetchDriverNotifPrefs(driverId).catch(() => null) : Promise.resolve(null),
    ]);
    setState({ location, notifications, native, prefs: prefsRes?.prefs || null });
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const run = useCallback(
    async (key, fn) => {
      setBusy(key);
      try {
        await fn();
      } catch (e) {
        console.warn(`${LOG} ${key}`, e?.message || e);
      } finally {
        setBusy('');
        refresh();
      }
    },
    [refresh],
  );

  if (!state) return null;

  const native = isNativeApp();
  const rows = [];

  /* ---- Location ---- */
  {
    const perm = state.location;
    const servicesOn = state.native ? state.native.locationServicesOn !== false : true;
    let pill = 'unknown';
    let pillText = 'Unknown';
    let sub = 'Nearby customers are matched to your live position.';
    let action = null;
    if ((perm === 'granted' || perm === 'coarse') && !servicesOn) {
      pill = 'off';
      pillText = 'Location off';
      sub = 'Location is switched off on this phone. Turn it on to receive nearby offers.';
      action = { label: 'Turn on', run: () => openLocationSettings() };
    } else if (perm === 'granted') {
      pill = 'ok';
      pillText = 'Allowed';
    } else if (perm === 'coarse') {
      pill = 'warn';
      pillText = 'Approximate only';
      sub = 'Choose Precise location so pickups are matched to where you actually are.';
      action = native ? { label: 'Open settings', run: () => openAppSettings() } : null;
    } else if (perm === 'prompt') {
      pill = 'warn';
      pillText = 'Not allowed yet';
      action = {
        label: 'Allow',
        run: async () => {
          const r = await requestLocationPermission();
          if (r === 'granted' || r === 'coarse') {
            // Warm the first fix so the home screen is ready when the driver goes back.
            await readDeviceGpsPosition({ interactive: true }).catch(() => {});
          }
        },
      };
    } else if (perm === 'denied') {
      pill = 'off';
      pillText = 'Blocked';
      sub = native
        ? 'Location was refused for InGo. Open settings and allow it while using the app.'
        : 'Allow location for this site in your browser, then reload.';
      action = native ? { label: 'Open settings', run: () => openAppSettings() } : null;
    } else if (native) {
      action = { label: 'Allow', run: () => requestLocationPermission() };
    }
    rows.push({ key: 'location', title: 'Location', sub, pill, pillText, action });
  }

  /* ---- Notifications ---- */
  {
    const perm = state.notifications;
    let pill = 'unknown';
    let pillText = 'Unknown';
    let sub = 'New offers ring here even when the app is closed.';
    let action = null;
    if (perm === 'granted') {
      pill = 'ok';
      pillText = 'Allowed';
    } else if (perm === 'prompt') {
      pill = 'warn';
      pillText = 'Not allowed yet';
      action = {
        label: 'Allow',
        run: async () => {
          const r = await requestNotificationPermission();
          if (r === 'granted') {
            const id = getDriverSession()?.id;
            if (id) await registerDriverPushToken(id).catch(() => {});
          }
        },
      };
    } else if (perm === 'denied') {
      pill = 'off';
      pillText = 'Blocked';
      sub = native
        ? 'Notifications are off for InGo. Open settings and switch them on.'
        : 'Allow notifications for this site in your browser.';
      action = native ? { label: 'Open settings', run: () => openNotificationSettings() } : null;
    }
    rows.push({ key: 'notifications', title: 'Notifications', sub, pill, pillText, action });
  }

  /* ---- Offer alerts: the channel that decides whether a ring pops on screen ---- */
  if (state.native && state.native.offerChannel) {
    const ch = state.native.offerChannel;
    let pill = 'ok';
    let pillText = 'Pops on screen';
    let sub = 'New offers appear on top of whatever you are doing, with Accept and Decline.';
    let action = null;
    if (!ch.exists) {
      pill = 'warn';
      pillText = 'Not set up';
      sub = 'The offer alert channel is created on first sign-in. Set it up now.';
      action = {
        label: 'Set up',
        run: async () => {
          const P = await getPushPlugin();
          if (P) await ensureOfferChannel(P);
        },
      };
    } else if (ch.headsUp === false) {
      pill = 'off';
      pillText = ch.importance === 0 ? 'Blocked' : 'Silent';
      sub = 'Offers land quietly in the notification shade. Set "Driver offers" to pop on screen with sound.';
      action = { label: 'Open setting', run: () => openOfferChannelSettings() };
    } else if (ch.healed) {
      sub =
        'The original alert channel had been set to silent or blocked on this phone, so offers now use a fresh channel that pops on screen.';
    }
    rows.push({ key: 'channel', title: 'Offer alerts', sub, pill, pillText, action });
  }

  /* ---- The last push this phone received, as the native side saw it ---- */
  if (state.native) {
    const last = state.native.lastRing;
    if (!last) {
      rows.push({
        key: 'lastpush',
        title: 'Last offer push',
        sub: 'No offer push has reached this phone yet. Send a test offer below, or go online and wait for a real order.',
        pill: 'unknown',
        pillText: 'None yet',
        action: null,
      });
    } else {
      const when = new Date(Number(last.at));
      const mins = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
      const agoText = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
      const clock = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const problems = [];
      if (last.notifications === false) problems.push('notifications were blocked');
      if (Number(last.importance) >= 0 && Number(last.importance) < 4) problems.push('the alert channel was silent');
      if (last.doNotDisturb) problems.push('Do not disturb was on');
      const ok = problems.length === 0;
      rows.push({
        key: 'lastpush',
        title: 'Last offer push',
        sub: `${agoText} (${clock}), screen ${last.screenOn ? 'on' : 'off'}${last.tag === 'ingo-offer-test' ? ', the test offer' : ''}. ${
          ok ? 'Nothing on the phone stood in its way.' : `At that moment ${problems.join(', ')}.`
        }`,
        pill: ok ? 'ok' : 'off',
        pillText: ok ? 'Arrived' : 'Arrived, hidden',
        action: null,
      });
    }
  }

  /* ---- Makers with their own pop-up switch, outside the channel ---- */
  const maker = String(state.native?.manufacturer || '').toLowerCase();
  const oem = [
    [/xiaomi|redmi|poco/, 'Xiaomi', 'Floating notifications'],
    [/tecno|infinix|itel/, 'Tecno / Infinix', 'Floating notifications'],
    [/oppo|realme|oneplus/, 'Oppo / Realme / OnePlus', 'Banner notifications'],
    [/vivo|iqoo/, 'Vivo', 'Top banner'],
    [/huawei|honor/, 'Huawei / Honor', 'Banners'],
    [/samsung/, 'Samsung', 'Pop-up style: Detailed'],
  ].find(([re]) => re.test(maker));
  if (native && oem) {
    rows.push({
      key: 'oem',
      title: `Pop-up on ${oem[1]}`,
      sub: `This phone has its own switch for pop-up alerts, which the app cannot read. In InGo's notification settings make sure "${oem[2]}" is on for Driver offers, and allow InGo to Autostart.`,
      pill: 'warn',
      pillText: 'Check',
      action: { label: 'Open settings', run: () => openNotificationSettings() },
    });
  }

  /* ---- Full-screen offers (Android 14+ only) ---- */
  if (state.native && state.native.fullScreenIntent && state.native.fullScreenIntent !== 'not_needed') {
    const granted = state.native.fullScreenIntent === 'granted';
    rows.push({
      key: 'fullscreen',
      title: 'Full-screen offers',
      sub: granted
        ? 'An offer can wake the phone and show over the lock screen.'
        : 'Lets an offer wake the phone and stay on screen instead of a small banner.',
      pill: granted ? 'ok' : 'warn',
      pillText: granted ? 'Allowed' : 'Off',
      action: granted ? null : { label: 'Open setting', run: () => openFullScreenIntentSettings() },
    });
  }

  /* ---- Battery ---- */
  if (state.native) {
    const optimised = state.native.batteryOptimised !== false;
    rows.push({
      key: 'battery',
      title: 'Battery',
      sub: optimised
        ? 'Set InGo to Unrestricted so offers still arrive when the app has been closed for a while. On Xiaomi, Huawei, Oppo, Vivo and Tecno phones also allow Autostart for InGo.'
        : 'Unrestricted. Android will not put InGo to sleep.',
      pill: optimised ? 'warn' : 'ok',
      pillText: optimised ? 'Optimised' : 'Unrestricted',
      action: optimised ? { label: 'Open settings', run: () => openBatterySettings() } : null,
    });
  }

  /* ---- Do Not Disturb: hides a heads-up entirely, and the phone never says so ---- */
  if (state.native && state.native.doNotDisturb === true) {
    rows.push({
      key: 'dnd',
      title: 'Do not disturb',
      sub: 'Do not disturb is on. Offers will not pop on screen or make a sound until it is off.',
      pill: 'off',
      pillText: 'On',
      action: { label: 'Open settings', run: () => openDndSettings() },
    });
  }

  /* ---- The driver's own switch: Profile → Notifications → New offers ---- */
  if (state.prefs && state.prefs.new_offers === false) {
    rows.push({
      key: 'prefs',
      title: 'Offer alerts in InGo',
      sub: 'New offers are switched off in Notifications. Nothing rings or pops until they are on.',
      pill: 'off',
      pillText: 'Off',
      link: { to: '/driver/notifications', label: 'Open' },
    });
  }

  return (
    <section className="dpp" aria-labelledby="dpp-h">
      <h2 id="dpp-h" className="dpp__h">
        Permissions
      </h2>
      {rows.map((row) => (
        <div key={row.key} className="dpp-row">
          <span className="dpp-row__text">
            <span className="dpp-row__head">
              <span className="dpp-row__title">{row.title}</span>
              <span className={`dpp-pill dpp-pill--${row.pill}`}>{row.pillText}</span>
            </span>
            <span className="dpp-row__sub">{row.sub}</span>
          </span>
          {row.action ? (
            <button
              type="button"
              className="dpp-btn"
              disabled={busy === row.key}
              onClick={() => run(row.key, row.action.run)}
            >
              {busy === row.key ? '…' : row.action.label}
            </button>
          ) : null}
          {row.link ? (
            <Link className="dpp-btn" to={row.link.to}>
              {row.link.label}
            </Link>
          ) : null}
        </div>
      ))}
      {native ? (
        <div className="dpp-row dpp-row--test">
          <span className="dpp-row__text">
            <span className="dpp-row__head">
              <span className="dpp-row__title">Test it</span>
            </span>
            <span className="dpp-row__sub">
              Sends a sample offer to this phone the same way a real one arrives. It should pop on screen with
              Accept and Decline.
            </span>
          </span>
          <button
            type="button"
            className="dpp-btn dpp-btn--ghost"
            disabled={busy === 'test'}
            onClick={() => run('test', () => sendTestOffer())}
          >
            {busy === 'test' ? '…' : 'Send test offer'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
