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

On the board, open a desktop session and choose **接着聊**. Messages keep using this session across app restarts. After the first message is accepted, choose **加入当前工作** on a different session to include it in that work when you send your next message. Choosing **接着聊** on the other session opens its own work. **退出接续** returns the composer to general chat. The delivery label below a message shows whether its update has reached the desktop.

Discovery and standing-rule cards update on the original chat message. A discovery shows its evidence and any read-only check. Tap **同意立项** to start the proposed work, or use the card to ignore it or request another check. A rule shows its next check or awaited event, recent activity and available controls. Card actions retain their request identity across retries and leave the composer draft and selected desktop session in place.

Tell Asterhelm which goal to follow in chat. The **目标跟进** card on that message starts in preview mode. Read the sample reminder and expand **依据** to see the device, agent, source, time and reason a finding qualifies. Choose **开启提醒** to receive future matching updates. On the board, open an agent to inspect its latest work evidence and timestamp. When the only record is a heartbeat, the board shows the heartbeat time and indicates that a work step has yet to be verified.

Install the updated APK over the previous version with the same signing identity and server origin to keep the existing pairing. If a message was pending in the previous version, selecting its original session restores the text for retry.

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
