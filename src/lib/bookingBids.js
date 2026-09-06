import { isBookingTakenError, ORDER_ALREADY_ACCEPTED_MSG } from './claimOpenBooking';
import { notifyDriversOfOfferStop } from './driverOfferPushNotify';
import { countBookingDriversSeen, shouldAutoAssignSoloDriverOffer } from './driverSearchWait';

/** @typedef {'customer_delivery_orders' | 'taxi_bookings' | 'tuk_tuk_bookings'} BidBookingTable */

/** @typedef {'customer' | 'driver'} BidderRole */

/**
 * @typedef {object} BookingBidRow
 * @property {string} id
 * @property {string} booking_table
 * @property {string} booking_id
 * @property {BidderRole} bidder_role
 * @property {string} bidder_id
 * @property {number} amount
 * @property {'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'expired'} status
 * @property {string} created_at
 */

export const BID_BOOKING_TABLES = new Set([
  'customer_delivery_orders',
  'taxi_bookings',
  'tuk_tuk_bookings',
]);

export { ORDER_ALREADY_ACCEPTED_MSG };

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function getMinimumFare(row) {
  const min = Number(row?.minimum_fare_amount);
  if (Number.isFinite(min) && min > 0) return min;
  const total = Number(row?.total_amount ?? row?.quoted_price);
  if (Number.isFinite(total) && total > 0) return total;
  return 0;
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function getCustomerOfferAmount(row) {
  const offer = Number(row?.customer_offer_amount);
  if (Number.isFinite(offer) && offer > 0) return offer;
  return getMinimumFare(row);
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function getAgreedFare(row) {
  const agreed = Number(row?.agreed_fare_amount);
  if (Number.isFinite(agreed) && agreed > 0) return agreed;
  return null;
}

/**
 * @param {number} amount
 * @param {number} minimum
 */
export function isValidBidAmount(amount, minimum) {
  const a = Number(amount);
  const m = Number(minimum);
  if (!Number.isFinite(a) || a <= 0) return false;
  if (!Number.isFinite(m) || m <= 0) return a > 0;
  return a >= m - 0.001;
}

/**
 * Money to the cent. This used to snap to 0.50 steps, which turned a driver's
 * Accept at the customer's $4.20 into $4.00 and then refused it against its own
 * $4.20 floor ("Bid must be at least 4.20", seen on a phone 2026-09-06). Any
 * amount not on a half-dollar failed the same way.
 *
 * The fare columns are plain `numeric` and `numeric(12,4)`, so the database
 * keeps whatever it is given; nothing rounds for us. Every amount this module
 * writes goes through here first, and the floor it compares against is rounded
 * the same way (`bidFloor`), so a bid and its floor are always two cent values
 * and "at least the floor" means what the screen shows.
 * @param {number} amount
 * @param {number} [step=0.01]
 */
export function roundBidAmount(amount, step = 0.01) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return step;
  // Integer arithmetic on cents avoids 4.2 / 0.01 = 420.00000000000006, and the
  // epsilon keeps 1.005 from landing on 100.49999999999999 and rounding down.
  const factor = Math.round(1 / step);
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

/**
 * The floor a bid must meet, in cents. Orders created before 2026-09-06 carry
 * unrounded sums such as 4.31495 in `minimum_fare_amount`; the customer sees
 * "$4.31" and so must the rule. Rounding to the nearest cent matches the
 * display; it never rounds a floor of exactly x.xx5 up past what was shown.
 * @param {Record<string, unknown> | null | undefined} row
 */
export function bidFloor(row) {
  return roundBidAmount(Math.max(getMinimumFare(row), getCustomerOfferAmount(row)));
}

/**
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {string} table
 * @param {string} bookingId
 */
async function fetchBookingRow(supabase, table, bookingId) {
  const { data, error } = await supabase.from(table).select('*').eq('id', bookingId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Assign the open booking to this driver at `fare`. First writer wins.
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {BidBookingTable} table
 * @param {string} bookingId
 * @param {string} driverId
 * @param {number} fare
 */
async function claimBookingForDriver(supabase, table, bookingId, driverId, fare) {
  const assignedAt = new Date().toISOString();
  const patch = {
    assigned_driver_id: driverId,
    assigned_at: assignedAt,
    agreed_fare_amount: fare,
    customer_offer_amount: fare,
    bid_status: 'matched',
  };

  const takenFail = (error) => {
    if (error && isBookingTakenError(error)) {
      return { ok: false, taken: true, error: ORDER_ALREADY_ACCEPTED_MSG };
    }
    if (error) return { ok: false, error: error.message };
    return { ok: false, taken: true, error: ORDER_ALREADY_ACCEPTED_MSG };
  };

  if (table === 'customer_delivery_orders') {
    patch.status = 'assigned';
    patch.total_amount = fare;
    const { data, error } = await supabase
      .from('customer_delivery_orders')
      .update(patch)
      .eq('id', bookingId)
      .is('assigned_driver_id', null)
      .in('status', ['placed', 'paid'])
      .select('id, assigned_driver_id')
      .maybeSingle();
    if (error || !data?.id || String(data.assigned_driver_id) !== String(driverId)) return takenFail(error);
  } else if (table === 'taxi_bookings') {
    patch.status = 'confirmed';
    patch.quoted_price = fare;
    const { data, error } = await supabase
      .from('taxi_bookings')
      .update(patch)
      .eq('id', bookingId)
      .is('assigned_driver_id', null)
      .eq('status', 'requested')
      .select('id, assigned_driver_id')
      .maybeSingle();
    if (error || !data?.id || String(data.assigned_driver_id) !== String(driverId)) return takenFail(error);
  } else if (table === 'tuk_tuk_bookings') {
    patch.status = 'confirmed';
    patch.quoted_price = fare;
    const { data, error } = await supabase
      .from('tuk_tuk_bookings')
      .update(patch)
      .eq('id', bookingId)
      .is('assigned_driver_id', null)
      .eq('status', 'requested')
      .select('id, assigned_driver_id')
      .maybeSingle();
    if (error || !data?.id || String(data.assigned_driver_id) !== String(driverId)) return takenFail(error);
  } else {
    return { ok: false, error: 'Unsupported booking type.' };
  }

  return { ok: true, fare, driverId };
}

async function markBidAcceptedAndStopRings(supabase, table, bookingId, bidId) {
  if (bidId) {
    await supabase.from('booking_bids').update({ status: 'accepted' }).eq('id', bidId);
  }
  await withdrawPendingBids(supabase, table, bookingId, bidId);
  try {
    notifyDriversOfOfferStop(table, bookingId);
  } catch {
    /* ignore */
  }
}

/**
 * Instantly assign when this driver is the only one who has seen the request.
 * @returns {Promise<{ ok: true, claimed: true, fare: number, driverId: string, bidId?: string } | { ok: false, taken?: boolean, error?: string } | null>}
 *   `null` means more than one driver has seen it — caller should leave a pending bid.
 */
async function tryClaimIfOnlyDriverSeen(supabase, table, bookingId, driverId, fare, existingBidId) {
  const fresh = await fetchBookingRow(supabase, table, bookingId);
  if (!fresh) return { ok: false, error: 'Booking not found.' };
  if (fresh.assigned_driver_id) {
    if (String(fresh.assigned_driver_id) === String(driverId)) {
      return { ok: true, claimed: true, fare: getCustomerOfferAmount(fresh), driverId, already: true };
    }
    return { ok: false, taken: true, error: ORDER_ALREADY_ACCEPTED_MSG };
  }
  if (!shouldAutoAssignSoloDriverOffer(countBookingDriversSeen(fresh))) return null;

  const claimed = await claimBookingForDriver(supabase, table, bookingId, driverId, fare);
  if (!claimed.ok) return claimed;

  let bidId = existingBidId || null;
  if (bidId) {
    await supabase.from('booking_bids').update({ amount: fare, status: 'accepted' }).eq('id', bidId);
  } else {
    const { data: bidRow } = await supabase
      .from('booking_bids')
      .insert({
        booking_table: table,
        booking_id: bookingId,
        bidder_role: 'driver',
        bidder_id: driverId,
        amount: fare,
        status: 'accepted',
      })
      .select('id')
      .maybeSingle();
    bidId = bidRow?.id || null;
  }
  await markBidAcceptedAndStopRings(supabase, table, bookingId, bidId);
  return { ok: true, claimed: true, fare, driverId, bidId };
}

async function withdrawPendingBids(supabase, table, bookingId, exceptBidId) {
  let q = supabase
    .from('booking_bids')
    .update({ status: 'withdrawn' })
    .eq('booking_table', table)
    .eq('booking_id', bookingId)
    .eq('status', 'pending');
  if (exceptBidId) q = q.neq('id', exceptBidId);
  const { error } = await q;
  if (error && !/booking_bids|relation/i.test(error.message || '')) {
    console.warn('[bookingBids] withdraw pending', error.message);
  }
}

/**
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {BidBookingTable} table
 * @param {string} bookingId
 * @returns {Promise<BookingBidRow[]>}
 */
export async function fetchPendingDriverBids(supabase, table, bookingId) {
  const { data, error } = await supabase
    .from('booking_bids')
    .select('*')
    .eq('booking_table', table)
    .eq('booking_id', bookingId)
    .eq('bidder_role', 'driver')
    .eq('status', 'pending')
    .order('amount', { ascending: true });
  if (error) {
    if (/booking_bids|relation/i.test(error.message || '')) return [];
    throw new Error(error.message);
  }
  return Array.isArray(data) ? data : [];
}

/**
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {BidBookingTable} table
 * @param {string} bookingId
 * @param {string} driverId
 * @param {number} amount
 */
export async function driverPlaceBid(supabase, table, bookingId, driverId, amount) {
  if (!supabase || !table || !bookingId || !driverId) return { ok: false, error: 'Missing data.' };
  if (!BID_BOOKING_TABLES.has(table)) return { ok: false, error: 'Bidding not supported for this job.' };

  const row = await fetchBookingRow(supabase, table, bookingId);
  if (!row) return { ok: false, error: 'Booking not found.' };
  if (row.assigned_driver_id) return { ok: false, taken: true, error: ORDER_ALREADY_ACCEPTED_MSG };

  const floor = bidFloor(row);
  const bid = roundBidAmount(amount);
  if (!isValidBidAmount(bid, floor)) {
    return { ok: false, error: `Bid must be at least ${floor.toFixed(2)}.` };
  }

  const { data: existingRows, error: exErr } = await supabase
    .from('booking_bids')
    .select('id')
    .eq('booking_table', table)
    .eq('booking_id', bookingId)
    .eq('bidder_role', 'driver')
    .eq('bidder_id', driverId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (exErr && !/booking_bids|relation/i.test(exErr.message || '')) {
    return { ok: false, error: exErr.message };
  }
  const existing = Array.isArray(existingRows) ? existingRows[0] : existingRows;

  const solo = await tryClaimIfOnlyDriverSeen(supabase, table, bookingId, driverId, bid, existing?.id);
  if (solo) {
    if (!solo.ok) return { ok: false, taken: solo.taken, error: solo.error };
    return { ok: true, claimed: true, bidId: solo.bidId, amount: bid };
  }

  if (existing?.id) {
    const { error: uErr } = await supabase
      .from('booking_bids')
      .update({ amount: bid })
      .eq('id', existing.id);
    if (uErr) return { ok: false, error: uErr.message };
    return { ok: true, bidId: existing.id, amount: bid, updated: true };
  }

  const { data: bidRow, error } = await supabase
    .from('booking_bids')
    .insert({
      booking_table: table,
      booking_id: bookingId,
      bidder_role: 'driver',
      bidder_id: driverId,
      amount: bid,
      status: 'pending',
    })
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };

  return { ok: true, bidId: bidRow?.id, amount: bid };
}

/**
 * Driver offers at the customer's listed fare.
 * If they are the only driver who has seen the request, the job is assigned immediately.
 * If more than one driver has seen it, the offer stays pending until the customer chooses.
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {BidBookingTable} table
 * @param {string} bookingId
 * @param {string} driverId
 */
export async function driverAcceptCustomerOffer(supabase, table, bookingId, driverId) {
  if (!supabase || !table || !bookingId || !driverId) return { ok: false, error: 'Missing data.' };
  if (!BID_BOOKING_TABLES.has(table)) return { ok: false, error: 'Unsupported booking type.' };

  const row = await fetchBookingRow(supabase, table, bookingId);
  if (!row) return { ok: false, error: 'Booking not found.' };
  if (row.assigned_driver_id) {
    if (String(row.assigned_driver_id) === String(driverId)) {
      return { ok: true, already: true, fare: getCustomerOfferAmount(row) };
    }
    return { ok: false, taken: true, error: ORDER_ALREADY_ACCEPTED_MSG };
  }

  const fare = getCustomerOfferAmount(row);
  if (!Number.isFinite(fare) || fare <= 0) {
    return { ok: false, error: 'This booking has no listed fare yet.' };
  }

  const placed = await driverPlaceBid(supabase, table, bookingId, driverId, fare);
  if (!placed.ok) {
    return {
      ok: false,
      taken: placed.taken,
      error: placed.error || 'Could not send your offer.',
    };
  }

  if (placed.claimed) {
    return { ok: true, pending: false, fare: placed.amount, bidId: placed.bidId };
  }

  return { ok: true, pending: true, fare: placed.amount, bidId: placed.bidId };
}

/**
 * Customer accepts a driver's pending counter-bid.
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {string} bidId
 * @param {string} appUserId
 */
export async function customerAcceptDriverBid(supabase, bidId, appUserId) {
  if (!supabase || !bidId || !appUserId) return { ok: false, error: 'Missing data.' };

  const { data: bid, error: bErr } = await supabase
    .from('booking_bids')
    .select('*')
    .eq('id', bidId)
    .eq('status', 'pending')
    .eq('bidder_role', 'driver')
    .maybeSingle();
  if (bErr) return { ok: false, error: bErr.message };
  if (!bid) return { ok: false, error: 'This bid is no longer available.' };

  const table = String(bid.booking_table || '');
  const bookingId = String(bid.booking_id || '');
  if (!BID_BOOKING_TABLES.has(table)) return { ok: false, error: 'Invalid booking.' };

  const row = await fetchBookingRow(supabase, table, bookingId);
  if (!row) return { ok: false, error: 'Booking not found.' };
  if (String(row.app_user_id || '') !== String(appUserId)) {
    return { ok: false, error: 'You can only accept bids on your own booking.' };
  }
  if (row.assigned_driver_id) return { ok: false, taken: true, error: ORDER_ALREADY_ACCEPTED_MSG };

  const fare = Number(bid.amount);
  const driverId = String(bid.bidder_id);
  const claimed = await claimBookingForDriver(supabase, table, bookingId, driverId, fare);
  if (!claimed.ok) return claimed;

  await markBidAcceptedAndStopRings(supabase, table, bookingId, bidId);

  return { ok: true, fare, driverId };
}

/**
 * Customer raises their offer (must be >= current offer and >= minimum).
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {BidBookingTable} table
 * @param {string} bookingId
 * @param {string} appUserId
 * @param {number} amount
 */
export async function customerRaiseOffer(supabase, table, bookingId, appUserId, amount) {
  if (!supabase || !table || !bookingId || !appUserId) return { ok: false, error: 'Missing data.' };

  const row = await fetchBookingRow(supabase, table, bookingId);
  if (!row) return { ok: false, error: 'Booking not found.' };
  if (String(row.app_user_id || '') !== String(appUserId)) {
    return { ok: false, error: 'You can only update your own booking.' };
  }
  if (row.assigned_driver_id) return { ok: false, error: 'A driver is already assigned.' };

  const floor = bidFloor(row);
  const bid = roundBidAmount(amount);
  if (!isValidBidAmount(bid, floor)) {
    return { ok: false, error: `Offer must be at least ${floor.toFixed(2)}.` };
  }

  const patch = { customer_offer_amount: bid, bid_status: 'open' };
  if (table === 'customer_delivery_orders') patch.total_amount = bid;
  else patch.quoted_price = bid;

  const { error: uErr } = await supabase.from(table).update(patch).eq('id', bookingId);
  if (uErr) return { ok: false, error: uErr.message };

  const { error: iErr } = await supabase.from('booking_bids').insert({
    booking_table: table,
    booking_id: bookingId,
    bidder_role: 'customer',
    bidder_id: appUserId,
    amount: bid,
    status: 'accepted',
  });
  if (iErr && !/booking_bids|relation/i.test(iErr.message || '')) {
    console.warn('[bookingBids] customer raise log', iErr.message);
  }

  return { ok: true, amount: bid };
}

/**
 * @param {import('./supabaseClient').SupabaseClient} supabase
 * @param {string} table
 * @param {string} bookingId
 * @returns {Promise<Array<BookingBidRow & {
 *   driver_name?: string,
 *   vehicle_type?: string,
 *   vehicle_plate?: string,
 *   vehicle_label?: string,
 * }>>}
 */
export async function fetchPendingDriverBidsWithNames(supabase, table, bookingId) {
  const bids = await fetchPendingDriverBids(supabase, table, bookingId);
  if (!bids.length) return [];

  const driverIds = [...new Set(bids.map((b) => b.bidder_id).filter(Boolean))];
  const { data: drivers } = await supabase
    .from('driver_registrations')
    .select('id, full_name, vehicle_type, vehicle_make, vehicle_model, vehicle_plate')
    .in('id', driverIds);

  /** @type {Record<string, { name: string, vehicle_type: string, vehicle_plate: string, vehicle_label: string }>} */
  const byId = {};
  for (const d of drivers || []) {
    const makeModel = [d.vehicle_make, d.vehicle_model].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
    const vType = String(d.vehicle_type || '').trim();
    const plate = String(d.vehicle_plate || '').trim();
    byId[d.id] = {
      name: d.full_name || 'Driver',
      vehicle_type: vType,
      vehicle_plate: plate,
      vehicle_label: [vType || makeModel, plate].filter(Boolean).join(' · '),
    };
  }

  return bids.map((b) => {
    const info = byId[b.bidder_id] || {
      name: 'Driver',
      vehicle_type: '',
      vehicle_plate: '',
      vehicle_label: '',
    };
    return {
      ...b,
      driver_name: info.name,
      vehicle_type: info.vehicle_type,
      vehicle_plate: info.vehicle_plate,
      vehicle_label: info.vehicle_label,
    };
  });
}
