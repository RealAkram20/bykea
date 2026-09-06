package com.kigatta.ingo;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The permissions a driver's phone must hold for offers to reach them, read from
 * the platform rather than guessed, plus the system settings screens that fix
 * each one. JavaScript face: src/lib/nativePermissions.js. ADR 0005.
 *
 * Nothing here requests a permission — the Capacitor Geolocation and
 * PushNotifications plugins own their own runtime prompts. This plugin answers
 * the questions those plugins cannot (is location switched on at all, has the
 * full-screen intent been granted on Android 14+, is the app battery-optimised)
 * and opens the one settings page that changes each answer.
 */
@CapacitorPlugin(name = "IngoPermissions")
public class IngoPermissionsPlugin extends Plugin {

    @PluginMethod
    public void getState(PluginCall call) {
        Context ctx = getContext();
        JSObject r = new JSObject();
        r.put("sdkInt", Build.VERSION.SDK_INT);
        // Several makers keep their own per-app "pop-up / floating / banner" switch
        // outside the channel importance. The panel names the maker so the driver
        // knows which switch to look for; the app cannot read it.
        r.put("manufacturer", String.valueOf(Build.MANUFACTURER));
        r.put("model", String.valueOf(Build.MODEL));

        boolean fine = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarse = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        r.put("location", fine ? "granted" : (coarse ? "coarse" : "denied"));

        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        r.put("locationServicesOn", lm != null && LocationManagerCompat.isLocationEnabled(lm));

        r.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled() ? "granted" : "denied");

