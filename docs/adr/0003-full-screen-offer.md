# ADR 0003 — The offer notification carries a full-screen intent

Date: 2026-09-03. Status: accepted. Extends ADR 0002.

## Context

ADR 0002 put Accept and Decline on the driver-offer notification. On the
emulator the result was reported as "easy to miss", and the measurement agrees:
the channel is importance MAX, and SystemUI pins the heads-up banner for about
5.7 seconds (`onHeadsUpPinnedModeChanged` at 20:43:24.6 and 20:43:30.3), after
which the row collapses into the shade with the buttons hidden behind the
chevron. That is the whole of what channel importance buys. A banner that
stays, or an offer that appears over a dark or locked phone, is a different
Android mechanism: a **full-screen intent** on the notification
(`D:\OS\references\background-push.md`, rule 6; KangaruRide ADR-0049).

## Decision

1. **`OfferMessagingService` sets `setFullScreenIntent(open, true)`** on the
   ring notification, where `open` is the same PendingIntent as the body tap.
   Phone in use: Android keeps the heads-up pinned instead of fading it.
   Phone dark or locked: Android starts `MainActivity` from that intent. The
   intent carries `google.message_id` and the message data, so Capacitor's push
   plugin reports it to JavaScript as a notification tap and the existing
   `DriverOffersProvider` routes to the offer. Nothing new on the JS side.

2. **`MainActivity` draws over the keyguard only for an offer launch.**
   `setShowWhenLocked(true)` and `setTurnScreenOn(true)` are applied in
   `onCreate` / `onNewIntent` when the intent's `type` is `offer_ring`, and
   cleared in `onStop`. KangaruRide sets these in the manifest, which makes the
   entire app usable on a locked phone; here the exemption lasts exactly as
   long as the launch that earned it. The keyguard is never dismissed: leaving
   the offer for the rest of the app still takes an unlock.

3. **`USE_FULL_SCREEN_INTENT` is declared in the manifest.** Without it Android
   does not refuse the intent; it silently posts the ordinary 5 s banner. On
   Android 14+ it is a special app access. Sideloaded and debug installs have
   it; Google Play grants it automatically only to calling and alarm apps, so
   a store build of this app may run without it. The service logs
   `canUseFullScreenIntent()` on every ring so the downgrade is visible in
   logcat rather than indistinguishable from success.

4. **The service lights a dark screen itself, for 15 s**, with a timed
   `SCREEN_BRIGHT_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP` (manifest `WAKE_LOCK`).
   The full-screen intent wakes the screen when it is granted; this is the
   floor under it for a handset where it is not, so the heads-up on the lock
   screen is at least lit. Kangaru does the same (`lightUpScreen`). It makes
   light, not sound, so Do Not Disturb is untouched. Skipped, and logged as
   skipped, when the screen is already on.

5. **Kept as it was:** the data-only Android leg (ADR 0002), the channel id,
   the buttons, the poll-gated accept, and Do Not Disturb (not bypassed).

## Consequences

- Since the same evening, every launch that names an offer (body tap, button
  while the offer loads, full-screen intent) lands on the in-app offer screen
  `/driver/offer/:offerKey` (`DriverOfferPage`), not on the driver home. The
  in-app DOM banner is no longer shown in the native app; the screen is the
  in-app surface and the OS notification is the out-of-app one.

- A ring while the phone is locked now opens the app over the lock screen
  (cold start of the WebView if the process was dead: a few seconds on a
  low-end handset). The notification with its buttons is still posted
  alongside, so the driver has both.
- Not built: a looped ringtone, a native call-style card, and a settings row
  that asks the driver for the special access on Android 14+. Each is its own
  change; the last one is needed before a Play release can rely on this.
- Everything under `android/` must still be re-applied where the store builds
  are produced (see CLAUDE.md). This ADR adds one manifest line and two Java
  files to that list.
