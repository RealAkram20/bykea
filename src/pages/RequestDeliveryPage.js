import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import GoogleMapEmbed from '../components/GoogleMapEmbed';
import LiveUserGoogleMap from '../components/LiveUserGoogleMap';
import LocationPermissionPrompt from '../components/LocationPermissionPrompt';
import LiveUserMapPuck from '../components/LiveUserMapPuck';
import { useLiveLocation } from '../hooks/useLiveLocation';
import {
  DEFAULT_MAP_FALLBACK,
  getGoogleMapsApiKey,
  publicDirectionsCoordsMapUrl,
  publicPlaceMapUrl,
  publicViewMapUrl,
  trustedMapCenter,
} from '../lib/googleMapsConfig';
import {
  geolocationFailureMessage,
  pickupLineFromCoords,
} from '../lib/devicePickupLocation';
import { forwardGeocodeAddress } from '../lib/reverseGeocode';
import { estimateRoadKm, haversineKm } from '../lib/routeEstimate';
import { fetchNearbyDrivers } from '../lib/nearbyDrivers';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import AddressSuggestInput from '../components/AddressSuggestInput';
import './bookRide.css';

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

function GpsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="4.5" strokeWidth="1.3" fill="none" />
      <path d="M12 3.5V7M12 17v3.5M3.5 12H7M17 12h3.5" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9.5 7.5L14 12l-4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconDeliverBag() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="8" width="14" height="12" rx="2" fill="#EC6C23" fillOpacity="0.15" stroke="#EC6C23" strokeWidth="1.6" />
      <path d="M8 8V6a4 4 0 0 1 8 0v2" stroke="#EC6C23" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function createStop() {
  return { id: `${Date.now()}-${Math.random()}` };
}

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export default function RequestDeliveryPage() {
  const navigate = useNavigate();
  const live = useLiveLocation({ mapThrottleMs: 4000 });
  const hasMapsKey = Boolean(getGoogleMapsApiKey());
  const [deliveryJsMapFailed, setDeliveryJsMapFailed] = useState(false);
  const [pickup, setPickup] = useState('');
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsNotice, setGpsNotice] = useState('');
  const [stops, setStops] = useState([createStop()]);

  const setAt = (i, v) => {
    setStops((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], value: v };
      return next;
    });
  };

  const [routeDistanceKm, setRouteDistanceKm] = useState(null);
  const [nearbyDrivers, setNearbyDrivers] = useState([]);
  const [pickupCoords, setPickupCoords] = useState(null);
  const [dropoffCoords, setDropoffCoords] = useState(null);
  const [pinBusy, setPinBusy] = useState('');
  /** Skip one geocode cycle after a pin drag so we don't snap the pin back to a coarse place. */
  const skipGeocodeFromDragRef = useRef(false);

  const onContinue = async (e) => {
    e.preventDefault();
    const p = pickup.trim();
    const stopTexts = stops.map((s) => String(s?.value ?? '').trim()).filter(Boolean);
    const drop = stopTexts[stopTexts.length - 1] || '';
    let km = routeDistanceKm;
    if (km == null && p && drop) {
      try {
        const pickupGeo = await forwardGeocodeAddress(p);
        const destGeo = await forwardGeocodeAddress(drop);
        const middleTexts = stopTexts.length > 1 ? stopTexts.slice(0, -1) : [];
        if (pickupGeo && destGeo) {
          let straight = 0;
          let prev = { lat: pickupGeo.lat, lng: pickupGeo.lng };
          for (const t of middleTexts) {
            const wp = await forwardGeocodeAddress(t);
            if (!wp) {
              straight = null;
              break;
            }
            const h = haversineKm(prev.lat, prev.lng, wp.lat, wp.lng);
            if (h == null) {
              straight = null;
              break;
            }
            straight += h;
            prev = { lat: wp.lat, lng: wp.lng };
          }
          if (straight != null) {
            const hLast = haversineKm(prev.lat, prev.lng, destGeo.lat, destGeo.lng);
            if (hLast != null) straight += hLast;
            else straight = null;
          }
          if (straight != null) {
            const road = estimateRoadKm(straight);
            if (road != null) km = road;
          }
        }
      } catch {
        /* keep km null */
      }
    }
    // Unknown stays unknown (null). The estimate page then tries its own geocode
    // and, if that fails too, says so next to the price instead of pricing a
    // silently invented 4.2 km.
    const distanceKm =
      km != null && Number.isFinite(km) && km > 0 ? Math.round(km * 100) / 100 : null;
    navigate('/package-details', {
      state: { pickup, stops, distanceKm },
    });
  };

  const debouncedPickup = useDebouncedValue(pickup.trim(), 320);
  const debouncedStops = useDebouncedValue(stops, 320);

  const [coordsRouteSrc, setCoordsRouteSrc] = useState('');

  useEffect(() => {
    let cancelled = false;
    const p = debouncedPickup.trim();
    const stopTexts = debouncedStops.map((s) => (s?.value ?? '').trim()).filter(Boolean);
    const destinationText = stopTexts[stopTexts.length - 1] || '';
    const middleTexts = stopTexts.length > 1 ? stopTexts.slice(0, -1) : [];

    if (!p && !destinationText) {
      setCoordsRouteSrc('');
      setRouteDistanceKm(null);
      setPickupCoords(null);
      setDropoffCoords(null);
      return undefined;
    }

    if (skipGeocodeFromDragRef.current) {
      skipGeocodeFromDragRef.current = false;
      return undefined;
    }

    (async () => {
      try {
        const pickupGeo = p ? await forwardGeocodeAddress(p) : null;
        const destGeo = destinationText ? await forwardGeocodeAddress(destinationText) : null;
        if (cancelled) return;

        if (pickupGeo) setPickupCoords({ lat: pickupGeo.lat, lng: pickupGeo.lng });
        else if (!p) setPickupCoords(null);

        if (destGeo) setDropoffCoords({ lat: destGeo.lat, lng: destGeo.lng });
        else if (!destinationText) setDropoffCoords(null);

        if (!pickupGeo || !destGeo) {
          setCoordsRouteSrc('');
          setRouteDistanceKm(null);
          return;
        }

        let waypointPairs = [];
        if (middleTexts.length) {
          const midGeos = await Promise.all(middleTexts.map((t) => forwardGeocodeAddress(t)));
          if (cancelled) return;
          waypointPairs = midGeos.filter(Boolean).map((g) => [g.lat, g.lng]);
        }

        let straight = 0;
        let prev = { lat: pickupGeo.lat, lng: pickupGeo.lng };
        for (const pair of waypointPairs) {
          const h = haversineKm(prev.lat, prev.lng, pair[0], pair[1]);
          if (h == null) {
            straight = null;
            break;
          }
          straight += h;
          prev = { lat: pair[0], lng: pair[1] };
        }
        if (straight != null) {
          const hLast = haversineKm(prev.lat, prev.lng, destGeo.lat, destGeo.lng);
          if (hLast != null) straight += hLast;
          else straight = null;
        }
        const roadKm = straight != null ? estimateRoadKm(straight) : null;
        if (!cancelled) setRouteDistanceKm(roadKm != null && roadKm > 0 ? roadKm : null);

        const url = publicDirectionsCoordsMapUrl(
          pickupGeo.lat,
          pickupGeo.lng,
          destGeo.lat,
          destGeo.lng,
          waypointPairs,
        );
        if (!cancelled) setCoordsRouteSrc(url || '');
      } catch {
        if (!cancelled) {
          setCoordsRouteSrc('');
          setRouteDistanceKm(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [debouncedPickup, debouncedStops]);

  const textFallbackMapSrc = useMemo(() => {
    const stopTexts = debouncedStops.map((s) => (s?.value ?? '').trim()).filter(Boolean);
    const dropFirst = stopTexts[0] ?? '';
    const p = debouncedPickup.trim();

    if (p && stopTexts.length >= 1) {
      return publicPlaceMapUrl(p);
    }
    if (p) return publicPlaceMapUrl(p);
    if (dropFirst) return publicPlaceMapUrl(dropFirst);
    const c = trustedMapCenter(live.mapCenter);
    return publicViewMapUrl(c.lat, c.lng, 14);
  }, [debouncedPickup, debouncedStops, live.mapCenter]);

  const requestMapSrc = coordsRouteSrc || textFallbackMapSrc;

  const hasPickupAndDropoff =
    pickup.trim().length > 0 && (stops[0]?.value ?? '').trim().length > 0;

  const hasEditablePins = Boolean(pickupCoords || dropoffCoords);

  const deliveryInteractiveMapCenter = useMemo(() => {
    if (pickupCoords) return trustedMapCenter(pickupCoords);
    if (live.hasFix && live.lat != null && live.lng != null) {
      return trustedMapCenter({ lat: live.lat, lng: live.lng });
    }
    return trustedMapCenter(live.mapCenter);
  }, [pickupCoords, live.hasFix, live.lat, live.lng, live.mapCenter]);

  const jsMapAvailable = hasMapsKey && !deliveryJsMapFailed;

  useEffect(() => {
    if (!jsMapAvailable || hasEditablePins || !live.hasFix || live.lat == null || live.lng == null) {
      setNearbyDrivers([]);
      return undefined;
    }
    if (!isSupabaseConfigured || !supabase) return undefined;

    let cancelled = false;
    const load = async () => {
      try {
        const list = await fetchNearbyDrivers(supabase, live.lat, live.lng);
        if (!cancelled) setNearbyDrivers(list);
      } catch {
        if (!cancelled) setNearbyDrivers([]);
      }
    };
    load();
    const id = window.setInterval(load, 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [jsMapAvailable, hasEditablePins, live.hasFix, live.lat, live.lng]);

  const useGps = async () => {
    if (gpsLoading) return;
    setGpsNotice('');
    setGpsLoading(true);
    try {
      const coords = await live.refreshFromUserGesture();
      const next = { lat: coords.latitude, lng: coords.longitude };
      setPickupCoords(next);
      skipGeocodeFromDragRef.current = true;
      const line = await pickupLineFromCoords(coords.latitude, coords.longitude);
      setPickup(line);
    } catch (err) {
      const code = typeof err?.code === 'number' ? err.code : 2;
      setGpsNotice(geolocationFailureMessage(code));
    } finally {
      setGpsLoading(false);
    }
  };

  const recomputeDistanceFromPins = (pu, drop) => {
    if (!pu || !drop) {
      setRouteDistanceKm(null);
      setCoordsRouteSrc('');
      return;
    }
    const straight = haversineKm(pu.lat, pu.lng, drop.lat, drop.lng);
    const roadKm = straight != null ? estimateRoadKm(straight) : null;
    setRouteDistanceKm(roadKm != null && roadKm > 0 ? roadKm : null);
    const url = publicDirectionsCoordsMapUrl(pu.lat, pu.lng, drop.lat, drop.lng, []);
    setCoordsRouteSrc(url || '');
  };

  const onPickupDragEnd = async (lat, lng) => {
    const next = { lat, lng };
    setPickupCoords(next);
    recomputeDistanceFromPins(next, dropoffCoords);
    setPinBusy('pickup');
    skipGeocodeFromDragRef.current = true;
    try {
      const line = await pickupLineFromCoords(lat, lng);
      setPickup(line);
      setGpsNotice('');
    } catch {
      setPickup(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    } finally {
      setPinBusy('');
    }
  };

  const onDropoffDragEnd = async (lat, lng) => {
    const next = { lat, lng };
    setDropoffCoords(next);
    recomputeDistanceFromPins(pickupCoords, next);
    setPinBusy('dropoff');
    skipGeocodeFromDragRef.current = true;
    try {
      const line = await pickupLineFromCoords(lat, lng);
      setAt(0, line);
    } catch {
      setAt(0, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    } finally {
      setPinBusy('');
    }
  };

  const distanceLabel =
    routeDistanceKm != null && Number.isFinite(routeDistanceKm)
      ? `${routeDistanceKm.toFixed(1)} km`
      : '—';

  return (
    <form id="rd-delivery-form" className="br-page" onSubmit={onContinue}>
      <header className="br-nav">
        <Link to="/home" className="br-nav__back" aria-label="Back to home">
          <BackArrow />
        </Link>
        <h1 className="br-nav__title">Delivery</h1>
        <span className="br-nav__spacer" aria-hidden />
      </header>

      <div className="br-scroll">
        <section className="br-tiers br-tiers--delivery" aria-label="Delivery service">
          <div className="br-delivery-hero">
            <span className="br-delivery-hero__icon" aria-hidden>
              <IconDeliverBag />
            </span>
            <div className="br-delivery-hero__text">
              <p className="br-delivery-hero__title">Send a package</p>
              <p className="br-delivery-hero__sub">Fast, reliable deliveries across town</p>
            </div>
          </div>
        </section>

        <div className="br-map-wrap">
          <div
            className={`br-map${jsMapAvailable || requestMapSrc ? ' br-map--gmap' : ''}${
              hasEditablePins ? ' br-map--editable' : ''
            }`}
            role="region"
            aria-label="Map with pickup and dropoff — drag pins to adjust"
          >
            {jsMapAvailable ? (
              <div className="br-map-js-layer">
                <LiveUserGoogleMap
                  mapCenter={deliveryInteractiveMapCenter}
                  fallbackCenter={DEFAULT_MAP_FALLBACK}
                  hasFix={live.hasFix}
                  accurate={live.hasFix}
                  accuracyM={live.accuracy}
                  onLoadError={() => setDeliveryJsMapFailed(true)}
                  zoomWithFix={15}
                  zoomFallback={12}
                  showUserLocationMarker={!hasEditablePins}
                  nearbyDrivers={hasEditablePins ? undefined : nearbyDrivers}
                  pickupPin={pickupCoords}
                  dropoffPin={dropoffCoords}
                  onPickupDragEnd={onPickupDragEnd}
                  onDropoffDragEnd={onDropoffDragEnd}
                />
                {!hasEditablePins && nearbyDrivers.length > 0 ? (
                  <span className="br-map-nearby" aria-live="polite">
                    {nearbyDrivers.length} driver{nearbyDrivers.length === 1 ? '' : 's'} nearby
                  </span>
                ) : null}
                {hasEditablePins ? (
                  <span className="br-map-hint" aria-live="polite">
                    {pinBusy
                      ? 'Updating address…'
                      : 'Drag the green (pickup) or orange (drop-off) pin to fine-tune'}
                  </span>
                ) : null}
              </div>
            ) : (
              <>
                <GoogleMapEmbed src={requestMapSrc} title="Delivery route preview" />
                <LiveUserMapPuck
                  headingDeg={live.headingDeg}
                  accurate={live.hasFix}
                  visible={
                    !hasPickupAndDropoff && (live.hasFix || live.geoError !== 'denied')
                  }
                  className="live-puck--inMap"
                />
              </>
            )}
          </div>
        </div>

        <LocationPermissionPrompt live={live} placement="flow" />

        <div className="br-loc-card">
          <div className="br-loc-list">
            <div className="br-loc-row flow-field--addrSuggest">
              <span className="br-loc-row__dot br-loc-row__dot--pickup" aria-hidden />
              <div className="br-loc-row__main">
                <span className="br-loc-row__label">Pickup location</span>
                <div className="br-loc-row__input">
                  <AddressSuggestInput
                    id="flow-pickup"
                    name="pickup"
                    value={pickup}
                    onChange={(v) => {
                      setGpsNotice('');
                      setPickup(v);
                      if (!String(v || '').trim()) setPickupCoords(null);
                    }}
                    onSelectSuggestion={(s) => {
                      if (s && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))) {
                        setPickupCoords({ lat: Number(s.lat), lng: Number(s.lng) });
                        skipGeocodeFromDragRef.current = true;
                      }
                    }}
                    placeholder={pickup.trim() || (live.hasFix ? 'Current location' : 'Enter pickup address')}
                    autoComplete="street-address"
                    ariaLabel="Pickup address"
                    inline
                  />
                </div>
                <button
                  type="button"
                  className="br-loc-gps"
                  onClick={useGps}
                  disabled={gpsLoading}
                  aria-busy={gpsLoading}
                >
                  <GpsIcon />
                  {gpsLoading ? 'Finding address…' : 'Use current location'}
                </button>
                {gpsNotice ? (
                  <p className="br-geo-notice" role="alert">
                    {gpsNotice}
                  </p>
                ) : null}
              </div>
              <span className="br-loc-row__chev" aria-hidden>
                <IconChevron />
              </span>
            </div>

            <div className="br-loc-row flow-field--addrSuggest">
              <span className="br-loc-row__dot br-loc-row__dot--drop" aria-hidden />
              <div className="br-loc-row__main">
                <span className="br-loc-row__label">Drop-off location</span>
                <div className="br-loc-row__input">
                  <AddressSuggestInput
                    id="flow-dropoff"
                    name="dropoff"
                    value={stops[0]?.value ?? ''}
                    onChange={(v) => {
                      setAt(0, v);
                      if (!String(v || '').trim()) setDropoffCoords(null);
                    }}
                    onSelectSuggestion={(s) => {
                      if (s && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))) {
                        setDropoffCoords({ lat: Number(s.lat), lng: Number(s.lng) });
                        skipGeocodeFromDragRef.current = true;
                      }
                    }}
                    placeholder="Enter drop-off location"
                    autoComplete="off"
                    ariaLabel="Drop-off address"
                    inline
                  />
                </div>
              </div>
              <span className="br-loc-row__chev" aria-hidden>
                <IconChevron />
              </span>
            </div>
          </div>
        </div>

        <section className="br-fare" aria-label="Route distance">
          <div className="br-fare__top">
            <span className="br-fare__lab">Estimated distance</span>
            <span className="br-fare__amt">{distanceLabel}</span>
          </div>
          <p className="br-delivery-hint">Fare and package options on the next step.</p>
        </section>
      </div>

      <div className="br-footer">
        <button type="submit" className="br-confirm">
          Continue
        </button>
      </div>
    </form>
  );
}
