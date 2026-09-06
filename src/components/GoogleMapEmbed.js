import { useEffect, useState } from 'react';
import './GoogleMapEmbed.css';

/**
 * Renders a Maps embed iframe when `src` is non-empty.
 * Prefer passing a legacy `output=embed` URL on the driver portal so maps still
 * show when Maps Embed API / referrers block the keyed iframe.
 * Avoid remounting the iframe unless `src` actually changes (GPS jitter must not force a reload).
 *
 * The frame is a web page inside the app. When the phone's data drops at the
 * moment it loads, Android paints its own "Web page not available /
 * ERR_INTERNET_DISCONNECTED" page inside it, and an iframe never retries by
 * itself, so that page stayed until the map was next re-centred (a real phone,
 * 2026-09-06). Now: offline shows a quiet placeholder instead of the frame, and
 * the frame is re-issued when the connection returns or the app comes back to
 * the foreground.
 */
function useConnectionEpoch() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const up = () => {
      setOnline(true);
      setEpoch((n) => n + 1);
    };
    const down = () => setOnline(false);
    const visible = () => {
      if (document.visibilityState === 'visible') {
        setOnline(navigator.onLine !== false);
        setEpoch((n) => n + 1);
      }
    };
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return { online, epoch };
}

export default function GoogleMapEmbed({ src, title = 'Map', loading = 'eager', lockInteractions = false }) {
  const url = typeof src === 'string' ? src.trim() : '';
  const { online, epoch } = useConnectionEpoch();
  if (!url) {
    return (
      <div className="gmap-embed-wrap gmap-embed-wrap--empty" aria-hidden>
        <div className="gmap-embed-empty" />
      </div>
    );
  }
  if (!online) {
    return (
      <div className="gmap-embed-wrap gmap-embed-wrap--offline" role="status" aria-live="polite">
        <div className="gmap-embed-offline">
          <span className="gmap-embed-offline__title">Map paused</span>
          <span className="gmap-embed-offline__text">No internet connection. It comes back on its own.</span>
        </div>
      </div>
    );
  }
  return (
    <div className={lockInteractions ? 'gmap-embed-wrap gmap-embed-wrap--locked' : 'gmap-embed-wrap'}>
      <iframe
        key={`${url}#${epoch}`}
        className="gmap-embed-frame"
        title={title}
        src={url}
        loading={loading}
        allowFullScreen
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}
