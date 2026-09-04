import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { jobPath } from '../components/driver/useDriverJob';
import { formatGBP } from '../lib/currency';
import { driverOrderNeedsCashCollectionScreen } from '../lib/driverIncomingBookings';
import './chatNotifyRating.css';

export default function DriverCollectPaymentPage() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const rawOrder = state?.order;
  // Terminal step: the job is already completed, so it will not come back from
  // an active-jobs fetch. Router state is the source, and there is no fixture to
  // fall back to — no order means go home, which is what the effect below does.
  const o = useMemo(() => (rawOrder ? { ...rawOrder } : null), [rawOrder]);
  const needsCash = Boolean(o && driverOrderNeedsCashCollectionScreen(o));

  useEffect(() => {
    if (!o) {
      navigate('/driver/home', { replace: true });
      return;
    }
    if (!needsCash) {
      navigate(jobPath('rate-customer', o), { replace: true, state: { order: o } });
    }
  }, [o, needsCash, navigate]);

  const onCollected = () => {
    if (!o) return;
    navigate(jobPath('rate-customer', o), { replace: true, state: { order: o } });
  };

  if (!o || !needsCash) {
    return (
      <div className="drvRate" role="status" aria-live="polite">
        <div className="drvRate__wrap">
          <p className="drvCash__loading">Loading…</p>
        </div>
      </div>
    );
  }

  const customerName = String(o.customerName || '').trim() || 'Customer';
  const amt = Number(o.amount);
  const refLabel = String(o.id || '').trim();

  return (
    <div className="drvRate" role="main" aria-label="Collect payment">
      <div className="drvRate__wrap">
        <div className="drvRate__card drvCash__card">
          <div className="drvCash__iconWrap" aria-hidden>
            <svg className="drvCash__icon" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
              <path
                d="M16 20h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path d="M14 24h20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="30" cy="28" r="1.6" fill="currentColor" />
            </svg>
          </div>
          <h1 className="drvRate__title">Collect payment</h1>
          <p className="drvRate__sub">This order is cash on delivery. Take payment from the customer before you continue.</p>

          <div className="drvCash__amountBand" role="status">
            <span className="drvCash__amountLbl">Amount due</span>
            <p className="drvCash__amount">{Number.isFinite(amt) && amt > 0 ? formatGBP(amt) : formatGBP(0)}</p>
          </div>

          <div className="drvRate__meta drvCash__meta">
            <p className="drvRate__name">{customerName}</p>
            {refLabel ? <p className="drvRate__order">{refLabel}</p> : null}
            <p className="drvCash__hint">Confirm you have received cash, then continue to rate your customer.</p>
          </div>

          <button type="button" className="drvCash__btnPrimary" onClick={onCollected}>
            Payment collected
          </button>
        </div>
      </div>
    </div>
  );
}
