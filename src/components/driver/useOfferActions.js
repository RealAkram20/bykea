import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverOffers } from './DriverOffersProvider';
import { jobPath } from './useDriverJob';
import {
  driverAcceptOffer,
  driverRejectOffer,
  fetchRecentForDriver,
  offerToActiveDeliveryOrder,
  ORDER_ALREADY_ACCEPTED_MSG,
} from '../../lib/driverIncomingBookings';
import { driverPlaceBid } from '../../lib/bookingBids';
import { formatGBP } from '../../lib/currency';
import { supabase } from '../../lib/supabaseClient';
import { BID_TABLES } from './offerPresentation';

const offerKey = (o) => `${o.table}:${o.id}`;

/**
 * Accept / decline / counter-offer for a driver offer, with the busy and
 * message state a surface needs to render them.
 *
 * Extracted from DriverHomePage on 2026-09-03 so the home card and the
 * full-screen offer run the same code. The notification buttons run the same
 * `driverAcceptOffer` / `driverRejectOffer` from the provider. One accept path.
 *
 * Each action resolves to the underlying result (`{ ok, ... }`) so a caller can
 * navigate on success; the message and busy state are already set by then.
 */
export function useOfferActions() {
  const navigate = useNavigate();
  const { driverId, driverVehicleType, removeOfferLocally, refreshOffers, setRecent, setTakenNotice } =
    useDriverOffers();

  const [actionMsg, setActionMsg] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [bidModeKey, setBidModeKey] = useState('');
  const [bidDraft, setBidDraft] = useState('');
  const [myBids, setMyBids] = useState({});
  const acceptingRef = useRef(false);

  const accept = useCallback(
    async (offer) => {
      if (!supabase || !driverId) return { ok: false, error: 'No driver session.' };
      const k = offerKey(offer);
      if (acceptingRef.current || busyKey) return { ok: false, error: 'Busy.' };
      acceptingRef.current = true;
      setBusyKey(k);
      setActionMsg('');
      console.info(`[offer] accept ${k}`);
      const res = await driverAcceptOffer(supabase, offer, driverId, driverVehicleType);
      console.info(`[offer] accept result ${JSON.stringify(res)}`);
      setBusyKey('');
      acceptingRef.current = false;
      if (!res.ok) {
        if (/already accepted/i.test(String(res.error || ''))) {
          removeOfferLocally(offer.table, offer.id);
          setTakenNotice?.(res.error || ORDER_ALREADY_ACCEPTED_MSG);
          void refreshOffers();
          return res;
        }
        setActionMsg(res.error || 'Could not send offer.');
        return res;
      }

      // Parcel / taxi / tuk: offer stays pending until the customer chooses this driver.
      if (res.pending) {
        const fare = Number(res.fare);
        if (Number.isFinite(fare) && fare > 0) {
          setMyBids((prev) => ({ ...prev, [k]: fare }));
        }
        setActionMsg(
          `Offer of ${formatGBP(Number.isFinite(fare) && fare > 0 ? fare : offer.amount)} sent — waiting for the customer to choose you (more than one driver may have offered).`,
        );
        void refreshOffers();
        return res;
      }

      // Shop (and any legacy instant-claim path): go straight to active delivery.
      removeOfferLocally(offer.table, offer.id);
      const rec = await fetchRecentForDriver(supabase, driverId);
      setRecent(rec);
      const job = offerToActiveDeliveryOrder(offer);
      navigate(jobPath('active-delivery', job), { state: { order: job } });
      return res;
    },
    [busyKey, driverId, driverVehicleType, navigate, refreshOffers, removeOfferLocally, setRecent, setTakenNotice],
  );

  const reject = useCallback(
    async (offer) => {
      if (!supabase || !driverId) return { ok: false, error: 'No driver session.' };
      const k = offerKey(offer);
      setBusyKey(k);
      setActionMsg('');
      console.info(`[offer] decline ${k}`);
      const res = await driverRejectOffer(supabase, offer, driverId);
      console.info(`[offer] decline result ${JSON.stringify(res)}`);
      setBusyKey('');
      if (!res.ok) {
        setActionMsg(res.error || 'Could not save rejection.');
        return res;
      }
      removeOfferLocally(offer.table, offer.id);
      return res;
    },
    [driverId, removeOfferLocally],
  );

  const bid = useCallback(
    async (offer) => {
      if (!supabase || !driverId) return { ok: false, error: 'No driver session.' };
      const k = offerKey(offer);
      const amount = Number(bidDraft);
      if (!Number.isFinite(amount) || amount <= 0) {
        setActionMsg('Enter a valid bid amount.');
        return { ok: false, error: 'Invalid amount.' };
      }
      setBusyKey(k);
      setActionMsg('');
      const table = offer.table;
      if (!BID_TABLES.includes(table)) {
        setBusyKey('');
        setActionMsg('Bidding is not available for this job type.');
        return { ok: false, error: 'Bidding unavailable.' };
      }
      const res = await driverPlaceBid(supabase, table, offer.id, driverId, amount);
      setBusyKey('');
      if (!res.ok) {
        if (/already accepted/i.test(String(res.error || ''))) {
          removeOfferLocally(offer.table, offer.id);
          setTakenNotice?.(res.error || ORDER_ALREADY_ACCEPTED_MSG);
          return res;
        }
        setActionMsg(res.error || 'Could not place bid.');
        return res;
      }
      if (res.claimed) {
        removeOfferLocally(offer.table, offer.id);
        const rec = await fetchRecentForDriver(supabase, driverId);
        setRecent(rec);
        const job = offerToActiveDeliveryOrder(offer);
        navigate(jobPath('active-delivery', job), { state: { order: job } });
        return res;
      }
      setBidModeKey('');
      setBidDraft('');
      setMyBids((prev) => ({ ...prev, [k]: res.amount }));
      setActionMsg(`Bid of ${formatGBP(res.amount)} sent — waiting for the customer to choose you.`);
      void refreshOffers();
      return res;
    },
    [driverId, bidDraft, navigate, refreshOffers, removeOfferLocally, setRecent, setTakenNotice],
  );

  return {
    accept,
    reject,
    bid,
    actionMsg,
    setActionMsg,
    busyKey,
    bidModeKey,
    setBidModeKey,
    bidDraft,
    setBidDraft,
    myBids,
  };
}
