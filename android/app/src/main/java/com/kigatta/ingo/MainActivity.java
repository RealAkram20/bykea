package com.kigatta.ingo;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

/**
 * Capacitor's activity, plus one policy: an offer may draw over the lock screen.
 *
 * OfferMessagingService attaches a full-screen intent to the offer notification
 * (ADR 0003). When the phone is dark or locked, Android starts this activity from
 * that intent — but draws the keyguard on top of it unless the activity says
 * otherwise. `showWhenLocked` puts the offer in front of the keyguard;
 * `turnScreenOn` wakes a dark screen.
 *
 * Both are switched on only for a launch whose intent carries `type=offer_ring`
 * (the full-screen intent, the body tap, and the two buttons all do), and switched
 * off again in onStop. KangaruRide sets them in the manifest, which makes the whole
 * app usable on a locked phone; here the exemption lasts exactly as long as the
 * offer launch that earned it. Nothing dismisses the keyguard: reaching the rest of
 * the app still takes an unlock, which is right.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must precede super.onCreate: Capacitor loads its plugin list there.
        registerPlugin(IngoPermissionsPlugin.class);
        super.onCreate(savedInstanceState);
        applyLockScreenPolicy(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        applyLockScreenPolicy(intent);
    }

    @Override
    public void onStop() {
        super.onStop();
        // The exemption lives only as long as the offer launch. Once the activity
        // leaves the screen (power button, HOME, another app) the next wake shows
        // the keyguard as normal.
        setOverKeyguard(false);
    }

    private void applyLockScreenPolicy(Intent intent) {
        boolean offer = intent != null && OfferMessagingService.TYPE_OFFER_RING.equals(intent.getStringExtra("type"));
        setOverKeyguard(offer);
    }

    private void setOverKeyguard(boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(on);
            setTurnScreenOn(on);
        } else {
            int flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (on) getWindow().addFlags(flags); else getWindow().clearFlags(flags);
        }
        keepScreenOn(on);
    }

    /**
     * Holds the screen on while an offer launch is in front.
     *
     * turnScreenOn wakes the screen, but a phone woken over its keyguard with no
     * touch goes back to sleep on the lock-screen timeout — measured at ~5 s on
     * Android 15, taking the offer with it and stopping this activity. Held for at
     * most KEEP_SCREEN_ON_MS (one re-ring window) so an ignored offer cannot pin the
     * screen on indefinitely; cleared early by onStop.
     */
    private void keepScreenOn(boolean on) {
        android.view.View v = getWindow().getDecorView();
        v.removeCallbacks(releaseScreen);
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            v.postDelayed(releaseScreen, KEEP_SCREEN_ON_MS);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private static final long KEEP_SCREEN_ON_MS = 120_000L;
    private final Runnable releaseScreen = () -> getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
}
