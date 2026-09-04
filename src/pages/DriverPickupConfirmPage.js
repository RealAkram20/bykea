import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DeliveryPin from '../components/DeliveryPin';
import PackagePhotoCapture from '../components/PackagePhotoCapture';
import DriverJobState from '../components/driver/DriverJobState';
import { jobPath, useDriverJob } from '../components/driver/useDriverJob';
import { DELIVERY_PIN_LENGTH } from '../lib/deliveryConfirmationCode';
import { isPackagePhotoSrc, persistParcelPackagePhoto } from '../lib/packagePhoto';
import { notifyShopOrderPickedUp } from '../lib/shopOrderPickedUpNotify';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import './driverDelivery.css';

const CHK = ['Package matches description', 'Package is sealed properly', 'Correct package size'];

function Back() {
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
function LocPin() {
  return (
    <svg className="pu-icoG" viewBox="0 0 24 24" width="40" height="40" fill="none" aria-hidden>
      <path
        d="M12 2.2a4.2 4.2 0 0 0-3.5 1.5L2.1 9.1a.6.6 0 0 0 .1.8L12 22.2l9.6-10.1a.6.6 0 0 0 0-1.2L15.4 3.7A4.1 4.1 0 0 0 12 2.2Z"
        fill="#F18631"
      />
      <circle cx="12" cy="8.2" r="1.2" fill="#fff" />
    </svg>
  );
}

export default function DriverPickupConfirmPage() {
  const navigate = useNavigate();
  const { order, status: jobStatus, error: jobError, reload: reloadJob } = useDriverJob();
  const o = useMemo(() => order || {}, [order]);
  const isParcel = String(o.bookingTable || '') === 'customer_delivery_orders' || String(o.bookingKind || '') === 'parcel';
  const customerPhoto = isPackagePhotoSrc(o.packagePhotoDataUrl) ? o.packagePhotoDataUrl : '';
  const [otp, setOtp] = useState('');
  const [checks, setChecks] = useState(() => ({}));
  const [driverPhoto, setDriverPhoto] = useState(() =>
    isPackagePhotoSrc(o.driverPackagePhotoDataUrl) ? o.driverPackagePhotoDataUrl : '',
  );
  const [photoErr, setPhotoErr] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleC = (label) => {
    setChecks((c) => ({ ...c, [label]: !c[label] }));
  };
  const can =
    CHK.every((c) => checks[c]) && otp.length === DELIVERY_PIN_LENGTH && (!isParcel || Boolean(driverPhoto));
  const next = useCallback(async () => {
    if (!can || saving) return;
    setPhotoErr('');
    setSaving(true);
    const orderId = o.supabaseOrderId;
    if (isParcel && orderId && driverPhoto) {
      const saved = await persistParcelPackagePhoto('driver', orderId, driverPhoto, 'driver-package.jpg');
      if (!saved.ok) {
        setSaving(false);
        setPhotoErr(saved.error || 'Could not save package photo.');
        return;
      }
    }
    if (isSupabaseConfigured && supabase && String(o.bookingTable || '') === 'shop_customer_orders' && orderId) {
      const { error } = await supabase.from('shop_customer_orders').update({ status: 'picked up' }).eq('id', orderId);
      if (!error) notifyShopOrderPickedUp(supabase, orderId);
    }
    setSaving(false);
    navigate(jobPath('navigation', o), {
      replace: true,
      state: {
        order: { ...o, driverPackagePhotoDataUrl: driverPhoto },
        pickup: o.from,
        dropoff: o.to,
        dest: o.to,
        navLeg: 'toDropoff',
        phase: 'dropoff',
        fromPickup: true,
      },
    });
  }, [can, driverPhoto, isParcel, navigate, o, saving]);

  if (jobStatus !== 'ready') {
    return <DriverJobState status={jobStatus} error={jobError} label="pickup" onRetry={reloadJob} />;
  }

  return (
    <div className="pu-page dd" role="main" aria-label="Confirm pickup">
      <header className="pu-h" style={{ position: 'relative' }}>
        <button type="button" className="pu-bk" onClick={() => navigate(-1)} aria-label="Back">
          <Back />
        </button>
        <h1>Confirm Pickup</h1>
      </header>
      <div
        className="pu-m"
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          viewBox="0 0 120 80"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          aria-hidden
        >
          <rect width="120" height="80" fill="url(#g0)" />
          <defs>
            <linearGradient id="g0" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#5a6a7a" />
              <stop offset="1" stopColor="#3a4a5a" />
            </linearGradient>
          </defs>
        </svg>
        <div className="pu-pinPulse" style={{ position: 'relative', zIndex: 1 }} aria-hidden />
      </div>
      <div className="pu-c">
        <LocPin />
        <p className="pu-ib">You are at pickup location</p>
        <p className="pu-ia2">{o.from}</p>
      </div>
      <div className="pu-s">
        <h2 className="pu-secL">Verify with customer PIN</h2>
        <div className="pu-otpR">
          <DeliveryPin
            idPrefix="pickup-pin"
            value={otp}
            onChange={setOtp}
            ariaLabel="Enter 6-digit delivery PIN from customer"
          />
        </div>
        <h2 className="pu-secL" style={{ marginTop: 8 }}>
          Confirm package details
        </h2>
        <div className="pu-chL" role="list">
          {CHK.map((label) => (
            <button type="button" key={label} className="pu-chI" onClick={() => toggleC(label)}>
              <span className={checks[label] ? 'pu-cb pu-cb--on' : 'pu-cb'} aria-hidden>
                {checks[label] ? '✓' : ''}
              </span>
              {label}
            </button>
          ))}
        </div>
        {isParcel && customerPhoto ? (
          <figure className="da-packagePhotoWrap" style={{ margin: '0.35rem auto', maxWidth: '20rem' }}>
            <figcaption className="da-packagePhotoCap">Customer photo</figcaption>
            <img className="da-packagePhotoImg" src={customerPhoto} alt="Customer package" />
          </figure>
        ) : null}
        {isParcel ? (
          <div style={{ maxWidth: '20rem', width: '100%', margin: '0.15rem auto 0.45rem' }}>
            <PackagePhotoCapture
              compact
              required
              value={driverPhoto}
              onChange={(url) => {
                setPhotoErr('');
                setDriverPhoto(url || '');
              }}
              label="Your package photo"
              hint="Take or upload a photo of the parcel you are picking up."
            />
          </div>
        ) : null}
        {photoErr ? (
          <p className="pu-ia2" role="alert" style={{ color: '#b91c1c', textAlign: 'center' }}>
            {photoErr}
          </p>
        ) : null}
        <button type="button" className="pu-sub" onClick={next} disabled={!can || saving}>
          {saving ? 'Saving photo…' : 'Confirm & Start Delivery'}
        </button>
        {!can && (
          <p className="pu-ia2" style={{ textAlign: 'center', color: '#999', fontSize: 11, margin: '0.1rem' }}>
            {isParcel
              ? 'Complete checklist, package photo, and 6-digit PIN'
              : 'Complete checklist and 6-digit PIN'}
          </p>
        )}
      </div>
    </div>
  );
}
