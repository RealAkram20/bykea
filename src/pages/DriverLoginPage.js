import { useState } from 'react';
import { Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  getRememberedDriverEmail,
  isDriverSignedIn,
  saveDriverSession,
  setRememberedDriverEmail,
} from '../lib/driverSession';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { markDriverVerified } from '../components/driver/DriverApprovalGate';
import InGoLogo from '../components/InGoLogo';
import { LOGIN_HERO_ART } from '../lib/ingoLogo';
import './driverLoginPremium.css';

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

function IconEnvelope() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6h16v12H4V6Zm0 0 8 7 8-7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLock() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M8 11V8a4 4 0 0 1 8 0v3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconEye({ open }) {
  if (open) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 3l18 18M10.5 10.5a3 3 0 0 0 3 3M5.2 5.2C3.1 6.4 1.5 8.1 1 9.5c0 0 4 7 11 7 1.2 0 2.3-.2 3.3-.5M8.2 4.2C9.3 3.8 10.6 3.5 12 3.5c7 0 11 6.5 11 6.5-.2.4-1.1 1.6-2.4 2.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrustShield() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function TrustClock() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 8v5l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function TrustStar() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5l2.4 5.5 6 .5-4.5 4 1.4 5.9L12 16.8 6.7 19.4 8.1 13.5 3.6 9.5l6-.5L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TRUST_BADGES = [
  { icon: TrustShield, label: 'Safe & Secure' },
  { icon: TrustClock, label: 'Fast Payouts' },
  { icon: TrustStar, label: 'Top Rated Platform' },
];

export default function DriverLoginPage() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const [email, setEmail] = useState(() => getRememberedDriverEmail());
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (isDriverSignedIn()) {
    const from = state?.from;
    const target =
      typeof from === 'string' && from.startsWith('/driver') && !from.startsWith('/driver/login')
        ? from
        : '/driver/home';
    return <Navigate to={target} replace />;
  }

  const submit = async (e) => {
    e.preventDefault();
    setErrorMessage('');
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Add env vars and restart the dev server.');
      return;
    }
    const emailTrim = email.trim().toLowerCase();
    if (!emailTrim || !password) return;

    setIsSubmitting(true);
    try {
      let { data: rows, error: qErr } = await supabase
        .from('driver_registrations')
        .select(
          'id, full_name, email, phone, phone_country_code, password, status, vehicle_type, vehicle_make, vehicle_model, vehicle_plate, vehicle_color, created_at, account_mode, company_id',
        )
        .eq('email', emailTrim)
        .order('created_at', { ascending: false })
        .limit(8);

      if (qErr && /account_mode|company_id|column/i.test(qErr.message || '')) {
        ({ data: rows, error: qErr } = await supabase
          .from('driver_registrations')
          .select(
            'id, full_name, email, phone, phone_country_code, password, status, vehicle_type, vehicle_make, vehicle_model, vehicle_plate, vehicle_color, created_at',
          )
          .eq('email', emailTrim)
          .order('created_at', { ascending: false })
          .limit(8));
      }

      if (qErr) {
        setErrorMessage(qErr.message || 'Could not verify your account.');
        return;
      }

      const list = rows || [];
      const approved = list.find((r) => String(r.status || '').toLowerCase() === 'approved');
      const latest = list[0];

      if (approved) {
        if (approved.password !== password) {
          setErrorMessage('Incorrect password.');
          return;
        }
        saveDriverSession(approved, { rememberMe: remember });
        // This sign-in just read the approved row; the first screen need not ask again.
        markDriverVerified(approved.id);
        if (remember) setRememberedDriverEmail(emailTrim);
        else setRememberedDriverEmail('');
        const from = state?.from;
        const target =
          typeof from === 'string' && from.startsWith('/driver') && !from.startsWith('/driver/login')
            ? from
            : '/driver/home';
        navigate(target, { replace: true });
        return;
      }

      if (latest) {
        if (latest.password !== password) {
          setErrorMessage('Incorrect password.');
          return;
        }
        const st = String(latest.status || '').toLowerCase();
        if (st === 'pending') {
          setErrorMessage(
            'Your account is under approval. Once it is approved by an admin, you can log in and start working.',
          );
          return;
        }
        if (st === 'rejected') {
          setErrorMessage('This application was not approved. Contact support if you need help.');
          return;
        }
      }

      setErrorMessage('No driver account found for this email. Register first, then wait for approval.');
    } catch {
      setErrorMessage('Network error. Check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="dp-login-page">
      <header className="dp-login-hero">
        <button
          type="button"
          className="dp-login-hero-back"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <div className="dp-login-hero-waves" aria-hidden />
        <div className="dp-login-hero-top">
          <InGoLogo variant="hero" />
          <div className="dp-login-hero-badge" role="status">
            Driver Portal
          </div>
          <p className="dp-login-hero-tagline">Deliver. Earn. Grow.</p>
        </div>
        <div className="dp-login-hero-scene" aria-hidden>
          <img
            src={LOGIN_HERO_ART}
            alt=""
            className="dp-login-hero-art"
            decoding="async"
          />
        </div>
      </header>

      <main className="dp-login-body">
        <div className="dp-login-card">
          <form className="dp-login-form" onSubmit={submit} autoComplete="on">
            <h1 className="dp-login-title">Welcome Back, Driver</h1>
            <p className="dp-login-subtitle">
              Log in with your email and password (solo riders and company bikes). Approved drivers only.
            </p>

            {state?.passwordReset && (
              <p className="dp-login-flash" role="status">
                Password updated. Sign in with your new password.
              </p>
            )}
            {(state?.emailVerified || state?.pendingApproval) && (
              <p className="dp-login-flash" role="status">
                Your email is confirmed. Your account is under approval — once approved by an admin, you can log in and
                start working.
              </p>
            )}
            {state?.registered && (
              <p className="dp-login-flash" role="status">
                {state?.companyRegistered
                  ? 'Company application received. Give each biker their own email and password so they can log in after admin approval. Then open Fleet to oversee riders, orders, and earnings.'
                  : 'Application received. Wait for admin approval before you can log in and start working.'}
              </p>
            )}

            {errorMessage ? (
              <p className="dp-login-error" role="alert">
                {errorMessage}
              </p>
            ) : null}

            <div className="dp-login-field">
              <label className="dp-login-label" htmlFor="dlem">
                Email
              </label>
              <div className="dp-login-input-wrap">
                <span className="dp-login-iconbox" aria-hidden>
                  <IconEnvelope />
                </span>
                <input
                  className="dp-login-input"
                  id="dlem"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div className="dp-login-field">
              <label className="dp-login-label" htmlFor="dlpw">
                Password
              </label>
              <div className="dp-login-input-wrap">
                <span className="dp-login-iconbox" aria-hidden>
                  <IconLock />
                </span>
                <input
                  className="dp-login-input"
                  id="dlpw"
                  name="password"
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  className="dp-login-input-toggle"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                >
                  <IconEye open={!show} />
                </button>
              </div>
            </div>

            <div className="dp-login-forgot-row">
              <label className="dp-login-chk">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember me
              </label>
              <Link to="/forgot-password?realm=driver" className="dp-login-forgot">
                Forgot password
              </Link>
            </div>

            <button type="submit" className="dp-login-btn" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Login'}
            </button>
          </form>

          <div className="dp-login-or" aria-hidden>
            <span className="dp-login-or-line" />
            <span className="dp-login-or-text">OR</span>
            <span className="dp-login-or-line" />
          </div>

          <Link to="/driver/register" className="dp-login-register-btn">
            Register as a Driver
          </Link>
        </div>

        <p className="dp-login-customer-line">
          Are you a customer?{' '}
          <Link to="/login" className="dp-login-customer-link">
            Customer Login
          </Link>
        </p>
      </main>

      <footer className="dp-login-footer">
        <div className="dp-login-trust">
          {TRUST_BADGES.map(({ icon: Icon, label }) => (
            <div key={label} className="dp-login-trust-item">
              <span className="dp-login-trust-icon" aria-hidden>
                <Icon />
              </span>
              <span className="dp-login-trust-label">{label}</span>
            </div>
          ))}
        </div>
        <p className="dp-login-copyright">
          &copy; {new Date().getFullYear()} InGo. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
