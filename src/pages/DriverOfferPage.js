import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { findOfferForKey, useDriverOffers } from '../components/driver/DriverOffersProvider';
import { useOfferActions } from '../components/driver/useOfferActions';
import { BID_TABLES, kindLabel, OfferPinDrop, OfferPinPickup } from '../components/driver/offerPresentation';
import {
  formatOfferTime,
  isCashCustomerPayment,
  isWalletCustomerPayment,
  openOfferSecondsLeft,
  OFFER_RING_CYCLE_MS,
} from '../lib/driverIncomingBookings';
import { formatGBP } from '../lib/currency';
import { unlockDriverOfferAudio } from '../lib/driverOfferRing';
import { readLastDeviceFix } from '../hooks/useLiveLocation';
import { formatDistanceKm, useOfferDistances } from '../lib/offerProximity';
import './driverOfferPage.css';

/** How long the screen keeps looking for an offer the poll has not returned yet (cold start). */
const LOOKUP_GRACE_MS = 30_000;

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconRoute() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d="M4 12h3l2 7 4-14 2 7h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The full-screen driver offer: one request, its facts, a timer, and two
 * buttons. Reached from the OS notification (tap, full-screen intent, or a
 * button while the offer loads), from a ring while the app is open (native),
 * and from the home card's toast on the web.
 *
 * The offer itself always comes from the provider's poll, never from the push
 * payload, so a request somebody else took shows "no longer available" rather
 * than stale detail.
 */
