import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DeliveryPin from '../components/DeliveryPin';
import PackagePhotoCapture from '../components/PackagePhotoCapture';
import DriverJobState from '../components/driver/DriverJobState';
import { jobPath, useDriverJob } from '../components/driver/useDriverJob';
import { formatGBP } from '../lib/currency';
import './driverDelivery.css';

const STEPS = [
  { id: 1, label: 'Order Accepted' },
  { id: 2, label: 'Heading to Pickup' },
  { id: 3, label: 'Package Picked Up' },
  { id: 4, label: 'In Transit' },
  { id: 5, label: 'Delivered' },
];

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

const fmt$ = (n) => formatGBP(n);

export default function DriverDeliveryStatusPage() {
  const navigate = useNavigate();
  const { order, status: jobStatus, error: jobError, reload: reloadJob } = useDriverJob();
  const o = useMemo(() => order || {}, [order]);
  const activeStep = 4;
  const [showModal, setShowModal] = useState(false);
  const [success, setSuccess] = useState(false);
  const [photo, setPhoto] = useState('');
  const [note, setNote] = useState('');
  const [otp, setOtp] = useState('');

  const confirm = useCallback(() => {
    if (!photo) return;
    setShowModal(false);
    setSuccess(true);
  }, [photo]);

  if (success) {
    return (
      <div className="ds-suc" role="status" aria-live="polite" aria-label="Delivery complete">
        <div className="ds-sucB" aria-hidden>
          ✓
        </div>
        <h1 className="ds-sucT">Delivery Complete!</h1>
        <p className="ds-sucE">You earned {fmt$(o.amount)} for this trip</p>
        <Link to="/driver/home" replace className="ds-sucBtn">
          Back to Home
        </Link>
      </div>
    );
  }

  if (jobStatus !== 'ready') {
    return <DriverJobState status={jobStatus} error={jobError} label="delivery" onRetry={reloadJob} />;
  }

  return (
    <div className="ds-page" role="main" aria-label="Update status">
      <div className="ds-h2">
        <button type="button" className="ds-bk" onClick={() => navigate('/driver/home')} aria-label="Back">
          <Back />
        </button>
        <h1 className="ds-t">Update Status</h1>
      </div>
      <div className="ds-sc2" role="list" aria-label="Order progress" style={{ paddingLeft: 4 }}>
        {STEPS.map((s, i) => {
          const n = s.id;
          const done = n < activeStep;
          const isCur = n === activeStep;
          const future = n > activeStep;
          return (
            <div
              key={s.id}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'flex-start',
                marginBottom: i < STEPS.length - 1 ? 2 : 0,
                minHeight: 28,
              }}
            >
              <div
                style={{
                  width: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                {done && (
                  <div className="ds-stIco ds-stIco--d" style={{ zIndex: 1 }} aria-hidden>
                    ✓
                  </div>
                )}
                {isCur && !done && n < 5 && (
                  <div className="ds-stIco ds-stIco--a" aria-current="step" style={{ zIndex: 1 }}>
                    <div className="pulsingInner" />
                  </div>
                )}
                {future && n < 5 && (
                  <div className="ds-stIco" style={{ zIndex: 1, background: '#fff' }} aria-hidden>
                    {' '}
                  </div>
                )}
                {n === 5 && future && (
                  <div className="ds-stIco" style={{ zIndex: 1, background: '#f5f5f5', border: '1.5px solid #c8c8c8' }} />
                )}
                {i < STEPS.length - 1 && (
                  <div
                    style={{
                      width: 2.5,
                      flex: 1,
                      minHeight: 8,
                      background: done ? '#F18631' : '#e0e0e0',
                      marginTop: 1,
                    }}
                    aria-hidden
                  />
                )}
              </div>
              <p
                style={{
                  margin: 0,
                  marginLeft: 6,
                  paddingTop: 1,
                  fontSize: 12,
                  fontWeight: 800,
                  lineHeight: 1.2,
                  color: done ? '#1a7a32' : future ? '#8a8a8a' : isCur && n === 4 ? '#F18631' : '#1a1a1a',
                }}
              >
                {isCur && n === 4 && (
                  <span className="ds-stL--m" style={{ display: 'block', fontSize: 7, marginBottom: 2, letterSpacing: 0.03 }}>
                    Current
                  </span>
                )}
                {s.label}
              </p>
            </div>
          );
        })}
      </div>
      <div className="ds-sc2" role="region" aria-label="Status and actions" style={{ marginTop: 4 }}>
        <div className="ds-card2" style={{ maxWidth: '100%' }}>
          <span className="ds-bdg2">Currently: In Transit</span>
          <p className="ds-adL">
            <strong>From:</strong>
            {' '}
            {o.from}
          </p>
          <p className="ds-adL" style={{ margin: '0.1rem 0' }}>
            <strong>To:</strong>
            {' '}
            {o.to}
          </p>
          <div className="ds-elT">~12 min since pickup (demo)</div>
        </div>
        <button type="button" className="ds-bt2" onClick={() => setShowModal(true)}>
          Mark as Delivered
        </button>
        <button
          type="button"
          className="ds-bt2 ds-bt2--c"
          onClick={() => window.alert('We will help you. (Demo)')}
        >
          Cannot Deliver
        </button>
        <Link
          to="/chat"
          className="ds-bt2 ds-bt2--g2"
          state={{ name: o.customerName, role: 'driver' }}
          style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}
        >
          Contact Customer
        </Link>
        <button
          type="button"
          className="ds-bt2 ds-bt2--g2"
          onClick={() =>
            navigate(jobPath('navigation', o), {
              state: {
                order: o,
                pickup: o.from,
                dropoff: o.to,
                dest: o.to,
                phase: 'dropoff',
                navLeg: 'toDropoff',
              },
            })
          }
        >
          Open full map
        </button>
      </div>
      {showModal && (
        <div className="ds-mod" role="presentation" onClick={() => setShowModal(false)}>
          <div className="ds-mod2" role="dialog" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '90vh' }}>
            <h2>Confirm Delivery</h2>
            <div style={{ margin: '0.35rem 0.6rem 0.5rem' }}>
              <PackagePhotoCapture
                compact
                required
                value={photo}
                onChange={(url) => setPhoto(url || '')}
                label="Proof of delivery"
                hint="Take or upload a photo of the delivered package."
              />
            </div>
            <p style={{ fontSize: 10, color: '#6b6b6b', margin: '0.1rem 0.6rem' }}>Delivery note (optional)</p>
            <input
              className="dd-inp"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ maxWidth: '92%', textAlign: 'left', display: 'block', margin: '0 auto' }}
              placeholder="Leave with guard…"
            />
            <p style={{ textAlign: 'center', fontSize: 9, color: '#888', margin: 6 }}>Or verify with the customer 6-digit PIN</p>
            <div className="ms-otp" style={{ marginBottom: 4 }}>
              <DeliveryPin idPrefix="dropoff-pin" value={otp} onChange={setOtp} ariaLabel="Enter 6-digit delivery PIN from customer" />
            </div>
            <div style={{ padding: '0 0.3rem' }}>
              <button type="button" className="ds-bt2" onClick={confirm} disabled={!photo}>
                Confirm Delivery
              </button>
            </div>
            <div style={{ textAlign: 'right', margin: 4, padding: '0 0.2rem' }}>
              <button type="button" className="nav-can" onClick={() => setShowModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
