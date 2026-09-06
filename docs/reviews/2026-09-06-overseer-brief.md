# Overseer brief — review the 2026-09-05/06 session's work

You are reviewing another agent's work in this repository (`d:\xampp\htdocs\ingo app`,
a React + Capacitor app for a live ride-hailing and delivery product). Your job
is to find what is wrong, unverified, or overstated. Praise is not useful;
findings are. Read `AGENTS.md` first, then `docs/system-map.md`, then the
2026-09-05 and 2026-09-06 entries at the end of `docs/worklog.md`, which are the
agent's own account of what it built and what it did **not** verify.

## What the session claims to have done

Release plumbing
- `android/app/build.gradle`: release `signingConfig` from a gitignored
  `android/keystore.properties`; `applicationId` switched to `com.world.fi.ingo`
  (the Play listing) while the Java package stays `com.kigatta.ingo`; version 1.1.0 / code 2.
- Launcher icon and splash regenerated from the brand logo (`assets/`, `android/app/src/main/res/`).
- `docs/release-android.md`, `docs/deployment.md`, `docs/system-map.md` written.
- Website deployed to Firebase Hosting from `build/` (see worklog 01:45).

Location and permissions (ADR 0005, `docs/adr/0005-native-location-and-permissions-screen.md`)
- `@capacitor/geolocation` added; `src/lib/nativePermissions.js` (new);
  `src/lib/devicePickupLocation.js` and `src/hooks/useLiveLocation.js` gained a
  native branch; `useLiveLocation` now exposes `permission`, `needsPermission`, `located`.
- `android/app/src/main/java/com/kigatta/ingo/IngoPermissionsPlugin.java` (new):
  reads location/notification/channel/full-screen/battery state, opens settings
  screens, posts a sample offer through `OfferMessagingService.postOffer`.
- `src/components/driver/DriverPermissionsPanel.js` (+css) on the driver Profile;
  `src/components/driver/DriverPermissionPrompts.js` rewritten.
- `src/components/driver/DriverApprovalGate.js`: trusts a database "yes" for 5 minutes.
- `src/components/driver/DriverOffersProvider.js`: publishes only `located` positions;
  ignores the sample offer's tap.

Bugs from a phone screenshot
- `src/lib/bookingBids.js`: bids rounded to cents, not 0.50 steps; equal-to-floor accepted. Test: `src/lib/bookingBids.test.js`.
- `src/pages/PriceEstimatePage.js`, `OrderConfirmationPage.js`, `RequestDeliveryPage.js`:
  no placeholder addresses; unknown distance is said out loud instead of silently priced.
- `src/lib/offerProximity.js`: distances above 500 km are reported unknown.

Offer surfaces
- `src/components/driver/OfferActionBar.js` (+css): one Decline / Bid higher / Accept
  bar rendered by both `DriverHomePage` (card) and `DriverOfferPage`; their old
  action markup and CSS removed (`driverPortal.css`, `driverOfferPage.css`).

## What to check, in order

1. **Build and tests.** `npm run build` must compile; report every ESLint warning
   in the files above. `CI=true npx react-scripts test --watchAll=false --testPathPattern "bookingBids|offerProximity"` must pass.
   Then `cd android && ./gradlew assembleRelease` (needs `android/app/google-services.json`;
   if absent, say so rather than working around it).
2. **The worklog's "Verified / Not verified" lines are honest.** For each claim of
   verification, find the evidence in the worklog (a log line, a database row, a
   screenshot name). For each "not verified", confirm the code path really is untested.
3. **Screen standard** (`~/.claude/skills/screen/SKILL.md` if you have it; otherwise:
   tokens not raw hex, no duplicated UI, no invented values, WCAG AA, labels on inputs,
   loading/empty/error states). Apply it to `OfferActionBar`, `DriverPermissionsPanel`,
   `DriverPermissionPrompts`, and the `PriceEstimatePage` notice.
4. **Money.** Read `roundBidAmount`, `snapToFloor`, `isValidBidAmount`, `driverPlaceBid`,
   `customerRaiseOffer` and every caller of `roundBidAmount`. Can any path now accept a
   bid *below* the floor, or store a non-cent amount? Is `numeric(12,2)` respected?
5. **Security implications of the approval gate cache.** A driver whose approval is
   revoked stays in for up to 5 minutes. Is that acceptable for this product? Is the
   module-scope cache cleared on sign-out (`clearDriverSession`)? If not, a second
   driver signing in on the same phone within 5 minutes inherits nothing — confirm.
6. **The native plugin.** API-level guards (`canUseFullScreenIntent` is API 34+,
   `ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT` is API 34+); every `startActivity` has
   `FLAG_ACTIVITY_NEW_TASK`; nothing here requests a permission itself; the test
   offer cannot be mistaken for a real one by `DriverOffersProvider` (search for
   `ingo-offer-test` and `offerKey === 'test'`).
7. **`useLiveLocation` native branch.** Does the watch start after a grant from
   Settings (no tap)? Does a permanently denied permission ever re-prompt? Does the
   web path behave exactly as before (diff against `git show HEAD:src/hooks/useLiveLocation.js`)?
8. **The "self-accept" correction.** The agent first claimed the app accepted an
   order by itself, then withdrew it after reading the device log (worklog 03:05).
   Independently confirm from the code that no path calls `driverAcceptOffer` or
   `useOfferActions().accept` without a user gesture or a notification-button intent.
9. **Docs.** `docs/deployment.md` and `docs/release-android.md` must agree with
   `android/app/build.gradle` and with each other (package name, version, commands).
   `docs/system-map.md` §13 "known unknowns" must not list anything the worklog has since resolved.
10. **Uncommitted tree.** Everything is uncommitted on `master`. List every changed
    and new file (`git status`) and flag anything that should not be committed
    (secrets, build output, scratch). `android/keystore.properties`, `*.jks`,
    `android/*.pem`, `.secrets/`, `android/app/google-services.json` must all be ignored.

## How to report

Ranked findings, most severe first. Each with `file:line`, what is wrong, how you
verified it, and the smallest fix. Then a short list of claims in the worklog you
could **not** verify and why. Do not fix anything yourself unless asked.
