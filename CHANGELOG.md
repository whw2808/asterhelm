# Changelog

## 1.3.0 · 2026-11-24

First public source release of Asterhelm.

- Register devices and agent capabilities at runtime. Route tasks to registered workers and follow assignment, elapsed time and results in the conversation.
- Keep preferences, unfinished work and opt-in Codex Desktop session context available to the coordinator.
- Use the shared chat and device dashboard from a browser or a paired Android client. Android can surface reminders through its foreground connection.
- Bootstrap a local hub and worker, enroll a remote worker using mutual TLS, and test the queue with an offline byte-counting worker.
- Build the Android client for your own HTTPS origin. The repository includes a standalone project showcase with fictional examples.
