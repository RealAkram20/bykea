import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import GoogleMapEmbed from '../components/GoogleMapEmbed';
import LiveUserGoogleMap from '../components/LiveUserGoogleMap';
import { useDriverOffers } from '../components/driver/DriverOffersProvider';
import { useThrottledMapEmbedSrc } from '../hooks/useThrottledMapEmbedSrc';
import {
  formatOfferTime,
  isCashCustomerPayment,
  isOpenBookingRowFresh,
  isWalletCustomerPayment,
  openOfferSecondsLeft,
  OPEN_OFFER_MAX_AGE_MS,
  OFFER_RING_CYCLE_MS,
} from '../lib/driverIncomingBookings';
import { useOfferActions } from '../components/driver/useOfferActions';
import { BID_TABLES, kindLabel, OfferPinDrop, OfferPinPickup } from '../components/driver/offerPresentation';
import { readLastDeviceFix } from '../hooks/useLiveLocation';
import { formatDistanceKm, sortOffersByDistance, useOfferDistances } from '../lib/offerProximity';
import { formatGBP } from '../lib/currency';
import { DEFAULT_MAP_FALLBACK, publicViewMapUrlDriver, trustedMapCenter } from '../lib/googleMapsConfig';
import { unlockDriverOfferAudio } from '../lib/driverOfferRing';
import CarIcon from '../components/icons/CarIcon';
import { LOGIN_HERO_ART } from '../lib/ingoLogo';
import DriverPermissionPrompts from '../components/driver/DriverPermissionPrompts';
import OfferActionBar from '../components/driver/OfferActionBar';
import './driverPortal.css';
import './driverHomePremium.css';

