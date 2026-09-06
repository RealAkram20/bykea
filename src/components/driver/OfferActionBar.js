import { formatGBP } from '../../lib/currency';
import './offerActionBar.css';

/**
 * The one set of answers to an offer: Decline, Bid higher, Accept — plus the
 * counter-offer form when the driver opens it.
 *
 * Rendered by both the Home card and the full-screen offer, so the two can
 * never drift apart again: on 2026-09-06 the screen had lost "Bid higher" (it
 * kept a text link) while the card said "Offer / Bid higher / Reject" — two
 * vocabularies for one decision. One component, one vocabulary.
 *
 * Money shown here is the offer's own figure; nothing is computed on this
 * surface except the suggested counter-offer, which starts one step above the
 * current floor and is only a prefill the driver can change.
 */
export default function OfferActionBar({
  offer,
  canBid,
  busy,
  disabled,
  myBid,
  bidOpen,
  bidDraft,
  onBidDraftChange,
  onOpenBid,
  onCloseBid,
  onSendBid,
  onAccept,
  onDecline,
  inputId,
}) {
  const floor = Math.max(Number(offer.minimumAmount) || 0, Number(offer.amount) || 0);
  const hasBid = myBid != null;
  const off = Boolean(busy || disabled);
  const id = inputId || `bid-${offer.table}-${offer.id}`;

  return (
    <div className="ofa">
      {canBid && bidOpen ? (
        <div className="ofa__bid" role="group" aria-label="Counter-offer">
          <label className="ofa__bidLbl" htmlFor={id}>
            Your counter-offer (minimum {formatGBP(floor)})
          </label>
          <div className="ofa__bidRow">
            <input
              id={id}
              type="number"
              inputMode="decimal"
              step="0.1"
              min={floor}
              className="ofa__bidInput"
              value={bidDraft}
              onChange={(e) => onBidDraftChange(e.target.value)}
            />
            <button type="button" className="ofa__btn ofa__btn--send" disabled={off} onClick={onSendBid}>
              {busy ? 'Sending…' : 'Send bid'}
            </button>
            <button type="button" className="ofa__btn ofa__btn--ghost" disabled={busy} onClick={onCloseBid}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className={`ofa__row${canBid ? ' ofa__row--three' : ''}`} role="group" aria-label="Answer this offer">
        <button type="button" className="ofa__btn ofa__btn--decline" disabled={off} onClick={onDecline}>
          {busy ? '…' : 'Decline'}
        </button>
        {canBid ? (
          <button
            type="button"
            className="ofa__btn ofa__btn--bid"
            disabled={off || bidOpen}
            aria-expanded={bidOpen}
            onClick={onOpenBid}
          >
            {hasBid ? 'Raise bid' : 'Bid higher'}
          </button>
        ) : null}
        <button type="button" className="ofa__btn ofa__btn--accept" disabled={off} onClick={onAccept}>
          {busy ? '…' : `Accept ${formatGBP(offer.amount)}`}
        </button>
      </div>

      {canBid ? (
        <p className="ofa__note">
          {hasBid
            ? `Your offer of ${formatGBP(myBid)} is with the customer. Accept sends it again at their price.`
            : "Accept sends your offer at the customer's price. The customer confirms the driver."}
        </p>
      ) : null}
    </div>
  );
}
