package dev.asterhelm.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && Vault.paired(context)
                && Reminders.enabled(context) && Reminders.permitted(context)) {
            // Some vendors may defer foreground startup. The persisted catch-up job still exists.
            try { Reminders.start(context); } catch (IllegalStateException ignored) {}
        }
    }
}
