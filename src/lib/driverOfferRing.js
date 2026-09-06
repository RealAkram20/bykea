/** Web Audio phone ring + browser notifications when a new driver offer appears. */

let audioCtx = null;

/** @type {Map<string, { timer: number | null, master: GainNode | null, stopped: boolean }>} */
const activeRings = new Map();

/** Shared burst cadence while any offer is actively ringing. */
const BURST_CYCLE_SEC = 1.55;
const MAX_RING_MS = 120_000;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  return audioCtx;
}

/** Call after a user gesture so browsers allow playback. */
export function unlockDriverOfferAudio() {
  const ac = getAudioContext();
  if (!ac) return { ok: false, ready: false };
  if (ac.state === 'suspended') {
    ac.resume().catch(() => {});
  }
  return { ok: true, ready: ac.state === 'running' };
}

/** Whether Web Audio is unlocked and ready to ring without another gesture. */
export function isDriverOfferAudioReady() {
  const ac = getAudioContext();
  return Boolean(ac && ac.state === 'running');
}

/**
 * @returns {'unsupported' | 'default' | 'denied' | 'granted'}
 */
export function getDriverNotificationPermission() {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Must be called from a user gesture.
 * @returns {Promise<'unsupported' | 'default' | 'denied' | 'granted'>}
 */
export async function requestDriverNotificationPermission() {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result || Notification.permission;
  } catch {
    return Notification.permission;
  }
}

/**
 * @param {AudioContext} ac
 * @param {AudioNode} dest
 * @param {number} freq
 * @param {number} start
 * @param {number} duration
 * @param {number} peakGain
 */
function tone(ac, dest, freq, start, duration, peakGain = 0.42) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(peakGain, 0.0002), start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g);
  g.connect(dest);
  osc.start(start);
  osc.stop(start + duration + 0.04);
}

/**
 * @param {AudioContext} ac
 * @param {AudioNode} dest
 * @param {number} start
 */
function phoneBurst(ac, dest, start) {
  const on = 0.52;
  const gap = 0.14;
  tone(ac, dest, 440, start, on);
  tone(ac, dest, 480, start, on);
  tone(ac, dest, 880, start, on * 0.85, 0.18);
  tone(ac, dest, 440, start + on + gap, on);
  tone(ac, dest, 480, start + on + gap, on);
  tone(ac, dest, 880, start + on + gap, on * 0.85, 0.18);
}

function vibrateNewOffer() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate([500, 120, 500, 120, 500, 280, 500, 120, 500, 120, 500]);
  } catch {
    /* ignore */
  }
}

function stopVibrate() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(0);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} offerKey
 */
function makeRingTag(offerKey) {
  return `ingo-offer-${String(offerKey || '').trim() || 'unknown'}`;
}

/**
 * Best-effort close of system notifications for this offer.
 * @param {string} [offerKey]
 */
