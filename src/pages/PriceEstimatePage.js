import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { roundBidAmount } from '../lib/bookingBids';
import { formatGBP } from '../lib/currency';
import { deliveryPricingServiceTypeFromPackage } from '../lib/deliveryPricingServiceType';
import {
  computeIngoKilometreFare,
  resolveIngoVehicleFromDelivery,
} from '../lib/ingoKilometres';
import { estimateDriveMinutes, estimateRoadKm, haversineKm } from '../lib/routeEstimate';
import { forwardGeocodeAddress } from '../lib/reverseGeocode';
import { isStripePaymentsConfigured } from '../lib/stripeEdge';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import './bookRide.css';
import './pePayment.css';

const FALLBACK_PRICE_PER_KM = 0.5;
const FALLBACK_PRICE_PER_MINUTE = 0.05;
const FALLBACK_BASE_FARE = 1.5;
const FALLBACK_SERVICE_FEE = 0.2;

function BackArrow() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15.5 18.5L8.5 12l7-7.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCash() {
  return (
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
      <rect x="3" y="5" width="20" height="12" rx="1" fill="#F18631" transform="rotate(-8 16 12)" />
      <rect
        x="5"
        y="10"
        width="20"
        height="12"
        rx="1"
        fill="#0A58A6"
        transform="rotate(4 16 16)"
        opacity="0.95"
      />
      <rect
        x="6"
        y="14"
        width="20"
        height="12"
        rx="1"
        fill="white"
        transform="rotate(-2 16 20)"
        stroke="#e0e0e0"
        strokeWidth="0.5"
      />
    </svg>
  );
}

function IconBike() {
  return (
    <svg viewBox="0 0 32 32" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden>
      <circle cx="8" cy="22" r="3.2" fill="none" />
      <circle cx="22" cy="22" r="3.2" fill="none" />
      <path
        d="M8 9h3l2.2 4.3L20.5 7H14M9.2 10.5L8 22M19.5 12.3L22 22M12.2 13.3L16.3 19H10"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function IconEcoCash() {
  return (
    <svg viewBox="0 0 32 32" width="26" height="26" fill="none" aria-hidden>
      <rect x="5" y="4" width="22" height="24" rx="3" fill="#ecfdf5" stroke="#059669" strokeWidth="1.7" />
      <path d="M11 12h10M11 16h7M11 20h9" stroke="#059669" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="21" cy="21" r="3.2" fill="#10b981" />
    </svg>
  );
}

function IconCard() {
  return (
    <svg viewBox="0 0 32 32" width="26" height="26" fill="none" aria-hidden>
      <rect x="3" y="8" width="26" height="16" rx="2.5" fill="#eef2ff" stroke="#4338ca" strokeWidth="1.6" />
      <path d="M3 13h26" stroke="#4338ca" strokeWidth="1.5" />
      <rect x="7" y="17.5" width="8" height="2.2" rx="1" fill="#6366f1" />
      <rect x="18" y="17.5" width="7" height="2.2" rx="1" fill="#a5b4fc" />
    </svg>
  );
}

function formatPe(n) {
  return formatGBP(n);
}

function parseDistanceKm(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw);
  if (typeof raw === 'string' && raw.trim()) {
    const m = raw.match(/([\d.]+)/);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) return Math.max(0, n);
    }
  }
  return null;
}

/**
 * Used only when the route could not be measured at all (both geocoders failed).
 * The page says so out loud rather than pricing silently: an invented distance
 * once reached a real order as "Stratford, London E15 · 4.2 km" (2026-09-06).
 */
const ASSUMED_KM_WHEN_UNMEASURED = 4.2;

