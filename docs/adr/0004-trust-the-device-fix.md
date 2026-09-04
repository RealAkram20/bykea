# ADR 0004 — Trust the device's fix; proximity computed at use

Date: 2026-09-03. Status: accepted.

## Context

`googleMapsConfig` rejected every GPS fix outside a Zimbabwe bounding box and
fell back to Harare. The box was meant to discard wrong-continent network
fixes. Its effect on a driver outside Zimbabwe was total: no fix accepted, map
pinned to Harare, and the driver published online with no coordinates, so
nothing about proximity could ever work. Separately, no booking table stores
pickup coordinates; the sender rang every fresh online driver regardless of
distance, and its radius filter was dead code waiting for columns that do not
exist.

## Decision

1. **Any reliable device fix is trusted** (`isAcceptableDeviceFix` =
   `isReliableGpsLatLng`). Harare (`DEFAULT_MAP_FALLBACK`) is used only when
   there is no fix. The box stays exported for callers that need it.
2. **The country bias for address search and geocoding is per environment**
   (`REACT_APP_ADDRESS_COUNTRY`, default `zw`). It is the only country
   assumption left in the app.
3. **Proximity is computed at use, not stored.** The driver app geocodes the
   pickup address through the existing geocoder (edge function → Google →
   OpenStreetMap fallback), caches the point per address, and measures it
   against the driver's live fix. The sender does the same at ring time when it
   has a Google key, then applies its existing 20 km radius. No migration.
4. **No number is invented.** Without a fix or a located pickup the screen
   says so; without a key or a located pickup the sender rings everyone and
   reports why in its response.
5. **Location publishing lives in `DriverOffersProvider`**, under every driver
   route, not in the Home page whose unmount published the driver offline.

## Consequences

- A store build needs `REACT_APP_ADDRESS_COUNTRY` set for its market and
  `GOOGLE_MAPS_API_KEY` as a secret on `driver-offer-push` for the radius
  filter to engage. Without the secret the sender behaves as before.
- Geocoding at use costs one lookup per new pickup address per device; the
  cache keeps repeats free. Nominatim is a fallback with a usage policy, not a
  primary provider.
- Rejecting wrong-continent network fixes is no longer done by geography. If
  that failure returns, gate on reported accuracy rather than on a box.