export function dismissDriverOfferNotifications(offerKey) {
  if (typeof window === 'undefined') return;
  const tag = offerKey ? makeRingTag(offerKey) : null;
  try {
    const banner = document.getElementById('ingo-native-offer-banner');
    if (banner) {
      const bannerTag = banner.getAttribute('data-ingo-tag') || '';
      if (!tag || !bannerTag || bannerTag === tag) banner.remove();
    }
  } catch {
    /* ignore */
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    try {
      navigator.serviceWorker.controller.postMessage({
        type: 'ingo-offer-stop',
        tag: tag || undefined,
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Tear down one active ring session.
 * @param {string} offerKey
 * @param {{ silent?: boolean }} [opts]
 */
function teardownRing(offerKey, opts = {}) {
  const session = activeRings.get(offerKey);
  if (!session) return;
  session.stopped = true;
  if (session.timer != null) {
    window.clearTimeout(session.timer);
    session.timer = null;
  }
  if (session.master) {
    try {
      session.master.gain.setValueAtTime(0.0001, getAudioContext()?.currentTime || 0);
      session.master.disconnect();
    } catch {
      /* ignore */
    }
    session.master = null;
  }
  activeRings.delete(offerKey);
  if (!opts.silent) {
    stopVibrate();
    dismissDriverOfferNotifications(offerKey);
  }
}

/**
 * Keys of every ring currently sounding, whoever started it (the offers
 * provider's own loop, or a push through notifyDriverNewOffer). The provider
 * uses this to stop a ring for an offer that vanished from its list.
 * @returns {string[]}
 */
export function getActiveDriverOfferRingKeys() {
  return [...activeRings.keys()];
}

/**
 * Stop ringing for one offer (or all). Driven by backend offer lifecycle.
 * @param {string} [offerKey]
 */
export function stopDriverOfferRing(offerKey) {
  if (offerKey) {
    teardownRing(String(offerKey));
    if (activeRings.size === 0) stopVibrate();
    return;
  }
  stopAllDriverOfferRings();
}

export function stopAllDriverOfferRings() {
  for (const key of [...activeRings.keys()]) {
    teardownRing(key, { silent: true });
  }
  stopVibrate();
  dismissDriverOfferNotifications();
}

/**
 * Schedule looping phone bursts until stopped or max duration.
 * @param {string} offerKey
 * @param {{ maxMs?: number }} [opts]
 */
export function startDriverOfferRing(offerKey, opts = {}) {
  const key = String(offerKey || '').trim();
  if (!key) {
    playDriverNewOfferRing();
    return;
  }
  if (activeRings.has(key)) return;

  const ac = getAudioContext();
  if (!ac) return;
  if (ac.state === 'suspended') {
    ac.resume()
      .then(() => startDriverOfferRing(key, opts))
      .catch(() => {});
    return;
  }

  const master = ac.createGain();
  master.gain.value = 1.35;

  const comp = ac.createDynamicsCompressor();
  comp.threshold.setValueAtTime(-18, ac.currentTime);
  comp.knee.setValueAtTime(8, ac.currentTime);
  comp.ratio.setValueAtTime(12, ac.currentTime);
  comp.attack.setValueAtTime(0.002, ac.currentTime);
  comp.release.setValueAtTime(0.12, ac.currentTime);

  master.connect(comp);
  comp.connect(ac.destination);

  const startedAt = Date.now();
  const maxMs = typeof opts.maxMs === 'number' && opts.maxMs > 0 ? opts.maxMs : MAX_RING_MS;

  /** @type {{ timer: number | null, master: GainNode | null, stopped: boolean }} */
  const session = { timer: null, master, stopped: false };
  activeRings.set(key, session);

  const scheduleBurst = () => {
    const current = activeRings.get(key);
    if (!current || current.stopped || current !== session) return;
    if (Date.now() - startedAt >= maxMs) {
      teardownRing(key);
      return;
    }
    try {
      phoneBurst(ac, master, ac.currentTime + 0.02);
      vibrateNewOffer();
    } catch {
      /* ignore */
    }
    current.timer = window.setTimeout(scheduleBurst, Math.round(BURST_CYCLE_SEC * 1000));
  };

  scheduleBurst();
}

/** One-shot dual-tone phone ring (legacy / extra burst). Prefer startDriverOfferRing. */
export function playDriverNewOfferRing() {
  const ac = getAudioContext();
  if (!ac) return;
  if (ac.state === 'suspended') {
    ac.resume()
      .then(() => playDriverNewOfferRing())
      .catch(() => {});
    return;
  }

  const master = ac.createGain();
  master.gain.value = 1.35;

  const comp = ac.createDynamicsCompressor();
  comp.threshold.setValueAtTime(-18, ac.currentTime);
  comp.knee.setValueAtTime(8, ac.currentTime);
  comp.ratio.setValueAtTime(12, ac.currentTime);
  comp.attack.setValueAtTime(0.002, ac.currentTime);
  comp.release.setValueAtTime(0.12, ac.currentTime);

  master.connect(comp);
  comp.connect(ac.destination);

  const t0 = ac.currentTime + 0.04;
  for (let burst = 0; burst < 4; burst += 1) {
    phoneBurst(ac, master, t0 + burst * BURST_CYCLE_SEC);
  }

  vibrateNewOffer();
}

/**
 * System notification + sound/vibration for a new booking offer.
 * Falls back to an in-app banner when the OS Notification API is missing (common in native WebViews).
 * @param {{
 *   title?: string,
 *   body?: string,
 *   tag?: string,
 *   offerKey?: string,
 *   onClickPath?: string,
 *   sound?: boolean,
 *   banner?: boolean,
 *   loop?: boolean,
 *   maxMs?: number,
 * }} [opts]
 */
export function notifyDriverNewOffer(opts = {}) {
  const sound = opts.sound !== false;
  const banner = opts.banner !== false;
  const loop = opts.loop !== false;
  const offerKey = String(opts.offerKey || '').trim();

  if (sound) {
    if (loop && offerKey) startDriverOfferRing(offerKey, { maxMs: opts.maxMs });
    else playDriverNewOfferRing();
  }

  if (!banner) return;

  const title = opts.title || 'New InGo booking';
  const body = opts.body || 'Open the app to accept or reject.';
  const tag = opts.tag || (offerKey ? makeRingTag(offerKey) : `ingo-offer-${Date.now()}`);
  const onClickPath = opts.onClickPath || '/driver/home';

  let showedSystem = false;
  if (typeof window !== 'undefined' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body,
        tag,
        requireInteraction: true,
        silent: !sound,
      });
      showedSystem = true;
      n.onclick = () => {
        try {
          window.focus();
          if (onClickPath && window.location.pathname !== onClickPath) {
            window.location.assign(onClickPath);
          }
        } catch {
          /* ignore */
        }
        try {
          n.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      showedSystem = false;
    }
  }

  // Browser fallback only. In the native app the OS notification (Accept /
  // Decline, full-screen intent) and the in-app offer screen are the surfaces;
  // the DOM banner was dropped on 2026-09-03 at the client's request.
  if (!showedSystem && !isLikelyNativeWebView()) {
    showInAppOfferBanner({ title, body, tag, onClickPath });
  }
}

/**
 * Backend / push told us this offer is no longer open — stop audio + dismiss UI.
 * @param {string} [offerKey]
 * @param {string} [tag]
 */
export function handleDriverOfferStopSignal(offerKey, tag) {
  const key =
    String(offerKey || '').trim() ||
    String(tag || '')
      .replace(/^ingo-offer-/, '')
      .trim();
  if (key) stopDriverOfferRing(key);
  else stopAllDriverOfferRings();
  if (tag) {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'ingo-offer-stop', tag });
    } catch {
      /* ignore */
    }
  }
}

function isLikelyNativeWebView() {
  try {
    if (typeof window !== 'undefined' && window.Capacitor) return true;
    const ua = String(navigator.userAgent || '');
    return /; wv\)|WebView|Instagram|FBAN|FBAV/i.test(ua);
  } catch {
    return false;
  }
}

