import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import GoogleMapEmbed from '../components/GoogleMapEmbed';
import LiveTrackingRouteMap from '../components/LiveTrackingRouteMap';
import PackagePhotoCapture from '../components/PackagePhotoCapture';
import DriverJobState from '../components/driver/DriverJobState';
import { jobPath, useDriverJob } from '../components/driver/useDriverJob';
import { useLiveLocation } from '../hooks/useLiveLocation';
import { useThrottledMapEmbedSrc } from '../hooks/useThrottledMapEmbedSrc';
import DeliveryPin from '../components/DeliveryPin';
import {
  DELIVERY_PIN_DRIVER_HINT,
  DELIVERY_PIN_INCOMPLETE_ERROR,
  isCompleteDeliveryPin,
  normalizeDeliveryCodeInput,
} from '../lib/deliveryConfirmationCode';
import { cancelDriverBooking, DRIVER_CANCEL_REASONS } from '../lib/driverBookingCancel';
import {
  driverOrderNeedsCashCollectionScreen,
  fetchBookingCustomerContact,
  markDriverBookingCompleted,
} from '../lib/driverIncomingBookings';
import {
  buildDriverRouteMapUrl,
  getGoogleMapsApiKey,
  googleMapsDirectionsDestOnlyUrl,
  isInServiceArea,
  isReliableGpsLatLng,
} from '../lib/googleMapsConfig';
import { isPackagePhotoSrc, persistParcelPackagePhoto } from '../lib/packagePhoto';
import { forwardGeocodeAddress } from '../lib/reverseGeocode';
import { resolveLiveTrackTable } from '../lib/liveTrackTable';
import { notifyShopOrderPickedUp } from '../lib/shopOrderPickedUpNotify';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { getDriverSession } from '../lib/driverSession';
import { ORDER_ALREADY_ACCEPTED_MSG, verifyDriverOwnsBooking } from '../lib/claimOpenBooking';
import './driverDelivery.css';

