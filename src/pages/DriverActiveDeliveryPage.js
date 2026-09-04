import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import GoogleMapEmbed from '../components/GoogleMapEmbed';
import LiveTrackingRouteMap from '../components/LiveTrackingRouteMap';
import PackagePhotoCapture from '../components/PackagePhotoCapture';
import DriverJobState from '../components/driver/DriverJobState';
import { jobPath, useDriverJob } from '../components/driver/useDriverJob';
import { useLiveLocation } from '../hooks/useLiveLocation';
import { isPackagePhotoSrc, persistParcelPackagePhoto } from '../lib/packagePhoto';
import { formatGBP } from '../lib/currency';
import {
  buildDriverRouteMapUrl,
  getGoogleMapsApiKey,
  isInServiceArea,
} from '../lib/googleMapsConfig';
import { fetchBookingCustomerContact, isWalletCustomerPayment, isCashCustomerPayment, markDriverLeftAcceptedDelivery, ORDER_ALREADY_ACCEPTED_MSG, verifyDriverOwnsBooking } from '../lib/driverIncomingBookings';
import { getDriverSession } from '../lib/driverSession';
import { forwardGeocodeAddress } from '../lib/reverseGeocode';
import { resolveLiveTrackTable } from '../lib/liveTrackTable';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import './driverDelivery.css';

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
/** Filled handset — standard orientation (no extra rotate; reads clearly in a circle). */
function IcCall() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden className="da-cIco">
      <path
        fill="currentColor"
        d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.21z"
      />
    </svg>
  );
}
/** Solid message bubble — flat body + tail bottom-left; inset so it does not clip the circle. */
function IcChat() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden className="da-cIco">
      <path
        fill="currentColor"
        d="M5.5 4.5h13V10.5H9.6L6.4 14.2V12H5.5V4.5z"
      />
    </svg>
  );
}

const fmt$ = (n) => formatGBP(n);

