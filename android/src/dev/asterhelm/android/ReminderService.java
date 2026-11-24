package dev.asterhelm.android;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.SystemClock;

public final class ReminderService extends Service {
    private Thread worker;
    @Override public int onStartCommand(Intent i, int flags, int startId) {
        Reminders.channels(this);
        startForeground(Reminders.SERVICE_NOTIFICATION, Reminders.connection(this));
        if (!Reminders.enabled(this) || !Vault.paired(this) || !Reminders.permitted(this)) {
            stopSelf(); return START_NOT_STICKY;
        }
        if (worker == null || !worker.isAlive()) {
            worker = new Thread(this::listen, "asterhelm-reminders");
            worker.start();
        }
        return START_STICKY;
    }
    private void listen() {
        Reminders.listenerRunning.set(true);
        int retry = 5;
        try {
            while (!Thread.currentThread().isInterrupted() && Reminders.enabled(this) && Reminders.permitted(this)) {
                long start = SystemClock.elapsedRealtime();
                try {
                    int count = Reminders.poll(this, 115000);
                    retry = 5;
                    if (count == 0 && SystemClock.elapsedRealtime() - start < 5000) Thread.sleep(60000);
                } catch (InterruptedException e) { break; }
                catch (Exception e) {
                    if (e instanceof Api.Failure && ((Api.Failure)e).status == 401) break;
                    try { Thread.sleep(retry * 1000L); } catch (InterruptedException interrupted) { break; }
                    retry = Math.min(180, retry * 2);
                }
            }
        } finally { Reminders.listenerRunning.set(false); stopSelf(); }
    }
    @Override public void onDestroy() { if (worker != null) worker.interrupt(); super.onDestroy(); }
    @Override public IBinder onBind(Intent i) { return null; }
}
