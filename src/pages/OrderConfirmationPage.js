import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import ShopOrderTrackingSteps from '../components/ShopOrderTrackingSteps';
import { mapDriverRegistrationRow } from '../lib/customerOrderFeed';
import { formatGBP } from '../lib/currency';
import DeliveryPin from '../components/DeliveryPin';
import { DELIVERY_PIN_CUSTOMER_HINT, storedDeliveryPin } from '../lib/deliveryConfirmationCode';
import { buildLiveTrackingState } from '../lib/liveTrackingState';
import { readShopOrderConfirmationState } from '../lib/shopOrderConfirmationSession';
import { takePaynowReturnPath, peekPaynowReturnPath } from '../lib/paynowReturnSession';
import { shopOrderProgressMessage, shopOrderStatusLabel } from '../lib/shopOrderStatus';
import {
  isDriverSearchTimedOut,
  noDriverAvailableDetail,
  noDriverAvailableHeadline,
} from '../lib/driverSearchWait';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import './orderConfirmationPremium.css';

const DRIVER = {
  name: 'Zain Ahmed',
  vehicle: 'Honda 125',
  plate: 'AB19 CDE',
};

function formatPlacedAt(iso) {
  try {
    if (!iso) return new Date().toLocaleString();
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date().toLocaleString();
  }
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path
        d="M6.5 4.5h3.2l1.2 3.5 2.2-1.2a11 11 0 0 0 4.8 4.8l-1.2-2.2 3.5-1.2v3.2a2 2 0 0 1-2 1.8A13.5 13.5 0 0 1 4.7 6.5a2 2 0 0 1 1.8-2Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path
        d="M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 4V7a2 2 0 0 1 2-2Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatOrderId(id) {
  if (!id) return '#ING-00234';
  const s = String(id).replace(/^#/, '');
  return s.startsWith('ING') ? `#${s}` : `#ING-${s}`;
}

export default function OrderConfirmationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const order = useMemo(() => readShopOrderConfirmationState(location.state), [location.state]);

  useLayoutEffect(() => {
    const ret = peekPaynowReturnPath();
    if (!ret || (ret !== '/driver/wallet' && ret !== '/wallet')) return;
    const hasShopOrDelivery =
      order.source === 'shop' ||
      order.source === 'delivery' ||
      (order.source === 'ride' && order.taxiBookingId);
    if (hasShopOrDelivery) return;
    takePaynowReturnPath();
    if (ret === '/wallet') {
      navigate('/wallet', { replace: true, state: { paynowWalletReturn: true } });
      return;
    }
    navigate('/driver/wallet', { replace: true, state: { paynowDepositReturn: true } });
  }, [order, navigate]);

  useLayoutEffect(() => {
    if (order.source === 'shop') return;
    const ltState = buildLiveTrackingState(order);
    if (!ltState) return;
    navigate('/live-tracking', { replace: true, state: ltState });
  }, [order, navigate]);

  const orderId = formatOrderId(order.orderId != null ? String(order.orderId) : '');
  const placedAt = useMemo(
    () => order.placedAt || new Date().toISOString(),
    [order.placedAt],
  );
  // Never a placeholder street: a missing address is shown as missing.
  const from = order.from || '—';
  const to = order.to || '—';
  const deliveryType = order.deliveryTitle || 'Delivery';
  const eta = order.eta || '45 - 60 mins';
  const price =
    order.priceLabel ||
    (typeof order.priceNum === 'number' ? formatGBP(order.priceNum) : formatGBP(2.5));

  const customer = order.customer;
  const isShopOrder = order.source === 'shop';
  const isTrackablePaynowReturn =
    order.source !== 'shop' &&
    (order.supabaseOrderId != null || order.taxiBookingId != null) &&
    String(order.supabaseOrderId || order.taxiBookingId || '').trim() !== '';

  const deliveryUuid = useMemo(() => {
    if (isShopOrder) return null;
    const id = order.supabaseOrderId;
    if (id == null || String(id).trim() === '') return null;
    return String(id).trim();
  }, [isShopOrder, order.supabaseOrderId]);

  const [liveDriverRow, setLiveDriverRow] = useState(null);
  const [liveShopOrder, setLiveShopOrder] = useState(null);
  const [waitTick, setWaitTick] = useState(0);

  const shopOrderDbId = useMemo(() => {
    if (!isShopOrder) return null;
    const id = order.shopOrderDbId;
    if (id == null || String(id).trim() === '') return null;
    return String(id).trim();
  }, [isShopOrder, order.shopOrderDbId]);

  useEffect(() => {
    if (!shopOrderDbId || !isSupabaseConfigured || !supabase) {
      setLiveShopOrder(null);
      return undefined;
    }
    let cancelled = false;
    const fetchShopOrder = async () => {
      try {
        const { data: row, error } = await supabase
          .from('shop_customer_orders')
          .select('id, status, assigned_driver_id, placed_at, delivery_confirmation_code')
          .eq('id', shopOrderDbId)
          .maybeSingle();
        if (cancelled || error) return;
        if (!row) {
          setLiveShopOrder(null);
          return;
        }
        setLiveShopOrder(row);
        const aid = row.assigned_driver_id;
        if (!aid) {
          setLiveDriverRow(null);
          return;
        }
        const { data: d, error: de } = await supabase
          .from('driver_registrations')
          .select('id, full_name, phone, phone_country_code, vehicle_type, vehicle_make, vehicle_model, vehicle_plate, vehicle_color')
          .eq('id', aid)
          .maybeSingle();
        if (cancelled) return;
        if (!de && d) setLiveDriverRow(d);
        else setLiveDriverRow(null);
      } catch {
        if (!cancelled) {
          setLiveShopOrder(null);
          setLiveDriverRow(null);
        }
      }
    };
    fetchShopOrder();
    const timer = window.setInterval(fetchShopOrder, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [shopOrderDbId]);

  useEffect(() => {
    if (isShopOrder) return undefined;
    if (!deliveryUuid || !isSupabaseConfigured || !supabase) {
      setLiveDriverRow(null);
      return undefined;
    }
    let cancelled = false;
    const fetchDriver = async () => {
      try {
        const { data: row, error } = await supabase
          .from('customer_delivery_orders')
          .select('assigned_driver_id')
          .eq('id', deliveryUuid)
          .maybeSingle();
        if (cancelled || error) return;
        const aid = row?.assigned_driver_id;
        if (!aid) {
          if (!cancelled) setLiveDriverRow(null);
          return;
        }
        const { data: d, error: de } = await supabase
          .from('driver_registrations')
          .select('id, full_name, phone, phone_country_code, vehicle_type, vehicle_make, vehicle_model, vehicle_plate, vehicle_color')
          .eq('id', aid)
          .maybeSingle();
        if (cancelled) return;
        if (!de && d) setLiveDriverRow(d);
        else setLiveDriverRow(null);
      } catch {
        if (!cancelled) setLiveDriverRow(null);
      }
    };
    fetchDriver();
    const timer = window.setInterval(fetchDriver, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [deliveryUuid, isShopOrder]);

  const shopStatus = liveShopOrder?.status || 'placed';
  const shopHasDriver = Boolean(liveShopOrder?.assigned_driver_id);
  const shopDeliveryCode = useMemo(() => {
    return (
      storedDeliveryPin(liveShopOrder?.delivery_confirmation_code) ||
      storedDeliveryPin(order.deliveryConfirmationCode) ||
      ''
    );
  }, [liveShopOrder?.delivery_confirmation_code, order.deliveryConfirmationCode]);
  const shopDelivered = String(shopStatus || '')
    .toLowerCase()
    .includes('deliver');
  const shopAwaitingDriverAssignment =
    isShopOrder &&
    !shopHasDriver &&
    String(shopStatus || '')
      .toLowerCase()
      .trim() === 'ready for delivery';
  const shopDriverSearchTimedOut = useMemo(
    () =>
      isDriverSearchTimedOut({
        liveRow: liveShopOrder,
        order: { placedAt: liveShopOrder?.placed_at || placedAt },
        hasDriver: shopHasDriver,
      }),
    [liveShopOrder, placedAt, shopHasDriver, waitTick],
  );

  useEffect(() => {
    if (!shopAwaitingDriverAssignment) return undefined;
    const id = window.setInterval(() => setWaitTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [shopAwaitingDriverAssignment]);

  const shopProgressMsg = useMemo(() => {
    if (shopDriverSearchTimedOut && shopAwaitingDriverAssignment) {
      return `${noDriverAvailableHeadline()}. ${noDriverAvailableDetail({ isShop: true })}`;
    }
    return shopOrderProgressMessage(shopStatus, { hasDriver: shopHasDriver });
  }, [shopStatus, shopHasDriver, shopDriverSearchTimedOut, shopAwaitingDriverAssignment]);
  const shopStatusLabel = shopOrderStatusLabel(shopStatus);
  const shopOrderNavKey = shopOrderDbId ? `shop:${shopOrderDbId}` : null;

  const assignedDriverUi = useMemo(
    () => (liveDriverRow ? mapDriverRegistrationRow(liveDriverRow) : null),
    [liveDriverRow],
  );

  const shopAwaitingDriver =
    isShopOrder &&
    !assignedDriverUi &&
    ['ready for delivery', 'picked up', 'in transit'].includes(
      String(shopStatus || '')
        .toLowerCase()
        .trim(),
    );
  const showDriverSection = !isShopOrder || assignedDriverUi || shopAwaitingDriver;

  if (isTrackablePaynowReturn) {
    return (
      <div className="ty-page ty-page--loading" role="status" aria-live="polite">
        <p className="ty-loading-text">Opening live tracking…</p>
      </div>
    );
  }

  const driverPhoneOk =
    assignedDriverUi?.phone && assignedDriverUi.phone !== '—'
      ? String(assignedDriverUi.phone).replace(/[^\d+]/g, '')
      : '';

  return (
    <div className="ty-page" role="main" aria-label="Order confirmation">
      <div className="ty-hero">
        <div className="ty-check" aria-hidden>
          <div className="ty-check__ring" />
          <div className="ty-check__circle">
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
              <path className="ty-check__path" d="M7 16l5 5 12-12" />
            </svg>
          </div>
        </div>
        <h1 className="ty-title">Thank you!</h1>
        <p className="ty-sub">
          {isShopOrder ? 'Your shop order is confirmed' : 'Your order is confirmed'}
        </p>
      </div>

      <div className="ty-scroll">
        <section className="ty-card" aria-label="Order details">
          <div className="ty-card__head">
            <p className="ty-card__id">Order {orderId}</p>
            <time className="ty-card__date" dateTime={placedAt}>
              {formatPlacedAt(placedAt)}
            </time>
          </div>

          <div className="ty-locs">
            <span className="ty-locs__line" aria-hidden />
            <p className="ty-loc">
              <span className="ty-loc__dot ty-loc__dot--pickup" aria-hidden />
              <span>
                <span className="ty-loc__label">From</span>
                {from}
              </span>
            </p>
            <p className="ty-loc">
              <span className="ty-loc__dot ty-loc__dot--drop" aria-hidden />
              <span>
                <span className="ty-loc__label">To</span>
                {to}
              </span>
            </p>
          </div>

          <span className="ty-badge">{deliveryType}</span>

          <div className="ty-meta">
            <span>Estimated arrival</span>
            <span className="ty-meta__val">{eta}</span>
          </div>

          <p className="ty-total">
            Total paid: <span>{price}</span>
          </p>
        </section>

        {isShopOrder && shopOrderDbId ? (
          <section className="ty-card" aria-label="Order tracking">
            <div className="ty-track-head">
              <h2 className="ty-card__title">Order tracking</h2>
              <span className="ty-track-badge">{shopStatusLabel}</span>
            </div>
            <p className="ty-track-msg" role="status">
              {shopProgressMsg}
            </p>
            <ShopOrderTrackingSteps status={shopStatus} variant="ty" />
            {shopOrderNavKey ? (
              <Link to={`/order/${encodeURIComponent(shopOrderNavKey)}`} className="ty-track-link">
                View full order details
              </Link>
            ) : null}
          </section>
        ) : null}

        {shopDeliveryCode && !shopDelivered ? (
          <section className="ty-card ty-delivery-code" aria-label="Delivery PIN">
            <h2 className="ty-card__title">Your delivery PIN</h2>
            <DeliveryPin value={shopDeliveryCode} readOnly ariaLabel="Your delivery PIN" />
            <p className="ty-delivery-code__hint">{DELIVERY_PIN_CUSTOMER_HINT}</p>
          </section>
        ) : null}

        {customer ? (
          <section className="ty-card" aria-label={isShopOrder ? 'Your contact details' : 'Delivery contact'}>
            <h2 className="ty-card__title">{isShopOrder ? 'Your details' : 'Delivering to'}</h2>
            <p className="ty-cust-name">{customer.fullName}</p>
            <p className="ty-cust-line">{customer.phone}</p>
            {customer.email ? <p className="ty-cust-line">{customer.email}</p> : null}
            <p className="ty-cust-line">{customer.address}</p>
            {customer.notes ? (
              <p className="ty-cust-notes">
                <strong>Notes:</strong> {customer.notes}
              </p>
            ) : null}
          </section>
        ) : null}

        {showDriverSection ? (
          <section className="ty-card" aria-label="Driver assignment">
            <h2 className="ty-card__title">{isShopOrder ? 'Delivery driver' : 'Your driver'}</h2>
            <div className="ty-rider">
              <div className="ty-rider__avatar" aria-hidden />
              <div className="ty-rider__info">
                {assignedDriverUi ? (
                  <>
                    <span className="ty-rider__role">{isShopOrder ? 'Driver' : 'Rider'}</span>
                    <p className="ty-rider__name">{assignedDriverUi.name}</p>
                    <p className="ty-rider__stars" aria-label="Rated driver">
                      ★★★★★
                    </p>
                    <p className="ty-rider__veh">
                      {assignedDriverUi.vehicle} · {assignedDriverUi.plate}
                    </p>
                  </>
                ) : deliveryUuid || shopAwaitingDriver ? (
                  <>
                    <span className="ty-rider__role">{isShopOrder ? 'Driver' : 'Rider'}</span>
                    <p className="ty-rider__name">
                      {shopDriverSearchTimedOut && shopAwaitingDriverAssignment
                        ? noDriverAvailableHeadline()
                        : 'Finding a driver…'}
                    </p>
                    <p className="ty-rider__hint">
                      {shopDriverSearchTimedOut && shopAwaitingDriverAssignment
                        ? noDriverAvailableDetail({ isShop: isShopOrder, isRide: !isShopOrder })
                        : isShopOrder
                          ? 'Driver details appear here once someone accepts your shop delivery.'
                          : 'Driver details appear here once someone accepts your delivery.'}
                    </p>
                  </>
                ) : (
                  <>
                    <span className="ty-rider__role">Rider</span>
                    <p className="ty-rider__name">{DRIVER.name}</p>
                    <p className="ty-rider__stars" aria-label="4.8 out of 5">
                      ★★★★★
                    </p>
                    <p className="ty-rider__veh">
                      {DRIVER.vehicle} · {DRIVER.plate}
                    </p>
                  </>
                )}
              </div>
              {assignedDriverUi ? (
                <div className="ty-rider__actions">
                  <a
                    className="ty-rider__btn"
                    href={driverPhoneOk ? `tel:${driverPhoneOk}` : undefined}
                    aria-disabled={!driverPhoneOk}
                    onClick={(e) => {
                      if (!driverPhoneOk) e.preventDefault();
                    }}
                    aria-label="Call driver"
                  >
                    <PhoneIcon />
                  </a>
                  <Link
                    className="ty-rider__btn"
                    to="/chat"
                    state={{ name: assignedDriverUi.name, role: 'customer' }}
                    aria-label="Message driver"
                  >
                    <ChatIcon />
                  </Link>
                </div>
              ) : !deliveryUuid && !shopAwaitingDriver ? (
                <div className="ty-rider__actions">
                  <button type="button" className="ty-rider__btn" aria-label="Call driver" disabled>
                    <PhoneIcon />
                  </button>
                  <button type="button" className="ty-rider__btn" aria-label="Message driver" disabled>
                    <ChatIcon />
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>

      <div className="ty-footer">
        {isShopOrder ? (
          <Link to="/shops" className="ty-btn ty-btn--primary" replace>
            Continue shopping
          </Link>
        ) : null}
        <Link to="/home" className="ty-btn ty-btn--outline" replace>
          Back to home
        </Link>
      </div>
    </div>
  );
}
