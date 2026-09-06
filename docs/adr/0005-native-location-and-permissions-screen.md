# ADR 0005 — Location through the fused provider, and a Permissions panel that reads the phone

Date: 2026-09-06. Status: accepted. Extends ADR 0001–0003.

## Context

On the first release-signed build a driver reported that "Allow location"
works but "takes forever when checking", and that offers reached the phone
only as the in-app screen, never as a heads-up notification.

Reproduced on an emulator with the app in front and the keyguard dismissed:
with the location permission not yet granted, the WebView's
`navigator.geolocation.getCurrentPosition` raised **no Android permission
dialog at all** and failed after its full 10 s timeout (`code 3`). The app's
Allow path then ran a second, 12 s high-accuracy attempt and reported
"unavailable". Every read in `useLiveLocation` and `devicePickupLocation` went
through the WebView, and three of them started on mount and competed. Nothing
ever asked Android's fused location provider, which answers from its last
known fix in well under a second.

The silent-offer report has four possible causes, none visible from inside
the app until now: the notification permission refused; the offer channel
created at too low an importance by an earlier install (a channel is immutable
once created, so no later build can raise it); the Android 14+ full-screen
special access withheld (Android downgrades silently, ADR 0003); or battery
optimisation stopping a killed app. The app read none of these and could open
none of the settings screens that change them.

## Decision

1. **On the native app, position comes from `@capacitor/geolocation`.**
   `readDeviceGpsPosition` gains a native branch: the permission is requested
   explicitly first (`requestPermissions`, no timer racing the dialog), then a
   low-accuracy read with a 60 s `maximumAge` (the fused provider's last known
   fix, near-instant), then a precise read only if that fails. The continuous
   watch uses the plugin's `watchPosition` and starts only once the permission
   exists; the Allow button bumps an epoch so the watch starts after a grant.
   Background reads never prompt: they check the permission and give up
   quietly if it is not there. The web path is unchanged.

2. **A small native plugin, `IngoPermissionsPlugin`, reads what the plugins
   cannot and opens the screen that fixes each thing.** `getState()` returns
   the location permission and whether location services are on, whether
   notifications are enabled, the offer channel's importance and whether it
   can heads-up, the full-screen-intent grant on Android 14+ (`not_needed`
   below), and battery optimisation. Six `open…Settings` methods start the
   matching system screen, each falling back to the app's details page on
   handsets that lack it. `sendTestOffer()` posts a sample offer through
   `OfferMessagingService.postOffer`, the exact path a real ring takes.

3. **`DriverPermissionsPanel` on the driver Profile shows every row with its
   real state and one action.** Location (Allow / Turn on / Open settings),
   Notifications (Allow / Open settings, and the push token is registered on
   a grant), Offer alerts (the channel: Set up / Open setting), Full-screen
   offers (Android 14+ only), Battery, and "Send test offer". States are read
   on mount, after every action, and whenever the app returns to the
   foreground, so a driver coming back from Settings sees the new truth
   without tapping anything. `unknown` is shown as unknown, never as blocked.

4. **The Home screen points at the panel when an offer would arrive
   silently** (notifications blocked, channel silent, or full-screen access
   withheld), and its location prompt offers "Open settings" instead of a
   futile Retry when the permission has been permanently refused.

## Consequences

- The fast fix ends the "Checking…" wait on Android. Measured on the emulator
  in the verification for this ADR; a handset in a pocket still needs a real
  GPS fix for precision, which arrives through the watch afterwards.
- The first `requestPermissions` shows Android's dialog with "Precise /
  Approximate". Approximate-only is accepted for reads and shown as a warning
  row with a settings action.
- `@capacitor/geolocation` adds `play-services-location` to the Android build.
  No manifest change: the location permissions were already declared.
- The test offer's tap carries `offerKey=test` and `ingoTest=1`; the tap sink
  ignores it instead of looking for an order.
- A channel whose importance a driver lowered can only be raised by the
  driver; the panel opens the exact screen and says why.

## Verification

Recorded in `docs/worklog.md` under 2026-09-06 03:30, on an emulator with a
fresh install of the release-signed build: the OS dialog appears on the Allow
tap; the first fix arrives **249 ms** after the grant (`native fast fix`) and
the watch starts; the published position follows a moved GPS fix; the panel
reads every row from the phone; the sample offer posts on the offer channel at
importance 5 with two actions. Owed: one undisturbed run of the prompt-clear
latency, and a real handset.
