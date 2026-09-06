import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { clearDriverSession, getDriverSession } from '../lib/driverSession';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { formatVehicleTypeForDisplay } from '../lib/vehicleTypeDisplay';
import DriverPermissionsPanel from '../components/driver/DriverPermissionsPanel';
import './driverEarningsWalletProfile.css';
import './driverProfilePremium.css';
import './driverNotifications.css';

const DOC_ROWS = [
  { key: 'doc_national_id_url', label: 'National ID / Passport' },
  { key: 'doc_license_url', label: "Driver's license" },
  { key: 'doc_vehicle_registration_url', label: 'Vehicle registration' },
  { key: 'doc_profile_with_vehicle_url', label: 'Profile photo with vehicle' },
];

function initials(name) {
  const n = String(name || '').trim();
  if (!n) return '?';
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function docLinkLabel(url) {
  const u = String(url || '').trim();
  if (!u) return '—';
  if (u.startsWith('pending:')) return 'On file (pending upload)';
  if (isHttpUrl(u)) return 'Open file';
  return u.length > 40 ? `${u.slice(0, 40)}…` : u;
}

function IcSettings() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IcInfo() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden className="dpr-infoIcon">
      <circle cx="12" cy="12" r="7.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M12 10.2V16M12 7.2v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IcLogout() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden className="dpr-logoutIcon">
      <path
        d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IcFile() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden className="dpr-docIcon">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6M10 13h4M10 17h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IcVehicleType() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M5 17h14l-1-5H6l-1 5zM7 17a2 2 0 1 0 4 0M13 17a2 2 0 1 0 4 0M6 12l1.5-4h9L18 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IcWrench() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5 2.5 2.5 2.5-2.5-2.5-2.5 2.5-2.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IcPlate() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <rect x="3" y="7" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IcPalette() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M12 3a9 9 0 1 0 0 18c2.5 0 3-2 3-2s-.5-2-2-2h-1a3 3 0 0 1-3-3V9a4 4 0 0 1 4-4h1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="10" r="1" fill="currentColor" />
      <circle cx="10" cy="7" r="1" fill="currentColor" />
      <circle cx="14" cy="7" r="1" fill="currentColor" />
    </svg>
  );
}

const VEHICLE_ROWS = [
  { key: 'type', label: 'Type', Icon: IcVehicleType, value: (p) => formatVehicleTypeForDisplay(p.vehicle_type) || p.vehicle_type || '—' },
  {
    key: 'make',
    label: 'Make & Model',
    Icon: IcWrench,
    value: (p) => [p.vehicle_make, p.vehicle_model].filter(Boolean).join(' ') || '—',
  },
  { key: 'plate', label: 'Plate', Icon: IcPlate, value: (p) => p.vehicle_plate || '—' },
  { key: 'color', label: 'Color', Icon: IcPalette, value: (p) => p.vehicle_color || '—' },
];