/** Readable place line: title-case words; keep leading numeric tokens as-is. */
function titleCasePlaceLine(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => {
      if (!w) return w;
      if (/^\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Visual tone for left stripe + badge (matches common DB status strings). */
function recentJobTone(st) {
  const s = String(st || '').toLowerCase();
  if (s.includes('cancel')) return 'cancel';
  if (s.includes('complete') || s.includes('delivered')) return 'done';
  if (s.includes('assign') || s.includes('active') || s.includes('en route') || s.includes('pickup')) return 'prog';
  if (s.includes('confirm') || s.includes('pending') || s.includes('request') || s.includes('placed')) return 'conf';
  return 'neu';
}

function IconPower() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v8M8.5 8.5a6 6 0 1 0 7 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconOnline() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
      <path d="M8 12.5l3 2.5 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconRecentEmpty() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden style={{ margin: '0 auto 0.65rem', display: 'block', color: '#9ca3af' }}>
      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 10h8M8 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function JobKindIcon({ kind }) {
  const common = { width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'aria-hidden': true };
  if (kind === 'parcel' || kind === 'shop') {
    return (
      <svg viewBox="0 0 24 24" {...common} strokeWidth="1.7" strokeLinejoin="round">
        <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
        <path d="m4 7 8 4 8-4M12 11v10" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'tuktuk') {
    return (
      <svg viewBox="0 0 24 24" {...common} strokeWidth="1.5">
        <rect x="3" y="8" width="12" height="6" rx="0.5" />
        <path d="M15 10h3l1 1h1.2a.8.8 0 0 1 .7.4V13" strokeLinecap="round" />
        <circle cx="6.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="11.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="19" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return <CarIcon size={20} />;
}

export default function DriverHomePage() {
  const navigate = useNavigate();
  const {
    online,
    setOnline,
    live,
    offers,
    recent,
    loadErr,
    ringingOfferKeys,
    driverRegisteredAt,
  } = useDriverOffers();

  const [jsMapFailed, setJsMapFailed] = useState(false);
  const driverMapSrc = useMemo(() => {
    const c = trustedMapCenter(live.mapCenter);
    // Quantize ~11m so tiny GPS noise does not rebuild the embed URL.
    const lat = Number(Number(c.lat).toFixed(4));
    const lng = Number(Number(c.lng).toFixed(4));
    return publicViewMapUrlDriver(lat, lng, 14);
  }, [live.mapCenter]);
  const stableDriverMapSrc = useThrottledMapEmbedSrc(driverMapSrc, { throttleMs: 20000 });
  const mapCenter = useMemo(() => trustedMapCenter(live.mapCenter), [live.mapCenter]);
  const jsMapAvailable = !jsMapFailed;

  const {
    accept: onAccept,
    reject: onReject,
    bid: onBid,
    actionMsg,
    setActionMsg,
    busyKey,
    bidModeKey,
    setBidModeKey,
    bidDraft,
    setBidDraft,
    myBids,
  } = useOfferActions();
  /** Re-render every second for countdown / expiry */
  const [, setSecTick] = useState(0);

  useEffect(() => {
    if (!online) return undefined;
    const id = window.setInterval(() => setSecTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [online]);

  const visibleOffers = !online
    ? []
    : offers.filter(
        (o) =>
          o.id &&
          isOpenBookingRowFresh(o.raw || { created_at: o.created_at, assigned_driver_id: null }, driverRegisteredAt),
      );

  // Nearest pickup first. Unknown distances keep their order after the known ones.
  const driverPos = live.hasFix ? { lat: live.lat, lng: live.lng } : readLastDeviceFix();
  const { distances: offerDistances } = useOfferDistances(visibleOffers, driverPos);
  const sortedOffers = useMemo(
    () => sortOffersByDistance(visibleOffers, offerDistances),
    // offerDistances is rebuilt each render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleOffers, [...offerDistances.values()].join(',')],
  );

  const recentTotal = useMemo(() => recent.reduce((s, r) => s + (Number(r.amt) || 0), 0), [recent]);

  const offerKey = (o) => `${o.table}:${o.id}`;

  const handleOnlineSwitch = useCallback(() => {
    setActionMsg('');
    unlockDriverOfferAudio();
    setOnline((was) => !was);
  }, [setOnline, setActionMsg]);

  return (
    <div className="dh dh--premium" role="main" aria-label="Driver home">
      <div className="dh__srOnly" aria-live="assertive" aria-atomic="true">
        {ringingOfferKeys.size > 0 ? 'New delivery request — respond now.' : ''}
      </div>
      <header className="dh__top">
        <h1 className="dh__brand">
          <img src={LOGIN_HERO_ART} alt="" className="dh__brandRider" decoding="async" />
          <span className="dh__brandText">Driver</span>
        </h1>
        <div className="dh__togR">
          <button type="button" className="dh__chatBtn" onClick={() => navigate('/driver/chat')}>
            Chat
          </button>
          <span className={online ? 'dh__togL dh__togL--g' : 'dh__togL dh__togL--gry'}>{online ? 'Online' : 'Offline'}</span>
          <button
            type="button"
            className={online ? 'dh__sw dh__sw--on' : 'dh__sw'}
            onClick={handleOnlineSwitch}
            role="switch"
            aria-checked={online}
            aria-label={online ? 'Go offline' : 'Go online'}
          >
            <span className="dh__k" aria-hidden />
          </button>
        </div>
      </header>

      <div
        className={`dh__mapWrap dh__mapWrap--gmap${jsMapAvailable || stableDriverMapSrc ? ' dh__mapWrap--live' : ''}`}
        role="region"
        aria-label="Map near you"
      >
        {jsMapAvailable ? (
          <div className="dh__mapJs">
            <LiveUserGoogleMap
              mapCenter={mapCenter}
              fallbackCenter={DEFAULT_MAP_FALLBACK}
              hasFix={live.hasFix}
              accurate={live.hasFix}
              accuracyM={live.accuracy}
              onLoadError={() => setJsMapFailed(true)}
              zoomWithFix={15}
              zoomFallback={13}
              showUserLocationMarker
            />
          </div>
        ) : (
          <GoogleMapEmbed
            src={
              stableDriverMapSrc ||
              publicViewMapUrlDriver(DEFAULT_MAP_FALLBACK.lat, DEFAULT_MAP_FALLBACK.lng, 13)
            }
            title="Map near you"
            loading="eager"
          />
        )}
      </div>

      <div className="dh__sc">
        <div className={`dh__status dh__card ${online ? 'dh__status--on' : 'dh__status--off'}`}>
          <span className="dh__statusIconWrap" aria-hidden>
            {online ? <IconOnline /> : <IconPower />}
          </span>
          <div className="dh__statusText">
            <h2 className="dh__statusTitle">{online ? 'You are Online' : 'You are Offline'}</h2>
            <p className="dh__statusSub">
              {online
                ? `Each request keeps showing for up to ${OPEN_OFFER_MAX_AGE_MS / 60000} minutes until a driver accepts — it re-rings every ${OFFER_RING_CYCLE_MS / 1000} seconds. Once accepted it disappears.`
                : 'Toggle online to receive delivery, taxi, and Tuk-Tuk requests'}
            </p>
          </div>
        </div>

        <div className="dh__st" aria-label="Session stats">
          <div
            className="dh__stB dh__stB--offers"
            role="img"
            aria-label={`${online ? visibleOffers.length : 0} open offers`}
          >
            <p className="dh__stN">{online ? visibleOffers.length : 0}</p>
            <p className="dh__stT">Open Offers</p>
            <span className="dh__stLive">LIVE</span>
          </div>
          <div className="dh__stB dh__stB--earn" aria-label={`Recent earnings ${formatGBP(recentTotal)}`}>
            <p className="dh__stG">{formatGBP(recentTotal)}</p>
            <p className="dh__stT">Recent Jobs</p>
            <p className="dh__stSub">{recent.length} TOTAL</p>
          </div>
          <div className="dh__stB dh__stB--sync" role="status" aria-label="Offers refresh about every 2 seconds">
            <span className="dh__stIcoWrap" aria-hidden>
              <svg className="dh__stIco" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
                <path
                  d="M4.5 9.5a7.5 7.5 0 0 1 14.5-2.2M19.5 14.5a7.5 7.5 0 0 1-14.5 2.2"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M19 4v4.5h-4.5M5 20v-4.5h4.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <p className="dh__stT">Refresh</p>
            <p className="dh__stSub">~4s</p>
          </div>
        </div>
{loadErr ? (
          <p className="dh__alert dh__alert--error" role="alert">
            {loadErr}
          </p>
        ) : null}
        {actionMsg ? (
          <p className="dh__alert dh__alert--error" role="status">
            {actionMsg}
          </p>
        ) : null}

        {online &&
          sortedOffers.map((offer) => {
            const k = offerKey(offer);
            const fromYouKm = offerDistances.get(k);
            const busy = busyKey === k;
            const secLeft = openOfferSecondsLeft(offer.created_at);
            const pct = (secLeft / (OFFER_RING_CYCLE_MS / 1000)) * 100;
            const urgent = secLeft <= 10;
            const isRinging = ringingOfferKeys.has(k);
            const payMethod = String(offer.raw?.payment_method || '').toLowerCase();
            const isWalletPay =
              isWalletCustomerPayment(payMethod) || isWalletCustomerPayment(offer.customerPayment);
            const isCashPay =
              isCashCustomerPayment(payMethod) || isCashCustomerPayment(offer.customerPayment);
            const payLabel = isWalletPay
              ? 'Wallet Payment'
              : isCashPay
                ? 'Cash Payment'
                : offer.customerPayment && offer.customerPayment !== '—'
                  ? offer.customerPayment
                  : null;
            return (
              <div
                key={k}
                className={`dh-offerCard${isRinging ? ' dh-offerCard--ringing' : ''}`}
                role="region"
                aria-label={`New ${kindLabel(offer.kind)} request`}
              >
                <header className="dh-offerCard__head">
                  <div className="dh-offerCard__headMain">
                    <p className="dh-offerCard__ref">{offer.ref}</p>
                    <p className="dh-offerCard__when">{formatOfferTime(offer.created_at)}</p>
                  </div>
                  <span className={`dh-offerCard__badge dh-offerCard__badge--${offer.kind}`}>{kindLabel(offer.kind)}</span>
                </header>

                <div className="dh-offerCard__route">
                  <div className="dh-offerCard__stop dh-offerCard__stop--pick">
                    <span className="dh-offerCard__pin" aria-hidden>
                      <OfferPinPickup />
                    </span>
                    <div className="dh-offerCard__stopBody">
                      <span className="dh-offerCard__stopLbl">Pickup</span>
                      <p className="dh-offerCard__addr">{offer.from}</p>
                    </div>
                  </div>
                  <div className="dh-offerCard__rail" aria-hidden />
                  <div className="dh-offerCard__stop dh-offerCard__stop--drop">
                    <span className="dh-offerCard__pin" aria-hidden>
                      <OfferPinDrop />
                    </span>
                    <div className="dh-offerCard__stopBody">
                      <span className="dh-offerCard__stopLbl">Drop-off</span>
                      <p className="dh-offerCard__addr">{offer.to}</p>
                    </div>
                  </div>
                </div>

                <p className="dh-offerCard__dist">
                  <span className="dh-offerCard__distIcon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                      <path
                        d="M4 12h3l2 7 4-14 2 7h5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span>
                    {offer.dist}
                    {offer.dist && offer.eta ? ' · ' : null}
                    {offer.eta}
                  </span>
                </p>

                {fromYouKm != null ? (
                  <p className="dh-offerCard__dist dh-offerCard__dist--fromYou" role="status">
                    Pickup about {formatDistanceKm(fromYouKm)} from you
                  </p>
                ) : null}

                <p className="dh-offerCard__pkg" role="status">
                  {offer.pkg}
                </p>

                {payLabel ? (
                  <div
                    className={`dh-offerCard__pay${isWalletPay ? ' dh-offerCard__pay--wallet' : ''}${
                      isCashPay ? ' dh-offerCard__pay--cash' : ''
                    }`}
                    role="status"
                  >
                    <div className="dh-offerCard__payTop">
                      <span className="dh-offerCard__payLbl">Payment</span>
                      <span className="dh-offerCard__payVal">{payLabel}</span>
                    </div>
                    {isWalletPay ? (
                      <p className="dh-offerCard__payNote">
                        Customer has already paid through the Ingo Wallet. Do not collect cash.
                      </p>
                    ) : null}
                    {isCashPay ? (
                      <p className="dh-offerCard__payNote dh-offerCard__payNote--cash">
                        Collect cash from the customer at drop-off.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="dh-offerCard__priceBand">
                  <span className="dh-offerCard__priceLbl">Customer offer</span>
                  <p className="dh-offerCard__amt">{formatGBP(offer.amount)}</p>
                  {offer.minimumAmount != null && offer.minimumAmount < offer.amount ? (
                    <p className="dh-offerCard__minBid">Min. {formatGBP(offer.minimumAmount)}</p>
                  ) : offer.minimumAmount != null ? (
                    <p className="dh-offerCard__minBid">Admin minimum: {formatGBP(offer.minimumAmount)}</p>
                  ) : null}
                </div>

                {myBids[k] != null ? (
                  <div className="dh-offerCard__myBid" role="status">
                    <span className="dh-offerCard__myBidLbl">Your offer</span>
                    <span className="dh-offerCard__myBidAmt">{formatGBP(myBids[k])}</span>
                    <span className="dh-offerCard__myBidNote">Waiting for customer to choose you</span>
                  </div>
                ) : null}

                <div className={`dh-offerCard__timer${urgent ? ' dh-offerCard__timer--urgent' : ''}`}>
                  <span className="dh-offerCard__timerTxt">Respond in {secLeft}s</span>
                  <div className="dh-offerCard__pb" aria-hidden>
                    <div className="dh-offerCard__pbFill" style={{ width: `${pct}%` }} />
                  </div>
                </div>

                <OfferActionBar
                  offer={offer}
                  canBid={BID_TABLES.includes(offer.table)}
                  busy={busy}
                  disabled={secLeft <= 0}
                  myBid={myBids[k] ?? null}
                  bidOpen={bidModeKey === k}
                  bidDraft={bidDraft}
                  onBidDraftChange={setBidDraft}
                  onOpenBid={() => {
                    const floor = Math.max(offer.amount, myBids[k] || 0);
                    setBidModeKey(k);
                    setBidDraft(String((floor + 0.5).toFixed(2)));
                  }}
                  onCloseBid={() => setBidModeKey('')}
                  onSendBid={() => onBid(offer)}
                  onAccept={() => onAccept(offer)}
                  onDecline={() => onReject(offer)}
                  inputId={`bid-${k}`}
                />
              </div>
            );
          })}

        <section className="dh__recentSec" aria-label="Recent work">
          <h2 className="dh__secH">Your Recent Jobs</h2>
          {recent.length === 0 ? (
            <div className="dh__recentEmpty">
              <IconRecentEmpty />
              <p className="dh__recentEmptyTx">
                No accepted jobs yet. When you accept a booking, it appears here.
              </p>
            </div>
          ) : (
            <div className="dh__recentList">
              {recent.map((r) => {
                const tone = recentJobTone(r.st);
                return (
                  <div key={`${r.kind}-${r.id}`} className={`dh__recentCard dh__recentCard--${tone}`}>
                    <div className="dh__recentCard__ic">
                      <JobKindIcon kind={r.kind} />
                    </div>
                    <div className="dh__recentCard__body">
                      <span className="dh__recentCard__ref">{r.ref}</span>
                      <p className="dh__recentCard__addr">{titleCasePlaceLine(r.to)}</p>
                      <span className={`dh__recentCard__bd dh__recentCard__bd--${tone}`}>
                        {kindLabel(r.kind)} · {r.st}
                      </span>
                    </div>
                    <div className="dh__recentCard__meta">
                      <p className="dh__recentCard__amt">{formatGBP(r.amt)}</p>
                      <p className="dh__recentCard__when">{formatOfferTime(r.t)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {!loadErr && online && visibleOffers.length === 0 && offers.length > 0 && (
          <p className="dh__recentFoot">
            No fresh offers right now. New bookings keep showing for up to {OPEN_OFFER_MAX_AGE_MS / 60000} minutes
            after customers place them, until a driver accepts — respond quickly.
          </p>
        )}
        {!loadErr && online && offers.length === 0 && (
          <p className="dh__recentFoot">
            No open customer bookings right now. Delivery orders (placed), taxi rides, and Tuk-Tuk requests show here
            when customers book.
          </p>
        )}
        {!online && <p className="dh__pEm">Go online to see new requests in this area.</p>}
      </div>

      <DriverPermissionPrompts live={live} online={online} />
    </div>
  );
}