function resolveAddresses(state, fallbackKm) {
  // No placeholder addresses. A missing pickup or drop-off sends the customer
  // back to the form (see the redirect effect in the page); it never becomes an
  // order with a London street on it.
  const from = String((state && state.pickup) || '').trim();
  const stops = state?.stops;
  const last = Array.isArray(stops) && stops.length ? stops[stops.length - 1] : null;
  const to = String((last && (last.value || last.address)) || (state && state.to) || '').trim();
  const dRaw = state?.distanceKm;
  const parsed = parseDistanceKm(dRaw);
  const measuredKm = parsed != null ? parsed : fallbackKm != null && fallbackKm > 0 ? fallbackKm : null;
  const distanceKnown = measuredKm != null && measuredKm > 0;
  const km = distanceKnown ? measuredKm : ASSUMED_KM_WHEN_UNMEASURED;
  let distance;
  if (typeof dRaw === 'number' && Number.isFinite(dRaw) && dRaw > 0) {
    distance = `${(Math.round(dRaw * 10) / 10).toFixed(1)} km`;
  } else if (typeof dRaw === 'string' && dRaw.trim()) {
    distance = dRaw.trim();
  } else if (fallbackKm != null && fallbackKm > 0) {
    distance = `${(Math.round(fallbackKm * 10) / 10).toFixed(1)} km`;
  } else {
    distance = `about ${ASSUMED_KM_WHEN_UNMEASURED} km (not measured)`;
  }
  return { from, to, distance, km, distanceKnown };
}