export default function DriverActiveDeliveryPage() {
  const navigate = useNavigate();
  const live = useLiveLocation({ mapThrottleMs: 8000 });
  const { order, status: jobStatus, error: jobError, reload: reloadJob } = useDriverJob();
  // Every hook below must still run while the job resolves, so `o` is an empty
  // object rather than a fixture. The screen itself is gated at the return.
  const o = useMemo(() => order || {}, [order]);
  const [customerName, setCustomerName] = useState(o.customerName);
  const [customerPhone, setCustomerPhone] = useState(o.customerPhone);
  const [pickupGeo, setPickupGeo] = useState(null);
  const [dropoffGeo, setDropoffGeo] = useState(null);
  const [packagePhotoSrc, setPackagePhotoSrc] = useState(() =>
    isPackagePhotoSrc(o?.packagePhotoDataUrl) ? o.packagePhotoDataUrl : null,
  );
  const [driverPhotoSrc, setDriverPhotoSrc] = useState(() =>
    isPackagePhotoSrc(o?.driverPackagePhotoDataUrl) ? o.driverPackagePhotoDataUrl : null,
  );
  const [photoErr, setPhotoErr] = useState('');
  const [lostJob, setLostJob] = useState('');
  const [jsMapFailed, setJsMapFailed] = useState(() => !getGoogleMapsApiKey());
  const jsMapAvailable = !jsMapFailed;

  const pickup = String(o.from || '').trim();
  const dropoff = String(o.to || '').trim() || pickup;

  useEffect(() => {
    setCustomerName(o.customerName);
    setCustomerPhone(o.customerPhone);
  }, [o.customerName, o.customerPhone]);

  useEffect(() => {
    let cancelled = false;
    const fromNav = isPackagePhotoSrc(o.packagePhotoDataUrl) ? o.packagePhotoDataUrl : null;
    const fromDriver = isPackagePhotoSrc(o.driverPackagePhotoDataUrl) ? o.driverPackagePhotoDataUrl : null;
    if (fromNav) setPackagePhotoSrc(fromNav);
    if (fromDriver) setDriverPhotoSrc(fromDriver);
    if (fromNav && fromDriver) {
      return () => {
        cancelled = true;
      };
    }
    const table = o.bookingTable;
    const id = o.supabaseOrderId;
    if (!isSupabaseConfigured || !supabase || table !== 'customer_delivery_orders' || !id) {
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      const { data, error } = await supabase
        .from('customer_delivery_orders')
        .select('package_photo_data_url, driver_package_photo_data_url')
        .eq('id', id)
        .maybeSingle();
      if (cancelled || error || !data) return;
      if (!fromNav && isPackagePhotoSrc(data.package_photo_data_url)) setPackagePhotoSrc(data.package_photo_data_url);
      if (!fromDriver && isPackagePhotoSrc(data.driver_package_photo_data_url)) {
        setDriverPhotoSrc(data.driver_package_photo_data_url);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [o.packagePhotoDataUrl, o.driverPackagePhotoDataUrl, o.bookingTable, o.supabaseOrderId]);

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
    (async () => {
      try {
        const [pu, dr] = await Promise.all([forwardGeocodeAddress(pickup), forwardGeocodeAddress(dropoff)]);
        if (cancelled) return;
        setPickupGeo(pu && Number.isFinite(pu.lat) && Number.isFinite(pu.lng) ? pu : null);
        setDropoffGeo(dr && Number.isFinite(dr.lat) && Number.isFinite(dr.lng) ? dr : null);
      } catch {
        if (!cancelled) {
          setPickupGeo(null);
          setDropoffGeo(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickup, dropoff]);

  const startDeliveryRouteNav = () => {
    if (lostJob) return;
    const table = o.bookingTable;
    const id = o.supabaseOrderId;
    const liveTrackTable = resolveLiveTrackTable(table);
    if (
      isSupabaseConfigured &&
      supabase &&
      liveTrackTable &&
      id &&
      Number.isFinite(live.lat) &&
      Number.isFinite(live.lng) &&
      isInServiceArea(live.lat, live.lng)
    ) {
      const payload = {
        driver_live_lat: Number(live.lat),
        driver_live_lng: Number(live.lng),
        driver_live_updated_at: new Date().toISOString(),
        driver_nav_leg: 'to_pickup',
      };
      // Fire-and-forget: helps customer /live-tracking and shop owner order map show driver journey immediately.
      supabase
        .from(liveTrackTable)
        .update(payload)
        .eq('id', id)
        .eq('assigned_driver_id', getDriverSession()?.id || '')
        .then(() => {})
        .catch(() => {});
    }
    navigate(jobPath('navigation', o), {
      state: {
        order: {
          ...o,
          customerName: customerName || o.customerName,
          customerPhone: customerPhone || o.customerPhone,
          packagePhotoDataUrl: packagePhotoSrc || o.packagePhotoDataUrl,
          driverPackagePhotoDataUrl: driverPhotoSrc || o.driverPackagePhotoDataUrl,
        },
        pickup,
        dropoff,
        dest: pickup,
        navLeg: 'toPickup',
      },
    });
  };

  /** Stable route preview: address directions immediately, geocoded coords when ready. */
  const journeyMapSrc = useMemo(
    () =>
      buildDriverRouteMapUrl({
        pickup,
        dropoff,
        pickupGeo,
        dropoffGeo,
      }),
    [pickup, dropoff, pickupGeo, dropoffGeo],
  );

  if (jobStatus !== 'ready') {
    return <DriverJobState status={jobStatus} error={jobError} label="delivery" onRetry={reloadJob} />;
  }

  return (
    <div className="da-page dd" role="main" aria-label="Active delivery">
      <header className="da-h">
        <button
          type="button"
          className="da-back"
          onClick={() => {
            if (o.bookingTable && o.supabaseOrderId) {
              markDriverLeftAcceptedDelivery(o.bookingTable, o.supabaseOrderId);
            }
            navigate('/driver/home');
          }}
          aria-label="Back"
        >
          <Back />
        </button>
        <div className="da-ht">
          <h1>Active Delivery</h1>
          <p className="da-oid">{o.id}</p>
        </div>
      </header>

      {lostJob ? (
        <p className="da-oid" role="alert" style={{ margin: '0.75rem 1rem', color: '#b91c1c', fontWeight: 600 }}>
          {lostJob}
        </p>
      ) : null}

      <div
        className={`da-map${jsMapAvailable || journeyMapSrc ? ' da-map--gmap' : ' da-map--empty'}`}
        aria-hidden
      >
        {jsMapAvailable ? (
          <LiveTrackingRouteMap
            pickupGeo={pickupGeo}
            dropoffGeo={dropoffGeo}
            driverLat={live.lat}
            driverLng={live.lng}
            driverLiveOk={live.hasFix}
            navLeg="to_pickup"
            hasDriver={live.hasFix}
            onLoadError={() => setJsMapFailed(true)}
          />
        ) : (
          <>
            <GoogleMapEmbed src={journeyMapSrc} title="Pickup to drop-off route" loading="eager" />
            {!journeyMapSrc ? (
              <>
                <div className="da-pulse" />
                <svg viewBox="0 0 320 220" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" role="img">
                  <path
                    d="M 85 150 Q 150 100 200 80 T 255 60"
                    fill="none"
                    stroke="#F18631"
                    strokeWidth="4.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="da-sheet">
        <div className="da-sc">
          <div className="da-card">
            <p className="da-ps">Head to Pickup</p>
            <div className="da-journey" aria-label="Journey route">
              <div className="da-jrow">
                <span className="da-jdot da-jdot--pickup" aria-hidden />
                <div>
                  <p className="da-jlab">Pickup</p>
                  <p className="da-jaddr">{pickup}</p>
                </div>
              </div>
              <div className="da-jsep" aria-hidden />
              <div className="da-jrow">
                <span className="da-jdot da-jdot--dropoff" aria-hidden />
                <div>
                  <p className="da-jlab">Drop-off</p>
                  <p className="da-jaddr">{dropoff}</p>
                </div>
              </div>
            </div>
            <p className="da-eta">
              {o.dist}
              {' '}
              ·
              {o.eta}
              {' '}
              away
            </p>
            <button type="button" className="da-navB" onClick={startDeliveryRouteNav}>
              Start delivery route
            </button>
          </div>

          <div className="da-cu">
            <div className="da-av" aria-hidden />
            <div className="da-cB">
              <p className="da-cn">{customerName || 'Customer'}</p>
              <p className="da-sen">
                {o.bookingKind === 'shop' || o.bookingTable === 'shop_customer_orders'
                  ? 'Customer'
                  : !o.bookingKind || o.bookingKind === 'parcel'
                    ? 'Sender'
                    : 'Rider'}
              </p>
              {customerPhone ? (
                <p className="da-cphone" style={{ margin: '0.2rem 0 0', fontSize: '0.95rem', fontWeight: 600 }}>
                  {customerPhone}
                </p>
              ) : null}
            </div>
            <div className="da-cAc">
              <a
                className="da-cB2"
                href={customerPhone ? `tel:${String(customerPhone).replace(/\s/g, '')}` : '#'}
                onClick={(e) => {
                  if (!customerPhone) e.preventDefault();
                }}
                aria-label="Call customer"
                title="Call"
                style={!customerPhone ? { pointerEvents: 'none', opacity: 0.45 } : undefined}
              >
                <IcCall />
              </a>
              <Link
                to="/chat"
                state={{ name: customerName, role: 'driver' }}
                className="da-cB2"
                aria-label="Message customer"
              >
                <IcChat />
              </Link>
            </div>
          </div>

          <div className="da-badR" aria-label="Package">
            <span className="da-bdg">
              {o.size || o.pkg}
            </span>
            <span className="da-bdg">
              {o.type || o.pkg}
            </span>
            {o.packageWeight ? (
              <span className="da-bdg" title="Package weight">
                {o.packageWeight}
              </span>
            ) : null}
          </div>
          {packagePhotoSrc ? (
            <figure className="da-packagePhotoWrap">
              <figcaption className="da-packagePhotoCap">Customer photo</figcaption>
              <img className="da-packagePhotoImg" src={packagePhotoSrc} alt="Customer package" loading="lazy" />
            </figure>
          ) : null}
          {String(o.bookingTable || '') === 'customer_delivery_orders' || String(o.bookingKind || '') === 'parcel' ? (
            <div style={{ margin: '0.35rem 0 0.45rem' }}>
              <PackagePhotoCapture
                compact
                value={driverPhotoSrc}
                onChange={async (url) => {
                  setPhotoErr('');
                  setDriverPhotoSrc(url);
                  const id = o.supabaseOrderId;
                  if (!id) return;
                  const saved = await persistParcelPackagePhoto('driver', id, url, 'driver-package.jpg');
                  if (!saved.ok) setPhotoErr(saved.error || 'Could not save photo.');
                }}
                label="Your package photo"
                hint="Take or upload a photo of the parcel at pickup."
              />
              {photoErr ? (
                <p role="alert" style={{ margin: '0.35rem 0 0', color: '#b91c1c', fontSize: '0.78rem', fontWeight: 600 }}>
                  {photoErr}
                </p>
              ) : null}
            </div>
          ) : null}
          {o.customerPayment && o.customerPayment !== '—' ? (
            <div
              className={`da-customerPay${
                isWalletCustomerPayment(o.payment_method) || isWalletCustomerPayment(o.customerPayment)
                  ? ' da-customerPay--wallet'
                  : ''
              }${
                isCashCustomerPayment(o.payment_method) || isCashCustomerPayment(o.customerPayment)
                  ? ' da-customerPay--cash'
                  : ''
              }`}
              role="status"
            >
              <p className="da-customerPay__line">
                Payment:{' '}
                <strong>
                  {isWalletCustomerPayment(o.payment_method) || isWalletCustomerPayment(o.customerPayment)
                    ? 'Wallet Payment'
                    : isCashCustomerPayment(o.payment_method) || isCashCustomerPayment(o.customerPayment)
                      ? 'Cash Payment'
                      : o.customerPayment}
                </strong>
              </p>
              {isWalletCustomerPayment(o.payment_method) || isWalletCustomerPayment(o.customerPayment) ? (
                <p className="da-customerPay__note">
                  Customer has already paid through the Ingo Wallet. Do not collect cash.
                </p>
              ) : null}
              {isCashCustomerPayment(o.payment_method) || isCashCustomerPayment(o.customerPayment) ? (
                <p className="da-customerPay__note da-customerPay__note--cash">
                  Collect cash from the customer at drop-off.
                </p>
              ) : null}
            </div>
          ) : null}
          {o.specialInstructions ? <p className="da-misc">{o.specialInstructions}</p> : null}

          <div className="da-rowE">
            <span className="da-eL">You will earn</span>
            <span className="da-eR">{fmt$(o.amount)}</span>
          </div>

          <div className="da-acts" role="group" aria-label="Next actions">
            <button
              type="button"
              className="da-ia"
              onClick={() =>
                navigate(jobPath('confirm-pickup', o), {
                  state: {
                    order: {
                      ...o,
                      packagePhotoDataUrl: packagePhotoSrc || o.packagePhotoDataUrl,
                      driverPackagePhotoDataUrl: driverPhotoSrc || o.driverPackagePhotoDataUrl,
                    },
                  },
                })
              }
            >
              I Have Arrived
            </button>
            <button
              type="button"
              className="da-rp"
              onClick={() => {
                window.alert('Report your issue. Support will be notified. (Demo)');
              }}
            >
              Report Issue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
