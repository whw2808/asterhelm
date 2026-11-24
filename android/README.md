# Asterhelm for Android

Asterhelm packages the shared chat and task-board UI from `server/` into an Android app. The native layer handles pairing, encrypted session storage, draft recovery and optional reminder notifications. It targets API 35 and supports Android 8.0 (API 26) and later with an up-to-date Android System WebView.

## Build a debug APK

Use macOS or Linux with Python 3.9+, JDK 17 and the Android SDK command-line tools. Set `ANDROID_HOME` to your SDK directory. Set `JAVA_HOME` to your JDK or put its `java`, `javac`, `jar` and `keytool` commands on `PATH`.

From the repository root, install the pinned platform and build tools. SDK licenses can be accepted with `sdkmanager --licenses`.

```sh
sdkmanager --sdk_root="$ANDROID_HOME" 'platforms;android-35' 'build-tools;35.0.0'
```

Set `ASTERHELM_PUBLIC_ORIGIN` to the HTTPS origin used by your Asterhelm server, replacing the reserved example hostname below. It may include a port. Use the origin without any API path, credentials, query or fragment. Android must trust the server's TLS certificate.

```sh
export ASTERHELM_PUBLIC_ORIGIN=https://assistant.example.test
python3 android/build.py
```

The script packages the shared assets, compiles the Java source with D8, aligns the APK and verifies its debug signature. The output is `android/build/asterhelm-debug.apk`. Use `--output FILE` to choose another location. The application ID is `dev.asterhelm.android`.

The first build generates a per-developer debug signing identity under `$ANDROID_USER_HOME/asterhelm-debug/`, or `~/.android/asterhelm-debug/` when that variable is unset. Retain it to install subsequent builds as updates. The APK contains the selected server origin. Rebuild to change servers. Each origin has a separate pairing and draft store.

## Pair a device

Install the debug APK on your Android device. If you use Android SDK Platform-Tools and have USB debugging enabled, run `adb install -r android/build/asterhelm-debug.apk`. On the server, run `node scripts/asterhelm.mjs pair` from the repository root to generate a single-use invitation. Open the link on the phone and choose Asterhelm, or paste the link into the app's pairing screen. Confirm the connection, then choose whether to enable background reminders.

The interface loads from assets bundled in the APK. Only native HTTPS requests contact the configured Asterhelm server. When enabled, reminders use a foreground service with a visible notification and a periodic catch-up job.

## Run checks

The JVM pairing tests and Python origin-validation tests run during every build. They can run on a host with Python and the JDK alone. The separate native bridge test uses Node's built-in test runner.

```sh
python3 android/build.py --test
node --test android/tests/android-host.test.mjs
```

The host tests use reserved example domains and synthetic inputs. To verify repeatability, build twice from the same checkout using the same JDK, SDK, origin and local debug identity.

```sh
python3 android/build.py --output android/build/first.apk
python3 android/build.py --output android/build/second.apk
cmp android/build/first.apk android/build/second.apk
```
