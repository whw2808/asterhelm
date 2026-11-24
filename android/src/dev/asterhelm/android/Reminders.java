package dev.asterhelm.android;

import android.app.*;
import android.app.job.*;
import android.content.*;
import android.net.Uri;
import android.os.Build;
import android.content.pm.PackageManager;
import org.json.*;
import java.util.concurrent.atomic.AtomicBoolean;

final class Reminders {
    static final String MESSAGES = "reminders_v1";
    static final String LISTENER = "connection_v1";
    private static final int JOB = 101;
    static final int SERVICE_NOTIFICATION = 3;
    private static final Object DELIVERY = new Object();
    static final AtomicBoolean listenerRunning = new AtomicBoolean(false);
    static void channels(Context c) {
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        NotificationChannel messages = new NotificationChannel(MESSAGES, "助手提醒", NotificationManager.IMPORTANCE_HIGH);
        messages.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(messages);
        NotificationChannel link = new NotificationChannel(LISTENER, "后台连接状态", NotificationManager.IMPORTANCE_LOW);
        link.setShowBadge(false);
        manager.createNotificationChannel(link);
    }
    static boolean permitted(Context c) {
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(MESSAGES);
        return manager.areNotificationsEnabled() && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE)
                && (Build.VERSION.SDK_INT < 33 || c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED);
    }
    static boolean enabled(Context c) { return Vault.prefs(c).getBoolean("reminders", false); }
    static void start(Context c) {
        channels(c);
        Vault.prefs(c).edit().putBoolean("reminders", true).apply();
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (scheduler.getPendingJob(JOB) == null) {
            JobInfo job = new JobInfo.Builder(JOB, new ComponentName(c, ReminderJob.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).setPeriodic(15 * 60_000L).build();
            scheduler.schedule(job);
        }
        c.startForegroundService(new Intent(c, ReminderService.class));
    }
    static void stop(Context c) {
        Vault.prefs(c).edit().putBoolean("reminders", false).commit();
        c.getSystemService(JobScheduler.class).cancel(JOB);
        c.stopService(new Intent(c, ReminderService.class));
        c.getSystemService(NotificationManager.class).cancelAll();
    }
    static PendingIntent open(Context c, String id) {
        Intent i = new Intent(c, MainActivity.class).setAction("dev.asterhelm.android.OPEN_MESSAGE")
                .setData(new Uri.Builder().scheme("asterhelm-notification").authority("conversation").appendPath(id).build())
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    static Notification connection(Context c) {
        return new Notification.Builder(c, LISTENER).setSmallIcon(R.drawable.notify_icon).setColor(0xff3047f4)
                .setContentTitle("Asterhelm 后台提醒已开启").setContentText("点按返回对话，可在菜单中关闭")
                .setContentIntent(open(c, "")).setOngoing(true).setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE).setShowWhen(false).build();
    }
    static int poll(Context c, int wait) throws Exception {
        if (!enabled(c) || !Vault.paired(c) || !permitted(c)) return 0;
        long after = Vault.prefs(c).getLong("cursor", 0);
        JSONObject response = Api.call(c, "notifications", Api.args("after", after, "waitMs", wait));
        JSONArray rows = response.getJSONArray("items");
        synchronized (DELIVERY) {
            if (!enabled(c) || !Vault.paired(c) || !permitted(c)) return 0;
            long cursor = Vault.prefs(c).getLong("cursor", 0);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                long seq = row.getLong("seq");
                if (seq <= cursor) continue;
                long pairedAt = Vault.prefs(c).getLong("pairedAt", 0);
                if (java.time.Instant.parse(row.getString("createdAt")).toEpochMilli() < pairedAt) {
                    cursor = seq;
                    if (!Vault.prefs(c).edit().putLong("cursor", cursor).commit()) throw new IllegalStateException("无法保存提醒进度");
                    continue;
                }
                String id = row.getString("id");
                String body = row.getString("text");
                Notification publicVersion = new Notification.Builder(c, MESSAGES).setSmallIcon(R.drawable.notify_icon)
                        .setContentTitle("Asterhelm").setContentText("收到一条提醒").build();
                Notification note = new Notification.Builder(c, MESSAGES).setSmallIcon(R.drawable.notify_icon)
                        .setContentTitle("Asterhelm").setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body))
                        .setColor(0xff3047f4).setCategory(Notification.CATEGORY_MESSAGE)
                        .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion)
                        .setOnlyAlertOnce(true).setAutoCancel(true).setContentIntent(open(c, id)).build();
                c.getSystemService(NotificationManager.class).notify(id, 7, note);
                cursor = seq;
                if (!Vault.prefs(c).edit().putLong("cursor", cursor).commit()) throw new IllegalStateException("无法保存提醒进度");
            }
        }
        return rows.length();
    }
}
