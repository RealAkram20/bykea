import { bidFloor, isValidBidAmount, roundBidAmount } from './bookingBids';

/**
 * Regression for 2026-09-06: bids were snapped to 0.50 steps, so a driver's
 * Accept at the customer's $4.20 became $4.00 and was refused against the
 * $4.20 floor. Bids are money, and money is cents.
 */
describe('roundBidAmount', () => {
  it('keeps an amount that is not on a half-dollar', () => {
    expect(roundBidAmount(4.2)).toBe(4.2);
    expect(roundBidAmount(4.25)).toBe(4.25);
    expect(roundBidAmount(3.7)).toBe(3.7);
  });

  it('rounds to the cent without float noise', () => {
    expect(roundBidAmount(4.199999)).toBe(4.2);
    expect(roundBidAmount(1.005)).toBe(1.01);
    expect(roundBidAmount(0.1 + 0.2)).toBe(0.3);
  });

  it('never returns zero or NaN for a broken input', () => {
    expect(roundBidAmount('abc')).toBe(0.01);
    expect(roundBidAmount(-3)).toBe(0.01);
  });
});

describe('isValidBidAmount', () => {
  it('accepts a bid equal to the floor, which is what Accept at the customer price sends', () => {
    expect(isValidBidAmount(roundBidAmount(4.2), 4.2)).toBe(true);
    expect(isValidBidAmount(roundBidAmount(4.2), Math.max(4.2, 4.2))).toBe(true);
  });

  it('refuses a bid below the floor', () => {
    expect(isValidBidAmount(4.19, 4.2)).toBe(false);
    expect(isValidBidAmount(4.0, 4.2)).toBe(false);
  });
});

/**
 * Orders created before 2026-09-06 carry unrounded fare sums such as 4.31495
 * (base 1.5 + 3.147 km × 0.85 + 7 min × 0.02). The customer saw "$4.31", so a
 * driver typing 4.31 must be accepted and stored as 4.31, never as 4.31495.
 */
describe('bidFloor', () => {
  const subCentRow = { minimum_fare_amount: 4.31495, customer_offer_amount: 4.31495 };

  it('is the displayed cent value, not the raw sum', () => {
    expect(bidFloor(subCentRow)).toBe(4.31);
  });

  it('accepts a typed bid equal to what the screen showed, and stores cents', () => {
    const bid = roundBidAmount(4.31);
    expect(isValidBidAmount(bid, bidFloor(subCentRow))).toBe(true);
    expect(bid).toBe(4.31);
  });

  it('accepts Accept-at-the-customer-price when the offer itself is sub-cent', () => {
    expect(isValidBidAmount(roundBidAmount(4.31495), bidFloor(subCentRow))).toBe(true);
  });

  it('still refuses a bid one cent under the displayed floor', () => {
    expect(isValidBidAmount(roundBidAmount(4.3), bidFloor(subCentRow))).toBe(false);
  });

  it('uses the higher of minimum and current offer', () => {
    expect(bidFloor({ minimum_fare_amount: 4.2, customer_offer_amount: 4.7 })).toBe(4.7);
    expect(bidFloor({ minimum_fare_amount: 5, customer_offer_amount: 4.7 })).toBe(5);
  });
});
