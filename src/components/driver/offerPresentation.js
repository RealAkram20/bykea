/**
 * Presentation bits shared by every surface that shows a driver offer: the home
 * card and the full-screen offer. One copy, so the two cannot drift.
 */

/** Human label for an offer's `kind`. */
export function kindLabel(kind) {
  if (kind === 'parcel') return 'Delivery';
  if (kind === 'shop') return 'Shop delivery';
  if (kind === 'tuktuk') return 'Tuk-Tuk';
  return 'Taxi';
}

/** Tables where the driver may counter-offer instead of accepting at the customer's price. */
export const BID_TABLES = ['customer_delivery_orders', 'taxi_bookings', 'tuk_tuk_bookings'];

export function OfferPinPickup() {
  return (
    <svg className="offerPin" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d="M12 21s7-4.35 7-10a7 7 0 1 0-14 0c0 5.65 7 10 7 10Z"
        fill="rgba(var(--ingo-primary-rgb), 0.15)"
        stroke="var(--ingo-primary)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="2.2" fill="var(--ingo-primary)" />
    </svg>
  );
}

export function OfferPinDrop() {
  return (
    <svg className="offerPin" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d="M12 21s7-4.35 7-10a7 7 0 1 0-14 0c0 5.65 7 10 7 10Z"
        fill="var(--ingo-danger-soft)"
        stroke="var(--ingo-danger)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="2.2" fill="var(--ingo-danger)" />
    </svg>
  );
}