export default function DriverNavigationPage() {
  const navigate = useNavigate();
  const live = useLiveLocation({ mapThrottleMs: 12000, movePublishMeters: 80 });
  const { state } = useLocation();
  const [ending, setEnding] = useState(false);
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [deliveryCodeInput, setDeliveryCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [liveSyncDisabled, setLiveSyncDisabled] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReasonId, setCancelReasonId] = useState('breakdown');
  const [cancelNote, setCancelNote] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [lostJob, setLostJob] = useState('');
  const [jsMapFailed, setJsMapFailed] = useState(() => !getGoogleMapsApiKey());
  const jsMapAvailable = !jsMapFailed;
  const { order, status: jobStatus, error: jobError, reload: reloadJob } = useDriverJob();
  // Hooks below must keep running while the job resolves; the render is gated.
  const o = useMemo(() => order || {}, [order]);
  const [driverPhoto, setDriverPhoto] = useState(() =>
    isPackagePhotoSrc(o.driverPackagePhotoDataUrl) ? o.driverPackagePhotoDataUrl : '',
  );
  const [photoErr, setPhotoErr] = useState('');
  const [photoSaving, setPhotoSaving] = useState(false);
  const isShopOrder = useMemo(
    () =>
      String(o.bookingTable || '') === 'shop_customer_orders' ||
      String(o.bookingKind || '').toLowerCase() === 'shop',
    [o.bookingTable, o.bookingKind],
  );
  const isParcelDelivery = useMemo(
    () =>
      String(o.bookingTable || '') === 'customer_delivery_orders' ||
      String(o.bookingKind || '').toLowerCase() === 'parcel',
    [o.bookingTable, o.bookingKind],
  );
  const isRideBooking = useMemo(
    () =>
      String(o.bookingTable || '') === 'taxi_bookings' ||
      String(o.bookingTable || '') === 'tuk_tuk_bookings' ||
      ['taxi', 'tuktuk'].includes(String(o.bookingKind || '').toLowerCase()),
    [o.bookingTable, o.bookingKind],
  );
  const pickupButtonLabel = useMemo(() => {
    if (isShopOrder) return 'Order picked up';
    if (isParcelDelivery) return 'Parcel picked up';
    if (isRideBooking) return 'Customer picked up';
    return 'Continue to drop-off';
  }, [isShopOrder, isParcelDelivery, isRideBooking]);
  const pickupButtonAria = useMemo(() => {
    if (isShopOrder) return 'Order picked up from shop, continue to customer';
    if (isParcelDelivery) return 'Parcel picked up, continue to drop-off';
    if (isRideBooking) return 'Customer picked up, continue to drop-off';
    return 'Continue to drop-off';
  }, [isShopOrder, isParcelDelivery, isRideBooking]);
  const pickup = String(state?.pickup || o.from || '').trim();
  const dropoff = String(state?.dropoff || o.to || '').trim();
  const [customerName, setCustomerName] = useState(String(o.customerName || '').trim() || 'Customer');
  const [customerPhone, setCustomerPhone] = useState(String(o.customerPhone || '').trim());
  const phase = state?.phase === 'dropoff' ? 'dropoff' : 'pickup';
  /** Main leg: pickup → drop-off (set from active delivery). Legacy: `phase === 'dropoff'`. */
  const toDropoff = state?.navLeg === 'toDropoff' || phase === 'dropoff';
  const dest = String(state?.dest || (toDropoff ? dropoff : pickup) || '').trim();
  const [pickupGeo, setPickupGeo] = useState(null);
  const [dropoffGeo, setDropoffGeo] = useState(null);
  const [destGeo, setDestGeo] = useState(null);
  const routeLat = useMemo(
    () => (isReliableGpsLatLng(live.lat, live.lng) ? Number(Number(live.lat).toFixed(5)) : null),
    [live.lat, live.lng],
  );
  const routeLng = useMemo(
    () => (isReliableGpsLatLng(live.lat, live.lng) ? Number(Number(live.lng).toFixed(5)) : null),
    [live.lat, live.lng],
  );
  const [routedOrigin, setRoutedOrigin] = useState(null);

  useEffect(() => {
    if (routeLat == null || routeLng == null) return;
    // Keep map stable: lock origin at first reliable fix (or when route phase changes).
    if (!routedOrigin) setRoutedOrigin({ lat: routeLat, lng: routeLng });
  }, [routeLat, routeLng, routedOrigin]);

  useEffect(() => {
    // Re-lock once when switching pickup/drop-off so each phase gets a stable map.
    setRoutedOrigin(null);
  }, [toDropoff, pickup, dropoff]);

  useEffect(() => {
    setCustomerName(String(o.customerName || '').trim() || 'Customer');
    setCustomerPhone(String(o.customerPhone || '').trim());
  }, [o.customerName, o.customerPhone]);

  useEffect(() => {
    let cancelled = false;
    const table = o.bookingTable;
    const id = o.supabaseOrderId;
    const driverId = getDriverSession()?.id || null;
    if (!isSupabaseConfigured || !supabase || !table || !id || !driverId) return undefined;
    (async () => {
      const owns = await verifyDriverOwnsBooking(supabase, table, id, driverId);
      if (cancelled) return;
      if (!owns) {
        setLostJob(ORDER_ALREADY_ACCEPTED_MSG);
        window.setTimeout(() => navigate('/driver/home', { replace: true }), 1800);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [o.bookingTable, o.supabaseOrderId, navigate]);

  useEffect(() => {
    let cancelled = false;
    const table = o.bookingTable;
    const id = o.supabaseOrderId;
    if (!isSupabaseConfigured || !supabase || !table || !id) return undefined;
    (async () => {
      const { full_name, phone } = await fetchBookingCustomerContact(supabase, table, id);
      if (cancelled) return;
      if (full_name) setCustomerName(full_name);
      if (phone) setCustomerPhone(phone);
    })();
    return () => {
      cancelled = true;
    };
  }, [o.bookingTable, o.supabaseOrderId]);

  useEffect(() => {
    let cancelled = false;
    if (!pickup) {
      setPickupGeo(null);
    } else {
      (async () => {
        try {
          const g = await forwardGeocodeAddress(pickup);
          if (!cancelled && g && Number.isFinite(g.lat) && Number.isFinite(g.lng)) {
            setPickupGeo({ lat: g.lat, lng: g.lng });
            return;
          }
          if (!cancelled) setPickupGeo(null);
        } catch {
          if (!cancelled) setPickupGeo(null);
        }
      })();
    }
    if (!dropoff) {
      setDropoffGeo(null);
    } else {
      (async () => {
        try {
          const g = await forwardGeocodeAddress(dropoff);
          if (!cancelled && g && Number.isFinite(g.lat) && Number.isFinite(g.lng)) {
            setDropoffGeo({ lat: g.lat, lng: g.lng });
            return;
          }
          if (!cancelled) setDropoffGeo(null);
        } catch {
          if (!cancelled) setDropoffGeo(null);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [pickup, dropoff]);

  useEffect(() => {
    let cancelled = false;
    if (!dest) {
      setDestGeo(null);
      return undefined;
    }
    (async () => {
      try {
        const g = await forwardGeocodeAddress(dest);
        if (!cancelled && g && Number.isFinite(g.lat) && Number.isFinite(g.lng)) {
          setDestGeo({ lat: g.lat, lng: g.lng });
          return;
        }
        if (!cancelled) setDestGeo(null);
      } catch {
        if (!cancelled) setDestGeo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dest]);

  const navMapSrc = useMemo(
    () =>
      buildDriverRouteMapUrl({
        pickup,
        dropoff,
        navTarget: dest,
        toDropoff,
        routedOrigin,
        pickupGeo,
        dropoffGeo,
        destGeo,
      }),
    [toDropoff, pickup, dropoff, dest, destGeo, routedOrigin, pickupGeo, dropoffGeo],
  );
  const stableNavMapSrc = useThrottledMapEmbedSrc(navMapSrc, {
    throttleMs: 15000,
    bumpKey: `${toDropoff ? 'drop' : 'pick'}|${dest}`,
  });

  const needsDeliveryCode = (isParcelDelivery || isShopOrder) && toDropoff;

  const finishJourney = useCallback(
    async (code) => {
      setEnding(true);
      setCodeError('');
      const table = o.bookingTable;
      const id = o.supabaseOrderId;
      if (isSupabaseConfigured && supabase && table && id) {
        const result = await markDriverBookingCompleted(supabase, table, id, code);
        if (!result.ok) {
          setCodeError(result.error || 'Could not complete delivery.');
          setEnding(false);
          return;
        }
      }
      setShowCodeModal(false);
      setDeliveryCodeInput('');
      setEnding(false);
      if (driverOrderNeedsCashCollectionScreen(o)) {
        navigate(jobPath('collect-payment', o), { replace: true, state: { order: o } });
      } else {
        navigate(jobPath('rate-customer', o), { replace: true, state: { order: o } });
      }
    },
    [navigate, o],
  );

  const onEndJourney = useCallback(() => {
    if (needsDeliveryCode) {
      setCodeError('');
      setDeliveryCodeInput('');
      setShowCodeModal(true);
      return;
    }
    finishJourney(null);
  }, [needsDeliveryCode, finishJourney]);

  const onConfirmDeliveryCode = useCallback(
    (e) => {
      e.preventDefault();
      const entered = normalizeDeliveryCodeInput(deliveryCodeInput);
      if (!isCompleteDeliveryPin(entered)) {
        setCodeError(DELIVERY_PIN_INCOMPLETE_ERROR);
        return;
      }
      finishJourney(entered);
    },
    [deliveryCodeInput, finishJourney],
  );

  const onCustomerPickedUp = useCallback(async () => {
    if (isParcelDelivery && !driverPhoto) {
      setPhotoErr('Take or upload a package photo before continuing.');
      return;
    }
    const table = o.bookingTable;
    const id = o.supabaseOrderId;
    if (isParcelDelivery && id && driverPhoto) {
      setPhotoSaving(true);
      const saved = await persistParcelPackagePhoto('driver', id, driverPhoto, 'driver-package.jpg');
      setPhotoSaving(false);
      if (!saved.ok) {
        setPhotoErr(saved.error || 'Could not save package photo.');
        return;
      }
    }
    if (isSupabaseConfigured && supabase && table === 'shop_customer_orders' && id) {
      const { error } = await supabase
        .from('shop_customer_orders')
        .update({ status: 'picked up' })
        .eq('id', id);
      if (!error) notifyShopOrderPickedUp(supabase, id);
    }
    navigate(jobPath('navigation', o), {
      replace: true,
      state: {
        order: { ...o, driverPackagePhotoDataUrl: driverPhoto || o.driverPackagePhotoDataUrl },
        pickup,
        dropoff,
        dest: dropoff,
        navLeg: 'toDropoff',
        phase: 'dropoff',
      },
    });
  }, [navigate, o, pickup, dropoff, isParcelDelivery, driverPhoto]);

  useEffect(() => {
    const table = o.bookingTable;
    const id = o.supabaseOrderId;
    const liveTrackTable = resolveLiveTrackTable(table);
    if (!isSupabaseConfigured || !supabase || !liveTrackTable || !id || liveSyncDisabled || lostJob) {
      return undefined;
    }
    if (!isReliableGpsLatLng(live.lat, live.lng) || !isInServiceArea(live.lat, live.lng)) return undefined;
    let cancelled = false;
    const syncOnce = async () => {
      const payload = {
        driver_live_lat: Number(live.lat),
        driver_live_lng: Number(live.lng),
        driver_live_updated_at: new Date().toISOString(),
        driver_nav_leg: toDropoff ? 'to_dropoff' : 'to_pickup',
      };
      const driverId = getDriverSession()?.id || '';
      let q = supabase.from(liveTrackTable).update(payload).eq('id', id);
      if (driverId) q = q.eq('assigned_driver_id', driverId);
      const { error } = await q;
      if (cancelled || !error) return;
      if (/driver_live_lat|driver_live_lng|driver_nav_leg|driver_live_updated_at|column/i.test(error.message || '')) {
        setLiveSyncDisabled(true);
      }
    };
    syncOnce();
    const timer = window.setInterval(syncOnce, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [o.bookingTable, o.supabaseOrderId, live.lat, live.lng, toDropoff, liveSyncDisabled, lostJob]);

  const openInGoogleMaps = useCallback(() => {
    const target = toDropoff ? dropoff : pickup;
    const url = googleMapsDirectionsDestOnlyUrl(target);
    if (url) window.open(url, '_blank', 'noopener');
  }, [toDropoff, dropoff, pickup]);

  const canCancelTrip = Boolean(o.bookingTable && o.supabaseOrderId);

  const onConfirmCancelTrip = useCallback(
    async (e) => {
      e.preventDefault();
      if (cancelBusy) return;
      if (cancelReasonId === 'other' && !String(cancelNote || '').trim()) {
        setCancelError('Please type a short note for “Other”.');
        return;
      }
      setCancelBusy(true);
      setCancelError('');
      const result = await cancelDriverBooking({
        table: o.bookingTable,
        bookingId: o.supabaseOrderId,
        reasonId: cancelReasonId,
        note: cancelNote,
      });
      setCancelBusy(false);
      if (!result.ok) {
        setCancelError(result.error || 'Could not cancel.');
        return;
      }
      setShowCancelModal(false);
      navigate('/driver/home', { replace: true, state: { toast: 'Trip cancelled. Customer has been notified.' } });
    },
    [cancelBusy, cancelNote, cancelReasonId, navigate, o.bookingTable, o.supabaseOrderId],
  );

  if (jobStatus !== 'ready') {
    return <DriverJobState status={jobStatus} error={jobError} label="trip" onRetry={reloadJob} />;
  }

  return (
    <div className="nav-page" role="application" aria-label="Navigation">
      {lostJob ? (
        <p role="alert" style={{ margin: 0, padding: '0.75rem 1rem', background: '#fef2f2', color: '#b91c1c', fontWeight: 600 }}>
          {lostJob}
        </p>
      ) : null}
      <div
        className={`nav-mapV${jsMapAvailable || stableNavMapSrc ? ' nav-mapV--gmap' : ' nav-mapV--empty'}`}
        aria-hidden
      >
        {jsMapAvailable ? (
          <LiveTrackingRouteMap
            pickupGeo={pickupGeo}
            dropoffGeo={dropoffGeo}
            driverLat={live.lat}
            driverLng={live.lng}
            driverLiveOk={live.hasFix}
            navLeg={toDropoff ? 'to_dropoff' : 'to_pickup'}
            hasDriver={live.hasFix}
            onLoadError={() => setJsMapFailed(true)}
          />
        ) : (
          <>
            <GoogleMapEmbed src={stableNavMapSrc} title="Driving directions" loading="eager" />
            {!stableNavMapSrc ? (
              <svg viewBox="0 0 320 480" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
                <rect width="320" height="480" fill="#3a4a5a" />
                <path
                  d="M 40 400 Q 100 200 180 80 T 300 20"
                  fill="none"
                  stroke="#0A58A6"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.85"
                />
              </svg>
            ) : null}
          </>
        )}
        <div className="nav-trf" />
      </div>
      <div className="nav-ov2" role="region" aria-label="Route actions">
        <p className="nav-destB">{toDropoff ? 'Drop-off' : 'Pickup'}</p>
        <p style={{ margin: '0.2rem 0 0', fontSize: '0.82rem', fontWeight: 600, lineHeight: 1.35 }}>{dest}</p>
        {!toDropoff && dropoff && dropoff !== pickup ? <p className="nav-txt">Next: {dropoff}</p> : null}
        <div className="nav-cusBox" aria-label="Customer details">
          <p className="nav-cusName">{customerName}</p>
          <p className="nav-cusPhone">{customerPhone || 'Phone not available yet'}</p>
        </div>
        {!toDropoff && isParcelDelivery ? (
          <div className="nav-pkgPhoto">
            {isPackagePhotoSrc(o.packagePhotoDataUrl) ? (
              <figure className="da-packagePhotoWrap" style={{ margin: '0.35rem 0' }}>
                <figcaption className="da-packagePhotoCap">Customer photo</figcaption>
                <img className="da-packagePhotoImg" src={o.packagePhotoDataUrl} alt="Customer package" />
              </figure>
            ) : null}
            <PackagePhotoCapture
              compact
              required
              value={driverPhoto}
              onChange={(url) => {
                setPhotoErr('');
                setDriverPhoto(url || '');
              }}
              label="Package photo"
              hint="Take or upload a photo of the parcel at pickup."
            />
            {photoErr ? (
              <p role="alert" style={{ margin: '0.35rem 0 0', color: '#b91c1c', fontSize: '0.78rem', fontWeight: 700 }}>
                {photoErr}
              </p>
            ) : null}
          </div>
        ) : null}
        {needsDeliveryCode ? (
          <p className="nav-codeHint" role="note">
            At drop-off, ask the customer for their 6-digit delivery PIN before you complete the journey.
          </p>
        ) : null}
        <div className="nav-actions">
          <button type="button" className="nav-mainBtn nav-mainBtn--maps" onClick={openInGoogleMaps}>
            Open in Google Maps
          </button>
          {!toDropoff ? (
            <button
              type="button"
              className="nav-mainBtn nav-mainBtn--pickup"
              onClick={onCustomerPickedUp}
              disabled={photoSaving}
              aria-label={pickupButtonAria}
            >
              {photoSaving ? 'Saving photo…' : pickupButtonLabel}
            </button>
          ) : null}
        </div>
        {toDropoff ? (
          <div className="nav-doneWrap">
            <button
              type="button"
              className="nav-mainBtn nav-mainBtn--done"
              disabled={ending || cancelBusy}
              onClick={onEndJourney}
            >
              <span className="nav-mainBtn__icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M7.5 12.2l2.6 2.6 6.4-6.8"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>
                {ending
                  ? 'Confirming…'
                  : isParcelDelivery || isShopOrder
                    ? 'Complete Delivery'
                    : 'End journey'}
              </span>
            </button>
          </div>
        ) : null}
        {canCancelTrip ? (
          <button
            type="button"
            className="nav-cancelTrip"
            disabled={ending || cancelBusy}
            onClick={() => {
              setCancelError('');
              setShowCancelModal(true);
            }}
          >
            Cancel trip
          </button>
        ) : null}
      </div>
      {showCancelModal ? (
        <div className="nav-codeModal" role="dialog" aria-modal="true" aria-labelledby="nav-cancelModal-title">
          <form className="nav-codeModal__panel" onSubmit={onConfirmCancelTrip}>
            <h2 id="nav-cancelModal-title" className="nav-codeModal__title">
              Cancel trip
            </h2>
            <p className="nav-codeModal__hint">
              Choose a reason. This is saved and shown to the customer and admin.
            </p>
            <label className="nav-codeModal__label" htmlFor="nav-cancel-reason">
              Reason
            </label>
            <select
              id="nav-cancel-reason"
              className="nav-cancelSelect"
              value={cancelReasonId}
              onChange={(e) => {
                setCancelReasonId(e.target.value);
                setCancelError('');
              }}
              disabled={cancelBusy}
            >
              {DRIVER_CANCEL_REASONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <label className="nav-codeModal__label" htmlFor="nav-cancel-note">
              Extra details {cancelReasonId === 'other' ? '(required)' : '(optional)'}
            </label>
            <textarea
              id="nav-cancel-note"
              className="nav-cancelNote"
              rows={3}
              maxLength={200}
              placeholder="e.g. flat tyre near Main St"
              value={cancelNote}
              onChange={(e) => setCancelNote(e.target.value)}
              disabled={cancelBusy}
            />
            {cancelError ? (
              <p className="nav-codeModal__error" role="alert">
                {cancelError}
              </p>
            ) : null}
            <div className="nav-codeModal__actions">
              <button
                type="button"
                className="nav-codeModal__btn nav-codeModal__btn--ghost"
                disabled={cancelBusy}
                onClick={() => {
                  if (cancelBusy) return;
                  setShowCancelModal(false);
                  setCancelError('');
                }}
              >
                Keep trip
              </button>
              <button type="submit" className="nav-codeModal__btn nav-codeModal__btn--danger" disabled={cancelBusy}>
                {cancelBusy ? 'Cancelling…' : 'Confirm cancel'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {showCodeModal ? (
        <div className="nav-codeModal" role="dialog" aria-modal="true" aria-labelledby="nav-codeModal-title">
          <form className="nav-codeModal__panel" onSubmit={onConfirmDeliveryCode}>
            <h2 id="nav-codeModal-title" className="nav-codeModal__title">
              Delivery PIN
            </h2>
            <p className="nav-codeModal__hint">{DELIVERY_PIN_DRIVER_HINT}</p>
            <p className="nav-codeModal__label" id="nav-delivery-pin-label">
              Customer PIN
            </p>
            <DeliveryPin
              idPrefix="nav-delivery-pin"
              value={deliveryCodeInput}
              onChange={(next) => {
                setDeliveryCodeInput(next);
                setCodeError('');
              }}
              disabled={ending}
              autoFocus
              ariaLabel="Customer delivery PIN"
            />
            {codeError ? (
              <p className="nav-codeModal__error" role="alert">
                {codeError}
              </p>
            ) : null}
            <div className="nav-codeModal__actions">
              <button
                type="button"
                className="nav-codeModal__btn nav-codeModal__btn--ghost"
                disabled={ending}
                onClick={() => {
                  if (ending) return;
                  setShowCodeModal(false);
                  setDeliveryCodeInput('');
                  setCodeError('');
                }}
              >
                Cancel
              </button>
              <button type="submit" className="nav-codeModal__btn nav-codeModal__btn--primary" disabled={ending}>
                {ending ? 'Confirming…' : 'Confirm delivery'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
