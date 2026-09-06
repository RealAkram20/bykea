package com.kigatta.ingo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Draws the driver-offer notification with Accept / Decline buttons.
 *
 * Why this exists: an FCM message with a `notification` block is rendered by
 * Android itself while the app runs no code, so buttons cannot be added to it.
 * The sender (supabase/functions/driver-offer-push) therefore sends the Android
 * leg data-only, and this service builds the notification. A high-priority data
 * message starts this service even when the app process is dead, which is what
 * keeps delivery working for a killed app.
 *
 * Subclasses Capacitor's MessagingService and calls through to it, so token
 * refresh and the JS `pushNotificationReceived` event are unchanged. The manifest
 * gives this service a higher intent-filter priority than the plugin's; Firebase
 * delivers each message to exactly one MESSAGING_EVENT service.
 *
 * The buttons do not talk to the backend from here. Each one launches
 * MainActivity with the message's data plus `ingoAction`, and because the extras
 * include `google.message_id`, Capacitor's push plugin surfaces the launch to JS
 * as `pushNotificationActionPerformed`. DriverOffersProvider then runs the same
 * accept / reject functions the in-app offer card uses.
 */
public class OfferMessagingService extends MessagingService {
    private static final String TAG = "IngoOfferPush";

    /** MUST equal DRIVER_OFFER_CHANNEL_ID in src/lib/driverPush.js. See docs/adr/0001. */
    static final String CHANNEL_ID = "ingo_driver_offers";
    static final String CHANNEL_NAME = "Driver offers";
    /**
     * A channel is immutable once created, and the driver — or the phone maker's
     * notification manager — can drop it to "silent" or block it, after which
     * every offer lands in the shade with no pop-up and nothing in the app can
     * raise it back. "Works in the app, nothing outside it" on a real phone,
     * 2026-09-06. When the base channel is found below HIGH, offers move to a
     * fresh channel with a numbered suffix at full importance (effectiveChannelId).
     * The base id is still what the JS side creates and what ADR 0001 pins; only
     * the Java side ever posts, so only it needs the effective id.
     */
    static final int CHANNEL_HEAL_MAX = 5;
    /** Where the last ring's facts are kept for the Permissions panel's "Last push" row. */
    static final String PREFS = "ingo_push";

    /** One id for every offer notification; the FCM `tag` (one per order) tells them apart. */
    static final int NOTIFICATION_ID = 0x1960;

    /** The `type` value of a ring message. MainActivity reads it off the launch intent. */
    static final String TYPE_OFFER_RING = "offer_ring";

    /** How long the screen is held lit for an offer when the phone was dark. */
    static final long WAKE_MS = 15_000L;

    static final String EXTRA_ACTION = "ingoAction";
    static final String ACTION_ACCEPT = "accept";
    static final String ACTION_DECLINE = "decline";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String type = data.get("type");
        String tag = data.get("tag");
        Log.i(TAG, "message type=" + type + " tag=" + tag + " hasNotificationBlock=" + (message.getNotification() != null));

        if (TYPE_OFFER_RING.equals(type) && tag != null && !tag.isEmpty()) {
            show(message, data, tag);
        } else if ("offer_stop".equals(type) && tag != null && !tag.isEmpty()) {
            manager().cancel(tag, NOTIFICATION_ID);
            Log.i(TAG, "withdrawn tag=" + tag);
        }