function ProfileAvatar({ profile }) {
  const photo = profile.profile_photo_url;
  const showPhoto = photo && isHttpUrl(photo);
  if (showPhoto) {
    return (
      <img
        src={photo}
        alt=""
        style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return <div className="dpr-avInitials">{initials(profile.full_name)}</div>;
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

function IcChevron() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PremiumProfileShell({ children, profile }) {
  return (
    <div className="dpr dpr--premium" role="main" aria-label="Driver profile">
      <header className="dpr-nav">
        <span className="dpr-navSpacer" aria-hidden />
        <h1>Profile</h1>
        <Link to="/driver/notifications" className="dpr-settings" aria-label="Notification settings">
          <IcSettings />
        </Link>
      </header>
      <div className="dpr-headerBand">
        <div className="dpr-av" aria-hidden>
          <ProfileAvatar profile={profile} />
        </div>
        <div className="dpr-identity">
          <h2 className="dpr-n">{profile.full_name || 'Driver'}</h2>
          <p className="dpr-p">{profile.email || '—'}</p>
        </div>
      </div>
      <div className="dpr-sc">{children}</div>
    </div>
  );
}

export default function DriverProfilePage() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const session = getDriverSession();
    if (!session?.id) {
      navigate('/driver/login', { replace: true });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      if (!isSupabaseConfigured || !supabase) {
        if (!cancelled) {
          setProfile(session);
          setLoading(false);
        }
        return;
      }
      const { data, error } = await supabase.from('driver_registrations').select('*').eq('id', session.id).maybeSingle();
      if (cancelled) return;
      const merged = { ...session, ...(data && !error ? data : {}) };
      setProfile(merged);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const onLogout = () => {
    clearDriverSession();
    navigate('/driver/login', { replace: true });
  };

  if (!profile && loading) {
    return (
      <PremiumProfileShell profile={{ full_name: 'Loading…', email: '' }}>
        <p className="dpr-infoText" style={{ margin: 0, textAlign: 'center', color: '#6b7280' }}>
          Loading profile…
        </p>
      </PremiumProfileShell>
    );
  }

  if (!profile) return null;

  return (
    <PremiumProfileShell profile={profile}>
      <Link to="/driver/notifications" className="dn-menuRow">
        <span className="dn-menuRow__icon" aria-hidden>
          <IcBell />
        </span>
        <span className="dn-menuRow__text">
          <span className="dn-menuRow__title">Notifications</span>
          <span className="dn-menuRow__sub">Manage offer alerts, ring, and push</span>
        </span>
        <span className="dn-menuRow__chev" aria-hidden>
          <IcChevron />
        </span>
      </Link>

      <DriverPermissionsPanel />

      <Link to="/driver/chat" className="dpr-chatBtn">
        💬 Chat with Support
      </Link>

      <div className="dpr-infoCard" role="note">
        <IcInfo />
        <p className="dpr-infoText">
          Details below are what you submitted when you registered. Contact support if anything needs updating.
        </p>
      </div>

      <section className="dpr-section" aria-labelledby="dpr-contact-h">
        <h2 id="dpr-contact-h" className="dpr-secH">
          Contact &amp; ID
        </h2>
        <div className="dpr-secB dprRegCard">
          <div className="dprRegRow">
            <div className="dprRegLab">Phone</div>
            <div className="dprRegVal">
              {profile.phone_country_code ? `${profile.phone_country_code} ` : ''}
              {profile.phone || '—'}
            </div>
          </div>
          <div className="dprRegRow">
            <div className="dprRegLab">National ID / Passport</div>
            <div className="dprRegVal">{profile.national_id || '—'}</div>
          </div>
        </div>
      </section>

      <section className="dpr-section" aria-labelledby="dpr-vehicle-h">
        <h2 id="dpr-vehicle-h" className="dpr-secH">
          Vehicle
        </h2>
        <div className="dpr-secB dprRegCard">
          {VEHICLE_ROWS.map(({ key, label, Icon, value }) => (
            <div key={key} className="dpr-vehRow">
              <span className="dpr-vehIcon" aria-hidden>
                <Icon />
              </span>
              <div className="dpr-vehBody">
                <div className="dprRegLab">{label}</div>
                <div className="dprRegVal">{value(profile)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="dpr-section" aria-labelledby="dpr-docs-h">
        <h2 id="dpr-docs-h" className="dpr-secH">
          Documents you uploaded
        </h2>
        <div className="dpr-secB dprRegCard">
          {DOC_ROWS.map(({ key, label }) => {
            const url = profile[key];
            const u = String(url || '').trim();
            const openable = isHttpUrl(u);
            return (
              <div key={key} className="dpr-docRow">
                <IcFile />
                <span className="dpr-docName">{label}</span>
                {openable ? (
                  <a href={u} target="_blank" rel="noopener noreferrer" className="dpr-docView">
                    View
                  </a>
                ) : (
                  <span className="dpr-docMuted">{docLinkLabel(u)}</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <button type="button" className="dpr-logoutRow" onClick={onLogout} aria-label="Log out of driver app">
        <IcLogout />
        Log Out
      </button>
    </PremiumProfileShell>
  );
}
