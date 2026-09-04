import {
  _resetProximityCache,
  distanceKm,
  formatDistanceKm,
  geocodePickupCached,
  normalizeAddress,
  pointFromGeocode,
  sortOffersByDistance,
} from './offerProximity';

const KAMPALA = { lat: 0.3476, lng: 32.5825 };
const ENTEBBE = { lat: 0.0512, lng: 32.4637 };

beforeEach(() => {
  _resetProximityCache();
});

test('normalizeAddress drops the shop suffix and case', () => {
  expect(normalizeAddress('  Harare CBD,  Harare (Bon Marché) ')).toBe('harare cbd, harare');
  expect(normalizeAddress(null)).toBe('');
});

test('pointFromGeocode accepts the helper shapes and rejects 0,0', () => {
  expect(pointFromGeocode({ lat: 1, lng: 2 })).toEqual({ lat: 1, lng: 2 });
  expect(pointFromGeocode({ geometry: { location: { lat: 1, lng: 2 } } })).toEqual({ lat: 1, lng: 2 });
  expect(pointFromGeocode({ lat: 0, lng: 0 })).toBeNull();
  expect(pointFromGeocode(null)).toBeNull();
});

test('geocodePickupCached calls the geocoder once per address and caches the hit', async () => {
  const geocoder = jest.fn(async () => ({ lat: 0.3, lng: 32.6 }));
  const a = await geocodePickupCached('Kampala Road, Kampala', geocoder);
  const b = await geocodePickupCached('kampala road,   KAMPALA', geocoder);
  expect(a).toEqual({ lat: 0.3, lng: 32.6 });
  expect(b).toEqual(a);
  expect(geocoder).toHaveBeenCalledTimes(1);
});

test('a failed geocode is cached as a miss and not retried immediately', async () => {
  const geocoder = jest.fn(async () => {
    throw new Error('offline');
  });
  expect(await geocodePickupCached('Nowhere', geocoder)).toBeNull();
  expect(await geocodePickupCached('Nowhere', geocoder)).toBeNull();
  expect(geocoder).toHaveBeenCalledTimes(1);
});

test('a dash or empty address never reaches the geocoder', async () => {
  const geocoder = jest.fn(async () => ({ lat: 1, lng: 1 }));
  expect(await geocodePickupCached('—', geocoder)).toBeNull();
  expect(await geocodePickupCached('', geocoder)).toBeNull();
  expect(geocoder).not.toHaveBeenCalled();
});

test('distanceKm is null without a usable point and ~35 km Kampala→Entebbe', () => {
  expect(distanceKm(null, KAMPALA)).toBeNull();
  expect(distanceKm(KAMPALA, { lat: 0, lng: 0 })).toBeNull();
  const km = distanceKm(KAMPALA, ENTEBBE);
  expect(km).toBeGreaterThan(33);
  expect(km).toBeLessThan(37);
});

test('formatDistanceKm never shows an unknown as a number', () => {
  expect(formatDistanceKm(null)).toBe('');
  expect(formatDistanceKm(NaN)).toBe('');
  expect(formatDistanceKm(0.02)).toBe('50 m');
  expect(formatDistanceKm(0.84)).toBe('850 m');
  expect(formatDistanceKm(1.23)).toBe('1.2 km');
  expect(formatDistanceKm(12.6)).toBe('13 km');
});

test('sortOffersByDistance puts nearest first and unknowns last in their original order', () => {
  const offers = [
    { table: 't', id: 'far' },
    { table: 't', id: 'unknown1' },
    { table: 't', id: 'near' },
    { table: 't', id: 'unknown2' },
  ];
  const d = new Map([
    ['t:far', 9],
    ['t:near', 1],
    ['t:unknown1', null],
  ]);
  expect(sortOffersByDistance(offers, d).map((o) => o.id)).toEqual(['near', 'far', 'unknown1', 'unknown2']);
});