        // The JS side still gets the event when the WebView is alive (in-app card,
        // ring, banner). When it is not, this call is a no-op.
        super.onMessageReceived(message);
    }

    private void show(RemoteMessage message, Map<String, String> data, String tag) {
        String messageId = message.getMessageId() != null ? message.getMessageId() : String.valueOf(System.currentTimeMillis());
        postOffer(this, data, messageId, tag);
    }

    /**
     * Builds and posts one offer notification. Static and context-based so the
     * Permissions panel can post a sample through exactly this path
     * (IngoPermissionsPlugin.sendTestOffer): a driver who sees the sample pop on
     * screen has proven the channel, the permission and the full-screen grant at
     * once, and one who does not has the rows above it to fix.
     */
    static void postOffer(Context ctx, Map<String, String> data, String messageId, String tag) {
        String channelId = effectiveChannelId(ctx);

        String title = firstNonEmpty(data.get("title"), "New InGo booking");
        String body = firstNonEmpty(data.get("body"), "Open the app to accept or reject.");

        PendingIntent open = launch(ctx, data, messageId, tag, null, 0);
        PendingIntent accept = launch(ctx, data, messageId, tag, ACTION_ACCEPT, 1);
        PendingIntent decline = launch(ctx, data, messageId, tag, ACTION_DECLINE, 2);

        Notification n = new NotificationCompat.Builder(ctx, channelId)
            .setSmallIcon(R.drawable.ic_stat_offer)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(open)
            // ADR 0003. Phone in use: Android pins the heads-up instead of fading it
            // after ~5 s. Phone dark or locked: Android starts MainActivity over the
            // keyguard (MainActivity honours that only for an offer launch). Needs
            // USE_FULL_SCREEN_INTENT in the manifest; without it Android silently
            // posts the ordinary 5 s banner instead — see logFullScreenGrant().
            .setFullScreenIntent(open, true)
            .addAction(0, "Accept", accept)
            .addAction(0, "Decline", decline)
            .build();

        manager(ctx).notify(tag, NOTIFICATION_ID, n);
        Log.i(TAG, "posted tag=" + tag + " title=" + title);
        boolean fsi = logFullScreenGrant(ctx);
        lightUpScreen(ctx, fsi);
        recordRing(ctx, tag, channelId, fsi);
    }

    /**
     * Lights a dark screen for WAKE_MS so the offer is seen on the lock screen.
     *
     * The full-screen intent is what wakes the screen and starts the activity when
     * it is granted. This is the floor underneath it: on Android 14+ a Play build may
     * lack the special access, and Android then posts a plain heads-up on a screen
     * that stays dark. A driver with the phone face-down in a cradle sees nothing.
     * The wake-lock flags are deprecated and still honoured; the lock is timed, so
     * it cannot leak. Never bypasses Do Not Disturb: it makes light, not sound.
     */
    @SuppressWarnings("deprecation")
    private static void lightUpScreen(Context ctx, boolean fullScreenIntentGranted) {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) { Log.w(TAG, "no PowerManager; screen not lit"); return; }
            if (pm.isInteractive()) { Log.i(TAG, "screen already on; no wake lock"); return; }
            if (fullScreenIntentGranted) {
                // The full-screen intent wakes the screen and starts the activity in one
                // SystemUI transition. Waking it here first, ~2 s before a cold-started
                // activity can draw, made SystemUI bounce back to the keyguard
                // (measured 2026-09-03: "state SHADE != upcomingState KEYGUARD", app in
                // front only 25 s later). So the wake lock is the fallback, not the rule.
                Log.i(TAG, "screen dark; leaving the wake to the full-screen intent");
                return;
            }
            PowerManager.WakeLock wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
                "ingo:offer");
            wl.acquire(WAKE_MS);
            Log.i(TAG, "screen was dark; lit for " + WAKE_MS + " ms");
        } catch (RuntimeException e) {
            Log.w(TAG, "wake lock failed: " + e.getMessage());
        }
    }

    /**
     * Android 14+ treats USE_FULL_SCREEN_INTENT as a special app access. It is granted
     * to a sideloaded or debug install, but Play may withhold it from a non-calling
     * app — and Android does not refuse a full-screen intent it has not granted, it
     * quietly downgrades it to a heads-up that fades in ~5 s. That failure is
     * otherwise indistinguishable from success, so it is logged on every ring.
     */
    private static boolean logFullScreenGrant(Context ctx) {
        if (Build.VERSION.SDK_INT < 34) {
            Log.i(TAG, "fullScreenIntent granted (pre-Android 14: granted at install)");
            return true;
        }
        boolean ok = manager(ctx).canUseFullScreenIntent();
        Log.i(TAG, ok
            ? "fullScreenIntent granted"
            : "fullScreenIntent NOT granted: Android will show a 5 s heads-up instead of the sticky/lock-screen offer");
        return ok;
    }

    /**
     * An intent into MainActivity that Capacitor's push plugin will report to JS as a
     * notification tap. `google.message_id` is the key the plugin looks for; every
     * other extra becomes `notification.data`. The Intent action string is unique per
     * (tag, button) so the PendingIntents never collapse into one another.
     */
    private static PendingIntent launch(Context ctx, Map<String, String> data, String messageId, String tag, String action, int slot) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction("com.kigatta.ingo.OFFER_" + slot + "_" + tag);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra("google.message_id", messageId);
        for (Map.Entry<String, String> e : data.entrySet()) {
            i.putExtra(e.getKey(), e.getValue());
        }
        if (action != null) i.putExtra(EXTRA_ACTION, action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(ctx, (tag + "#" + slot).hashCode(), i, flags);
    }

    /** Idempotent. The JS side creates the same channel; whichever runs first wins and the other is a no-op. */
    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        createChannelIfMissing(ctx, CHANNEL_ID);
    }

    private static void createChannelIfMissing(Context ctx, String id) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = manager(ctx);
        if (nm == null || nm.getNotificationChannel(id) != null) return;
        NotificationChannel ch = new NotificationChannel(id, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("New delivery and ride requests");
        ch.enableVibration(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
        Log.i(TAG, "channel created " + id + " importance=HIGH");
    }

    /**
     * The channel offers are posted on: the base channel while it can still pop
     * on screen, otherwise the first numbered channel that can, created here at
     * HIGH. A driver who deliberately silenced the base channel sees the new one
     * appear under the app's notification settings and can silence that too;
     * after CHANNEL_HEAL_MAX the last one is used as it is.
     */
    static String effectiveChannelId(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return CHANNEL_ID;
        NotificationManager nm = manager(ctx);
        if (nm == null) return CHANNEL_ID;
        String id = CHANNEL_ID;
        for (int n = 1; n <= CHANNEL_HEAL_MAX; n++) {
            createChannelIfMissing(ctx, id);
            NotificationChannel c = nm.getNotificationChannel(id);
            if (c == null || c.getImportance() >= NotificationManager.IMPORTANCE_HIGH) return id;
            String next = CHANNEL_ID + "_" + (n + 1);
            Log.w(TAG, "channel " + id + " importance=" + c.getImportance() + " cannot pop on screen; moving offers to " + next);
            id = next;
        }
        createChannelIfMissing(ctx, id);
        return id;
    }

    /** Facts about the last ring, read back by IngoPermissionsPlugin.getState for the "Last push" row. */
    static void recordRing(Context ctx, String tag, String channelId, boolean fullScreenGranted) {
        try {
            NotificationManager nm = manager(ctx);
            int importance = -1;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
                NotificationChannel c = nm.getNotificationChannel(channelId);
                if (c != null) importance = c.getImportance();
            }
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            boolean interactive = pm != null && pm.isInteractive();
            boolean dnd = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && nm != null) {
                int f = nm.getCurrentInterruptionFilter();
                dnd = f != NotificationManager.INTERRUPTION_FILTER_ALL && f != NotificationManager.INTERRUPTION_FILTER_UNKNOWN;
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong("last_ring_at", System.currentTimeMillis())
                .putString("last_ring_tag", tag == null ? "" : tag)
                .putString("last_ring_channel", channelId)
                .putInt("last_ring_importance", importance)
                .putBoolean("last_ring_notifications", androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled())
                .putBoolean("last_ring_fsi", fullScreenGranted)
                .putBoolean("last_ring_interactive", interactive)
                .putBoolean("last_ring_dnd", dnd)
                .apply();
        } catch (Exception e) {
            Log.w(TAG, "could not record the ring: " + e.getMessage());
        }
    }

    private NotificationManager manager() {
        return manager(this);
    }

    static NotificationManager manager(Context ctx) {
        return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static String firstNonEmpty(String a, String b) {
        return (a != null && !a.trim().isEmpty()) ? a : b;
    }
}