export default function DriverOfferPage() {
  const navigate = useNavigate();
  const { offerKey: param } = useParams();
  const key = useMemo(() => {
    try {
      return decodeURIComponent(param || '');
    } catch {
      return String(param || '');
    }
  }, [param]);

  const { offers, online, loadErr, ringingOfferKeys, live } = useDriverOffers();
  const { accept, reject, bid, actionMsg, setActionMsg, busyKey, bidModeKey, setBidModeKey, bidDraft, setBidDraft, myBids } =
    useOfferActions();

  const [mountedAt] = useState(() => Date.now());
  const [declined, setDeclined] = useState(false);
  const [, setTick] = useState(0);

  // The driver's own position, for "how far from you": the provider's live fix,
  // else the last fix the device stored, else unknown.
  const driverPos = live?.hasFix ? { lat: live.lat, lng: live.lng } : readLastDeviceFix();

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    unlockDriverOfferAudio();
    setActionMsg('');
  }, [key, setActionMsg]);

  const offer = useMemo(() => findOfferForKey(offers, key), [offers, key]);
  const k = offer ? `${offer.table}:${offer.id}` : '';
  const offerList = useMemo(() => (offer ? [offer] : []), [offer]);
  const { distances, pending: distancePending } = useOfferDistances(offerList, driverPos);
  const fromYouKm = offer ? distances.get(k) : null;
  const goHome = () => navigate('/driver/home', { replace: true });

  if (!offer) {
    const stillLooking = !declined && Date.now() - mountedAt < LOOKUP_GRACE_MS;
    return (
      <div className="dop" role="main" aria-label="Delivery request">
        <header className="dop__bar">
          <span className="dop__barTitle">Request</span>
          <button type="button" className="dop__close" aria-label="Close" onClick={goHome}>
            <IconClose />
          </button>
        </header>
        <div className="dop__state" role="status" aria-live="polite">
          {declined ? (
            <>
              <h1 className="dop__stateTitle">Declined</h1>
              <p className="dop__stateText">You will not be asked about this request again.</p>
              <button type="button" className="dop__btn dop__btn--primary" onClick={goHome}>
                Back to home
              </button>
            </>
          ) : stillLooking ? (
            <>
              <span className="dop__spinner" aria-hidden />
              <h1 className="dop__stateTitle">Fetching the request…</h1>
              <p className="dop__stateText">Checking that it is still open.</p>
            </>
          ) : (
            <>
              <h1 className="dop__stateTitle">
                {online ? 'This request is no longer available' : 'You are offline'}
              </h1>
              <p className="dop__stateText">
                {online
                  ? 'Another driver may have taken it, or it timed out.'
                  : 'Go online from the home screen to receive requests.'}
              </p>
              {loadErr ? (
                <p className="dop__alert" role="alert">
                  {loadErr}
                </p>
              ) : null}
              <button type="button" className="dop__btn dop__btn--primary" onClick={goHome}>
                Back to home
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const secLeft = openOfferSecondsLeft(offer.created_at);
  const pct = Math.max(0, Math.min(100, (secLeft / (OFFER_RING_CYCLE_MS / 1000)) * 100));
  const urgent = secLeft <= 10;
  const expired = secLeft <= 0;
  const busy = busyKey === k;
  const ringing = ringingOfferKeys.has(k);
  const canBid = BID_TABLES.includes(offer.table);

  const payMethod = String(offer.raw?.payment_method || '').toLowerCase();
  const isWalletPay = isWalletCustomerPayment(payMethod) || isWalletCustomerPayment(offer.customerPayment);
  const isCashPay = isCashCustomerPayment(payMethod) || isCashCustomerPayment(offer.customerPayment);
  const payLabel = isWalletPay
    ? 'Wallet payment'
    : isCashPay
      ? 'Cash payment'
      : offer.customerPayment && offer.customerPayment !== '—'
        ? offer.customerPayment
        : null;

  // For delivery orders `dist` already carries the ETA ("4.2 km · 9 min"); do not repeat it.
  const distLine = [offer.dist, offer.eta]
    .map((x) => String(x || '').trim())
    .filter((x, i, arr) => x && x !== '—' && (i === 0 || !arr[0].includes(x)))
    .join(' · ');

  const onDecline = async () => {
    const res = await reject(offer);
    if (res?.ok) setDeclined(true);
  };

  return (
    <div className={`dop${ringing ? ' dop--ringing' : ''}`} role="main" aria-label={`New ${kindLabel(offer.kind)} request`}>
      <div className="dop__srOnly" aria-live="assertive" aria-atomic="true">
        {ringing ? 'New request — respond now.' : ''}
      </div>

      <header className="dop__bar">
        <span className={`dop__kind dop__kind--${offer.kind}`}>{kindLabel(offer.kind)}</span>
        <span className="dop__ref">{offer.ref}</span>
        <button type="button" className="dop__close" aria-label="Close" onClick={goHome}>
          <IconClose />
        </button>
      </header>

      <div className="dop__scroll">
        <section className="dop__timer" aria-label="Time to respond">
          <p className={`dop__timerTxt${urgent ? ' dop__timerTxt--urgent' : ''}`} aria-live="off">
            {expired ? 'Time is up for this request' : `Respond in ${secLeft}s`}
          </p>
          <div className="dop__pb" aria-hidden>
            <div className={`dop__pbFill${urgent ? ' dop__pbFill--urgent' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="dop__when">Requested {formatOfferTime(offer.created_at)}</p>
        </section>

        <section className="dop__card" aria-label="Route">
          <div className="dop__stop">
            <span className="dop__pin" aria-hidden>
              <OfferPinPickup />
            </span>
            <div className="dop__stopBody">
              <span className="dop__stopLbl">Pickup</span>
              <p className="dop__addr">{offer.from || '—'}</p>
            </div>
          </div>
          <div className="dop__rail" aria-hidden />
          <div className="dop__stop">
            <span className="dop__pin" aria-hidden>
              <OfferPinDrop />
            </span>
            <div className="dop__stopBody">
              <span className="dop__stopLbl">Drop-off</span>
              <p className="dop__addr">{offer.to || '—'}</p>
            </div>
          </div>
          {distLine ? (
            <p className="dop__dist">
              <span className="dop__distIcon" aria-hidden>
                <IconRoute />
              </span>
              {distLine}
            </p>
          ) : null}
          <p className="dop__fromYou" role="status">
            {fromYouKm != null
              ? `Pickup is about ${formatDistanceKm(fromYouKm)} from you`
              : !driverPos
                ? '— Distance from you unknown: no GPS fix yet'
                : distancePending
                  ? 'Working out how far the pickup is from you…'
                  : '— Distance from you unknown: the pickup address could not be located'}
          </p>
        </section>

        {offer.pkg ? (
          <section className="dop__card dop__card--row" aria-label="Package">
            <span className="dop__lbl">Package</span>
            <p className="dop__val">{offer.pkg}</p>
          </section>
        ) : null}

        {payLabel ? (
          <section
            className={`dop__card dop__pay${isWalletPay ? ' dop__pay--wallet' : ''}${isCashPay ? ' dop__pay--cash' : ''}`}
            aria-label="Payment"
          >
            <div className="dop__row">
              <span className="dop__lbl">Payment</span>
              <span className="dop__payVal">{payLabel}</span>
            </div>
            {isWalletPay ? <p className="dop__payNote">Already paid through the Ingo Wallet. Do not collect cash.</p> : null}
            {isCashPay ? <p className="dop__payNote">Collect cash from the customer at drop-off.</p> : null}
          </section>
        ) : null}

        <section className="dop__price" aria-label="Customer offer">
          <span className="dop__priceLbl">Customer offer</span>
          <p className="dop__amt">{formatGBP(offer.amount)}</p>
          {offer.minimumAmount != null && offer.minimumAmount < offer.amount ? (
            <p className="dop__min">Minimum {formatGBP(offer.minimumAmount)}</p>
          ) : offer.minimumAmount != null ? (
            <p className="dop__min">Admin minimum {formatGBP(offer.minimumAmount)}</p>
          ) : null}
          {myBids[k] != null ? (
            <p className="dop__myBid" role="status">
              Your offer {formatGBP(myBids[k])} · waiting for the customer to choose you
            </p>
          ) : null}
        </section>

        {actionMsg ? (
          <p className="dop__alert" role="status">
            {actionMsg}
          </p>
        ) : null}

        {canBid && bidModeKey === k ? (
          <section className="dop__card dop__bid" aria-label="Counter-offer">
            <label className="dop__bidLbl" htmlFor="dop-bid">
              Your counter-offer (minimum {formatGBP(Math.max(offer.minimumAmount || 0, offer.amount))})
            </label>
            <div className="dop__bidRow">
              <input
                id="dop-bid"
                type="number"
                inputMode="decimal"
                step="0.5"
                min={Math.max(offer.minimumAmount || 0, offer.amount)}
                className="dop__bidInput"
                value={bidDraft}
                onChange={(e) => setBidDraft(e.target.value)}
              />
              <button
                type="button"
                className="dop__btn dop__btn--primary dop__btn--sm"
                disabled={busy || expired}
                onClick={() => bid(offer)}
              >
                {busy ? 'Sending…' : 'Send'}
              </button>
              <button type="button" className="dop__btn dop__btn--ghost dop__btn--sm" onClick={() => setBidModeKey('')}>
                Cancel
              </button>
            </div>
          </section>
        ) : null}
      </div>

      <footer className="dop__foot">
        <div className="dop__actions" role="group" aria-label="Accept or decline">
          <button type="button" className="dop__btn dop__btn--decline" disabled={busy || expired} onClick={onDecline}>
            {busy ? 'Working…' : 'Decline'}
          </button>
          <button type="button" className="dop__btn dop__btn--accept" disabled={busy || expired} onClick={() => accept(offer)}>
            {busy ? 'Working…' : `Accept ${formatGBP(offer.amount)}`}
          </button>
        </div>
        {canBid && bidModeKey !== k ? (
          <button
            type="button"
            className="dop__link"
            disabled={busy || expired}
            onClick={() => {
              const floor = Math.max(offer.amount, myBids[k] || 0);
              setBidModeKey(k);
              setBidDraft(String((floor + 0.5).toFixed(2)));
            }}
          >
            {myBids[k] != null ? 'Raise your offer' : 'Counter-offer a higher price'}
          </button>
        ) : null}
        {canBid ? (
          <p className="dop__note">Accept sends your offer at the customer's price. The customer confirms the driver.</p>
        ) : null}
      </footer>
    </div>
  );
}