/**
 * Fixed top banner when system notifications are unavailable.
 * @param {{ title: string, body: string, tag: string, onClickPath: string }} opts
 */
function showInAppOfferBanner(opts) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('ingo-native-offer-banner');
  if (existing) existing.remove();

  const root = document.createElement('div');
  root.id = 'ingo-native-offer-banner';
  root.setAttribute('role', 'alert');
  root.setAttribute('data-ingo-tag', opts.tag || '');
  root.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:20000',
    'padding:calc(0.75rem + env(safe-area-inset-top,0)) 0.85rem 0.85rem',
    'background:linear-gradient(135deg,#07408f 0%,#05306e 55%,#ec6c23 160%)',
    'color:#fff',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif',
    'box-shadow:0 10px 28px rgba(7,64,143,0.35)',
    'animation:ingoNativeOfferIn .28s ease-out both',
  ].join(';');

  root.innerHTML = `
    <style>
      @keyframes ingoNativeOfferIn {
        from { transform: translateY(-110%); opacity: 0; }
        to { transform: none; opacity: 1; }
      }
    </style>
    <div style="display:flex;gap:0.75rem;align-items:flex-start;max-width:28rem;margin:0 auto">
      <div style="flex:1;min-width:0">
        <div style="font-weight:800;font-size:0.95rem;margin:0 0 0.2rem">${escapeHtml(opts.title)}</div>
        <div style="font-size:0.82rem;opacity:0.92;line-height:1.35">${escapeHtml(opts.body)}</div>
        <button type="button" data-ingo-open style="margin-top:0.55rem;border:none;border-radius:8px;background:#fff;color:#07408f;font-weight:700;font-size:0.8rem;padding:0.4rem 0.75rem">
          Open request
        </button>
      </div>
      <button type="button" data-ingo-close aria-label="Dismiss" style="border:none;background:transparent;color:#fff;font-size:1.4rem;line-height:1;padding:0 0.2rem;opacity:0.85">×</button>
    </div>
  `;

  const remove = () => {
    try {
      root.remove();
    } catch {
      /* ignore */
    }
  };

  root.querySelector('[data-ingo-close]')?.addEventListener('click', remove);
  root.querySelector('[data-ingo-open]')?.addEventListener('click', () => {
    remove();
    try {
      if (opts.onClickPath && window.location.pathname !== opts.onClickPath) {
        window.location.assign(opts.onClickPath);
      }
    } catch {
      /* ignore */
    }
  });

  document.body.appendChild(root);
  window.setTimeout(remove, 16000);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