        // Android 14+: a special app access that Play grants automatically only to
        // calling and alarm apps. Android never refuses a full-screen intent it has
        // not granted; it silently posts the ordinary banner instead. So the state
        // must be read, and this is the only call that reads it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            r.put("fullScreenIntent", nm != null && nm.canUseFullScreenIntent() ? "granted" : "denied");
        } else {
            r.put("fullScreenIntent", "not_needed");
        }

        boolean optimised = true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            optimised = !pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        }
        r.put("batteryOptimised", optimised);

        // The offer channel decides whether a notification pops on screen at all. A
        // channel is immutable once created: an earlier install that made it at a
        // lower importance, or a driver who tapped "silent" on a heads-up, leaves
        // every later build posting into a channel that cannot heads-up. Only the
        // driver can change it, in the channel's own settings screen.
        JSObject channel = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            // The channel offers are actually posted on. If the base channel was
            // silenced or blocked, this is a fresh numbered one at HIGH (healed).
            String effective = OfferMessagingService.effectiveChannelId(ctx);
            NotificationChannel c = nm == null ? null : nm.getNotificationChannel(effective);
            NotificationChannel base = nm == null ? null : nm.getNotificationChannel(OfferMessagingService.CHANNEL_ID);
            channel.put("id", effective);
            channel.put("healed", !OfferMessagingService.CHANNEL_ID.equals(effective));
            channel.put("baseImportance", base == null ? -1 : base.getImportance());
            if (c == null) {
                channel.put("exists", false);
                channel.put("importance", -1);
                channel.put("headsUp", false);
            } else {
                channel.put("exists", true);
                channel.put("importance", c.getImportance());
                channel.put("headsUp", c.getImportance() >= NotificationManager.IMPORTANCE_HIGH);
            }
        } else {
            channel.put("id", OfferMessagingService.CHANNEL_ID);
            channel.put("healed", false);
            channel.put("baseImportance", -1);
            channel.put("exists", true);
            channel.put("importance", -1);
            channel.put("headsUp", true);
        }
        r.put("offerChannel", channel);

        // What the last ring saw on this phone, written by OfferMessagingService
        // as it posted. This is the row that says whether a push arrived at all
        // while the app was away, and in which conditions.
        android.content.SharedPreferences p = ctx.getSharedPreferences(OfferMessagingService.PREFS, Context.MODE_PRIVATE);
        long lastAt = p.getLong("last_ring_at", 0L);
        if (lastAt > 0L) {
            JSObject last = new JSObject();
            last.put("at", lastAt);
            last.put("tag", p.getString("last_ring_tag", ""));
            last.put("channel", p.getString("last_ring_channel", ""));
            last.put("importance", p.getInt("last_ring_importance", -1));
            last.put("notifications", p.getBoolean("last_ring_notifications", false));
            last.put("fullScreenIntent", p.getBoolean("last_ring_fsi", false));
            last.put("screenOn", p.getBoolean("last_ring_interactive", false));
            last.put("doNotDisturb", p.getBoolean("last_ring_dnd", false));
            r.put("lastRing", last);
        }

        // Do Not Disturb hides a heads-up entirely and the offer channel does not
        // bypass it (an app cannot grant itself that). The phone applies it in
        // silence, so the panel must say it. INTERRUPTION_FILTER_ALL means off.
        boolean dnd = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                int filter = nm.getCurrentInterruptionFilter();
                dnd = filter != NotificationManager.INTERRUPTION_FILTER_ALL
                    && filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN;
            }
        }
        r.put("doNotDisturb", dnd);

        call.resolve(r);
    }

    /** The offer channel's own settings page, where "Pop on screen" / Urgent lives. */
    @PluginMethod
    public void openOfferChannelSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            openNotificationSettings(call);
            return;
        }
        OfferMessagingService.ensureChannel(getContext());
        Intent intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            .putExtra(Settings.EXTRA_CHANNEL_ID, OfferMessagingService.effectiveChannelId(getContext()));
        open(call, intent, true);
    }

    /**
     * Posts a sample offer through the exact path a real ring takes. What the
     * driver sees is the truth about their phone: a pop-up with Accept / Decline
     * means everything is granted; a silent row in the shade means the channel;
     * nothing at all means notifications are blocked.
     */
    @PluginMethod
    public void sendTestOffer(PluginCall call) {
        java.util.Map<String, String> data = new java.util.HashMap<>();
        data.put("type", OfferMessagingService.TYPE_OFFER_RING);
        data.put("tag", "ingo-offer-test");
        data.put("title", "Test: new InGo delivery");
        data.put("body", "This is how an offer arrives. Swipe it away, or tap to open the app.");
        data.put("offerKey", "test");
        data.put("link", "/driver/home");
        data.put("ingoTest", "1");
        OfferMessagingService.postOffer(getContext(), data, "test-" + System.currentTimeMillis(), "ingo-offer-test");
        JSObject r = new JSObject();
        r.put("posted", true);
        call.resolve(r);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        open(call, appDetailsIntent(), false);
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        open(call, new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS), true);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        open(call, intent, true);
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            JSObject r = new JSObject();
            r.put("opened", false);
            r.put("reason", "not_needed");
            call.resolve(r);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, packageUri());
        open(call, intent, true);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        // The list screen, not the per-app request dialog: the request dialog is a
        // Play-policy-sensitive intent and the list is where "Unrestricted" lives.
        open(call, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), true);
    }

    /** The system Do Not Disturb page. The action string is stable across OEMs; the fallback is the app's details page. */
    @PluginMethod
    public void openDndSettings(PluginCall call) {
        open(call, new Intent("android.settings.ZEN_MODE_SETTINGS"), true);
    }

    private Uri packageUri() {
        return Uri.parse("package:" + getContext().getPackageName());
    }

    private Intent appDetailsIntent() {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri());
    }

    /**
     * Starts a settings screen. A handset without the specific screen (some OEM
     * builds strip them) falls back to the app's own details page, which always
     * exists, so the driver is never left on a dead button.
     */
    private void open(PluginCall call, Intent intent, boolean fallbackToAppDetails) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        JSObject r = new JSObject();
        try {
            getContext().startActivity(intent);
            r.put("opened", true);
        } catch (ActivityNotFoundException e) {
            if (fallbackToAppDetails) {
                try {
                    Intent details = appDetailsIntent();
                    details.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(details);
                    r.put("opened", true);
                    r.put("fallback", "app_details");
                } catch (ActivityNotFoundException e2) {
                    r.put("opened", false);
                }
            } else {
                r.put("opened", false);
            }
        }
        call.resolve(r);
    }
}
