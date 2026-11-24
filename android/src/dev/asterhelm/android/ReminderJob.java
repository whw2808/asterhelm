package dev.asterhelm.android;

import android.app.job.JobParameters;
import android.app.job.JobService;

public final class ReminderJob extends JobService {
    private Thread task;
    @Override public boolean onStartJob(JobParameters params) {
        task = new Thread(() -> {
            boolean retry = false;
            try { Reminders.poll(this, 0); }
            catch (Exception e) { retry = true; }
            if (!Thread.currentThread().isInterrupted()) jobFinished(params, retry);
        }, "asterhelm-reminders-catchup");
        task.start(); return true;
    }
    @Override public boolean onStopJob(JobParameters params) {
        if (task != null) task.interrupt();
        return true;
    }
}