export default function PriceEstimatePage() {
  const navigate = useNavigate();
  const { state: navState = {} } = useLocation();
  const stripeOk = useMemo(() => isStripePaymentsConfigured(), []);
  const [preferredPayment, setPreferredPayment] = useState(() => {
    const raw = String(navState?.preferredPayment || 'cod').toLowerCase();
    if (raw === 'stripe' || raw === 'card' || raw === 'ecocash' || raw === 'cod') {
      return raw === 'card' ? 'stripe' : raw;
    }
    return 'cod';
  });
  const [fallbackRouteKm, setFallbackRouteKm] = useState(null);
  const [customerOffer, setCustomerOffer] = useState(null);

  useEffect(() => {
    const dRaw = navState?.distanceKm;
    const hasExplicit =
      (typeof dRaw === 'number' && Number.isFinite(dRaw) && dRaw > 0) ||
      (typeof dRaw === 'string' && String(dRaw).trim() !== '');
    if (hasExplicit) {
      setFallbackRouteKm(null);
      return undefined;
    }

    let cancelled = false;
    const pickup = String(navState?.pickup || '').trim();
    const stops = navState?.stops;
    const stopTexts = Array.isArray(stops)
      ? stops.map((s) => String(s?.value ?? '').trim()).filter(Boolean)
      : [];
    const drop = stopTexts[stopTexts.length - 1] || '';
    if (!pickup || !drop) {
      setFallbackRouteKm(null);
      return undefined;
    }

    (async () => {
      try {
        const a = await forwardGeocodeAddress(pickup);
        const b = await forwardGeocodeAddress(drop);
        if (cancelled || !a || !b) return;
        const middle = stopTexts.length > 1 ? stopTexts.slice(0, -1) : [];
        let straight = 0;
        let prev = { lat: a.lat, lng: a.lng };
        for (const t of middle) {
          const wp = await forwardGeocodeAddress(t);
          if (!wp) return;
          const h = haversineKm(prev.lat, prev.lng, wp.lat, wp.lng);
          if (h == null) return;
          straight += h;
          prev = { lat: wp.lat, lng: wp.lng };
        }
        const hLast = haversineKm(prev.lat, prev.lng, b.lat, b.lng);
        if (hLast == null) return;
        straight += hLast;
        const road = estimateRoadKm(straight);
        if (!cancelled && road != null && road > 0) setFallbackRouteKm(road);
      } catch {
        if (!cancelled) setFallbackRouteKm(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navState]);

  const { from, to, distance, km, distanceKnown } = useMemo(
    () => resolveAddresses(navState, fallbackRouteKm),
    [navState, fallbackRouteKm],
  );

  // Reached without addresses (a reload, a stale link, a back-button dance):
  // go back to the form instead of quoting a placeholder route.
  const routeMissing = !from || !to;
  useEffect(() => {
    if (routeMissing) navigate('/request-delivery', { replace: true });
  }, [routeMissing, navigate]);
  const deliverySvc = useMemo(() => deliveryPricingServiceTypeFromPackage(navState), [navState]);

  const [ratesLoaded, setRatesLoaded] = useState(false);
  const [pricePerKm, setPricePerKm] = useState(FALLBACK_PRICE_PER_KM);
  const [pricePerMinute, setPricePerMinute] = useState(FALLBACK_PRICE_PER_MINUTE);
  const [baseFare, setBaseFare] = useState(FALLBACK_BASE_FARE);
  const [serviceFee, setServiceFee] = useState(FALLBACK_SERVICE_FEE);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!isSupabaseConfigured || !supabase) return;
        const pick = async (serviceType) => {
          const { data } = await supabase
            .from('service_pricing')
            .select('price_per_km, price_per_minute, base_fare, service_fee')
            .eq('service_type', serviceType)
            .maybeSingle();
          return data;
        };
        let data = await pick(deliverySvc);
        if (!data && deliverySvc !== 'delivery') data = await pick('delivery');
        if (cancelled) return;
        const pk = data?.price_per_km != null ? Number(data.price_per_km) : NaN;
        const pm = data?.price_per_minute != null ? Number(data.price_per_minute) : NaN;
        const bf = data?.base_fare != null ? Number(data.base_fare) : NaN;
        const sf = data?.service_fee != null ? Number(data.service_fee) : NaN;
        if (Number.isFinite(pk) && pk >= 0) setPricePerKm(pk);
        if (Number.isFinite(pm) && pm >= 0) setPricePerMinute(pm);
        if (Number.isFinite(bf) && bf >= 0) setBaseFare(bf);
        if (Number.isFinite(sf) && sf >= 0) setServiceFee(sf);
      } finally {
        if (!cancelled) setRatesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deliverySvc]);

  const durationMins = useMemo(() => estimateDriveMinutes(km), [km]);
  const billableMins = useMemo(() => {
    if (durationMins == null || !Number.isFinite(durationMins) || durationMins <= 0) return 0;
    return Math.max(1, Math.round(durationMins));
  }, [durationMins]);
  const distanceFee = useMemo(() => km * pricePerKm, [km, pricePerKm]);
  const timeFee = useMemo(() => billableMins * pricePerMinute, [billableMins, pricePerMinute]);
  // To the cent, once, here: this figure becomes `minimum_fare_amount` and the
  // floor every bid is checked against. Before 2026-09-06 the raw sum (e.g.
  // 4.31495) was stored, the screen showed "$4.31", and a driver's 4.31 was then
  // judged against 4.31495.
  const total = Math.round((baseFare + distanceFee + timeFee + serviceFee + Number.EPSILON) * 100) / 100;
  const minimumFare = total;
  const offerAmount = customerOffer != null && customerOffer >= minimumFare ? customerOffer : minimumFare;
  const totalLabel = ratesLoaded ? formatPe(offerAmount) : '…';
  const durationLabel =
    billableMins > 0 ? `${billableMins} min` : ratesLoaded ? '—' : '…';

  const ingoVehicle = useMemo(() => resolveIngoVehicleFromDelivery(navState), [navState]);
  const ingoFarePreview = useMemo(() => {
    if (!ingoVehicle || !Number.isFinite(km) || km < 0) return null;
    return computeIngoKilometreFare({ vehicle: ingoVehicle, distanceKm: km });
  }, [ingoVehicle, km]);

  const mergedOrderState = useMemo(
    () => ({
      ...navState,
      deliveryOption: 'delivery',
      deliveryTitle: 'Delivery',
      priceLabel: formatPe(offerAmount),
      priceNum: offerAmount,
      minimumFareAmount: minimumFare,
      customerOfferAmount: offerAmount,
      priceBreakdownBase: baseFare,
      priceBreakdownDistance: distanceFee,
      priceBreakdownTime: timeFee,
      priceBreakdownService: serviceFee,
      eta: durationLabel,
      scheduledFor: null,
      from,
      to,
      distance,
      distanceKm: km,
      ingoFareAmount: ingoFarePreview?.fare ?? null,
      ingoVehicle: ingoVehicle || null,
    }),
    [
      navState,
      baseFare,
      distanceFee,
      timeFee,
      serviceFee,
      from,
      to,
      distance,
      km,
      offerAmount,
      minimumFare,
      durationLabel,
      ingoFarePreview,
      ingoVehicle,
    ],
  );

  const bumpOffer = (delta) => {
    setCustomerOffer((prev) => {
      const base = prev != null && prev >= minimumFare ? prev : minimumFare;
      return roundBidAmount(Math.max(minimumFare, base + delta));
    });
  };

  useEffect(() => {
    if (preferredPayment === 'stripe' && !stripeOk) setPreferredPayment('cod');
  }, [preferredPayment, stripeOk]);

  const confirm = (e) => {
    e.preventDefault();
    navigate('/select-payment', {
      state: { ...mergedOrderState, preferredPayment },
    });
  };

  const confirmLabel =
    preferredPayment === 'ecocash'
      ? 'Continue with EcoCash'
      : preferredPayment === 'stripe'
        ? 'Continue with card'
        : 'Confirm & continue';

  return (
    <form className="br-page br-page--form" onSubmit={confirm}>
      <header className="br-nav br-nav--stacked">
        <Link
          to="/package-details"
          className="br-nav__back"
          state={navState}
          replace={false}
          aria-label="Back to package details"
        >
          <BackArrow />
        </Link>
        <div className="br-nav__center">
          <h1 className="br-nav__title">Price Estimate</h1>
          <p className="br-nav__step">Step 3 of 3</p>
        </div>
        <span className="br-nav__spacer" aria-hidden />
      </header>

      <div className="br-scroll br-scroll--form">
        <section className="br-pd-card br-pe-route" aria-label="Route summary">
          <h2 className="br-pd-heading">Route</h2>
          <div className="br-loc-list br-pe-loc" role="list">
            <div className="br-loc-row br-pe-loc__row" role="listitem">
              <span className="br-loc-row__dot br-loc-row__dot--pickup" aria-hidden />
              <div className="br-loc-row__main">
                <span className="br-loc-row__label">Pickup</span>
                <p className="br-pe-loc__addr">{from}</p>
              </div>
            </div>
            <div className="br-loc-row br-pe-loc__row" role="listitem">
              <span className="br-loc-row__dot br-loc-row__dot--drop" aria-hidden />
              <div className="br-loc-row__main">
                <span className="br-loc-row__label">Drop-off</span>
                <p className="br-pe-loc__addr">{to}</p>
              </div>
            </div>
          </div>
          <p className="br-pe-distance">
            <span className="br-pe-distance__lab">Distance</span>
            <span className="br-pe-distance__val">{distance}</span>
          </p>
          {!distanceKnown ? (
            <p className="br-pe-distance" role="note" style={{ color: 'var(--ingo-warning, #b45309)' }}>
              <span className="br-pe-distance__lab">Note</span>
              <span className="br-pe-distance__val">
                We could not measure this route, so the price assumes {ASSUMED_KM_WHEN_UNMEASURED} km. Check
                both addresses if that looks wrong.
              </span>
            </p>
          ) : null}
          <p className="br-pe-distance">
            <span className="br-pe-distance__lab">Est. duration</span>
            <span className="br-pe-distance__val">{durationLabel}</span>
          </p>
        </section>

        <section className="br-pd-card" aria-label="Delivery estimate">
          <h2 className="br-pd-heading">Delivery</h2>
          <div className="br-pe-service" role="group" aria-label={`Delivery total ${totalLabel}`}>
            <span className="br-pe-service__icon" aria-hidden>
              <IconBike />
            </span>
            <div className="br-pe-service__body">
              <p className="br-pe-service__title">Delivery</p>
              <p className="br-pe-service__sub">Estimated fare for your parcel</p>
            </div>
            <span className="br-pe-service__price">{totalLabel}</span>
          </div>
          {ingoFarePreview ? (
            <p className="br-pe-ingo-hint">
              With Ingo Kilometres: <strong>{formatGBP(ingoFarePreview.fare)}</strong> (fixed prepaid rate —
              choose on the next screen).
            </p>
          ) : null}
        </section>

        <section className="br-pd-card br-pe-bid" aria-label="Your offer">
          <h2 className="br-pd-heading">Your offer to drivers</h2>
          <p className="br-pe-bid__hint">
            Admin minimum: <strong>{ratesLoaded ? formatPe(minimumFare) : '…'}</strong> — you can bid higher to attract
            drivers faster.
          </p>
          <div className="br-pe-bid__controls">
            <button type="button" className="br-pe-bid__btn" disabled={!ratesLoaded || offerAmount <= minimumFare} onClick={() => bumpOffer(-0.5)}>
              −
            </button>
            <p className="br-pe-bid__amt" aria-live="polite">
              {totalLabel}
            </p>
            <button type="button" className="br-pe-bid__btn" disabled={!ratesLoaded} onClick={() => bumpOffer(0.5)}>
              +
            </button>
          </div>
        </section>

        <section className="br-pd-card br-pe-pay-card" aria-label="Payment method">
          <h2 className="br-pd-heading">Payment</h2>
          <div className="pay-list br-pe-pay-list" role="radiogroup" aria-label="Payment method">
            <label
              className={preferredPayment === 'cod' ? 'pay-row pay-row--on' : 'pay-row'}
              htmlFor="pe-pay-cod"
            >
              <span className="pay-row__icon" aria-hidden>
                <IconCash />
              </span>
              <span className="pay-row__body">
                <span className="pay-row__label">Cash on delivery</span>
                <span className="pay-row__sub">Pay the rider when your parcel arrives</span>
              </span>
              <input
                type="radio"
                id="pe-pay-cod"
                name="pe-payment"
                className="pay-row__radio"
                checked={preferredPayment === 'cod'}
                onChange={() => setPreferredPayment('cod')}
              />
            </label>

            <label
              className={preferredPayment === 'ecocash' ? 'pay-row pay-row--on' : 'pay-row'}
              htmlFor="pe-pay-eco"
            >
              <span className="pay-row__icon" aria-hidden>
                <IconEcoCash />
              </span>
              <span className="pay-row__body">
                <span className="pay-row__label">EcoCash</span>
                <span className="pay-row__sub">Approve on your phone</span>
              </span>
              <input
                type="radio"
                id="pe-pay-eco"
                name="pe-payment"
                className="pay-row__radio"
                checked={preferredPayment === 'ecocash'}
                onChange={() => setPreferredPayment('ecocash')}
              />
            </label>

            {stripeOk ? (
              <label
                className={preferredPayment === 'stripe' ? 'pay-row pay-row--on' : 'pay-row'}
                htmlFor="pe-pay-card"
              >
                <span className="pay-row__icon" aria-hidden>
                  <IconCard />
                </span>
                <span className="pay-row__body">
                  <span className="pay-row__label">Card</span>
                  <span className="pay-row__sub">Secure checkout on Stripe</span>
                </span>
                <input
                  type="radio"
                  id="pe-pay-card"
                  name="pe-payment"
                  className="pay-row__radio"
                  checked={preferredPayment === 'stripe'}
                  onChange={() => setPreferredPayment('stripe')}
                />
              </label>
            ) : null}
          </div>
          <p className="br-pe-ingo-hint" style={{ marginTop: '0.75rem' }}>
            You’ll confirm payment details on the next screen
            {preferredPayment === 'stripe' ? ' (card redirect)' : preferredPayment === 'ecocash' ? ' (EcoCash number)' : ''}.
          </p>
        </section>

        <section className="br-pd-card br-pe-breakdown" aria-label="Price breakdown">
          <h2 className="br-pd-heading">Price breakdown</h2>
          <div className="br-pe-break__row">
            <span>Base fare</span>
            <span>{ratesLoaded ? formatPe(baseFare) : '…'}</span>
          </div>
          <div className="br-pe-break__row">
            <span>Distance fee</span>
            <span>{ratesLoaded ? formatPe(distanceFee) : '…'}</span>
          </div>
          <div className="br-pe-break__row">
            <span>
              Time fee{ratesLoaded && billableMins > 0 ? ` (${billableMins} min × ${formatPe(pricePerMinute)}/min)` : ''}
            </span>
            <span>{ratesLoaded ? formatPe(timeFee) : '…'}</span>
          </div>
          <div className="br-pe-break__row">
            <span>Service fee</span>
            <span>{ratesLoaded ? formatPe(serviceFee) : '…'}</span>
          </div>
          <hr className="br-pe-break__hr" />
          <div className="br-pe-break__row br-pe-break__row--total">
            <span>Your offer</span>
            <span>{totalLabel}</span>
          </div>
          <p className="br-pe-bid__floor">Minimum (admin rate): {ratesLoaded ? formatPe(minimumFare) : '…'}</p>
        </section>
      </div>

      <div className="br-footer">
        <button type="submit" className="br-confirm" disabled={!ratesLoaded}>
          {confirmLabel}
        </button>
      </div>
    </form>
  );
}
