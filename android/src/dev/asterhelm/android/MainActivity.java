package dev.asterhelm.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import org.json.JSONObject;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class MainActivity extends Activity {
    static final int PAPER = 0xfff0f0ff;
    private static final int INK = 0xff131638, MUTED = 0xff565873, ACCENT = 0xff3047f4;
    private static final int NOTIFICATION_PERMISSION = 81;
    // Serialize mutations across activity recreation. In particular, keep an old pending send
    // or an expired session response from clearing a newly paired phone's state.
    private static final ExecutorService writes = Executors.newSingleThreadExecutor();
    private final ExecutorService reads = Executors.newFixedThreadPool(2);
    private FrameLayout root;
    private AssistantShell shell;
    private EditText codeField;
    private Button pairButton;
    private TextView pairStatus;
    private boolean pairing;
    private String openTarget, incomingCode;
    private volatile JSONObject typed; // Latest UI snapshot, saved only in the activity instance state.
    private Consumer<Boolean> permissionResult;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        Reminders.channels(this);
        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets edges = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(edges.left, edges.top, edges.right, edges.bottom);
                return WindowInsets.CONSUMED;
            });
            root.requestApplyInsets();
        } else root.setFitsSystemWindows(true);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        if (saved != null && Vault.paired(this)
                && saved.getLong("pairedAt", -1) == Vault.prefs(this).getLong("pairedAt", 0)) {
            openTarget = saved.getString("focus");
            String value = saved.getString("composer");
            if (value != null) try { typed = new JSONObject(value); } catch (org.json.JSONException ignored) {}
        }
        consume(getIntent());
        if (Vault.paired(this)) showAssistant(); else showPairing("");
    }
    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        consume(intent);
        if (shell != null && openTarget != null) { shell.open(openTarget); openTarget = null; }
        if (codeField != null && incomingCode != null) { codeField.setText(incomingCode); incomingCode = null; }
    }
    private void consume(Intent intent) {
        Uri uri = intent.getData();
        if (uri == null) return;
        intent.setData(null); // A one-use pairing code must never enter WebView history or saved task state.
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && !Vault.paired(this)) {
            incomingCode = PairCode.parse(uri.toString(), BuildConfig.PUBLIC_ORIGIN);
        } else if ("dev.asterhelm.android.OPEN_MESSAGE".equals(intent.getAction())
                && "asterhelm-notification".equals(uri.getScheme()) && "conversation".equals(uri.getHost())
                && uri.getPathSegments().size() <= 1) {
            String id = uri.getLastPathSegment();
            if (id == null || id.length() <= 512) openTarget = id == null ? "" : id;
        }
    }
    @Override public void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        saved.putString("focus", shell != null ? shell.pendingOpen() : openTarget);
        saved.putLong("pairedAt", Vault.prefs(this).getLong("pairedAt", 0));
        if (typed != null) saved.putString("composer", typed.toString());
    }
    @Override public void onResume() {
        super.onResume();
        if (Vault.paired(this) && Reminders.enabled(this) && Reminders.permitted(this)) Reminders.start(this);
        if (shell != null) shell.resumed();
    }
    @Override public void onPause() {
        if (shell != null) shell.onPause();
        super.onPause();
    }
    @Override public void onDestroy() {
        if (shell != null) { shell.closeShell(); shell = null; }
        reads.shutdownNow();
        permissionResult = null;
        super.onDestroy();
    }
    @Override public void onBackPressed() { handleBack(); }
    private void handleBack() { if (shell == null) finish(); else shell.back(); }
    private boolean alive() { return !isFinishing() && !isDestroyed(); }

    private void showAssistant() {
        if (shell != null) shell.closeShell();
        root.removeAllViews();
        codeField = null; pairButton = null; pairStatus = null; incomingCode = null;
        shell = new AssistantShell(this);
        root.addView(shell, new FrameLayout.LayoutParams(-1, -1));
        shell.open(openTarget); openTarget = null;
        shell.load();
    }
    void recoverShell(AssistantShell failed) {
        if (failed != shell) return;
        openTarget = failed.pendingOpen();
        shell.closeShell(); shell = null;
        new AlertDialog.Builder(this).setMessage("助手界面已关闭，可以重新打开。")
                .setPositiveButton("重新打开", (d, w) -> showAssistant()).setNegativeButton("返回", (d, w) -> finish())
                .setOnCancelListener(d -> finish()).show();
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable rounded(int color, int border) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(color); bg.setCornerRadius(dp(15));
        if (border != 0) bg.setStroke(dp(1), border);
        return bg;
    }
    private TextView text(String value, int size, int color) {
        TextView label = new TextView(this);
        label.setText(value); label.setTextColor(color); label.setTextSize(size);
        return label;
    }
    private void showPairing(String message) {
        if (shell != null) { shell.closeShell(); shell = null; }
        root.removeAllViews();
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        root.addView(scroll);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL); layout.setGravity(Gravity.CENTER_VERTICAL);
        layout.setPadding(dp(26), dp(28), dp(26), dp(28));
        layout.setFocusableInTouchMode(true);
        scroll.addView(layout);
        ImageView mark = new ImageView(this);
        try (InputStream in = getAssets().open("site/assistant-mark.webp")) { mark.setImageBitmap(BitmapFactory.decodeStream(in)); }
        catch (java.io.IOException e) { mark.setImageResource(R.drawable.app_icon); }
        mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        layout.addView(mark, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView heading = text("连接你的助手", 30, INK);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD); heading.setPadding(0, dp(16), 0, dp(10)); layout.addView(heading);
        TextView help = text("在运行 Asterhelm 的电脑上生成手机配对链接，然后在这里粘贴链接或配对码。", 16, MUTED);
        help.setPadding(0, 0, 0, dp(20)); layout.addView(help);
        codeField = new EditText(this);
        codeField.setSingleLine(true);
        codeField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        codeField.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        codeField.setSaveEnabled(false); codeField.setTextColor(INK); codeField.setTextSize(16);
        codeField.setHint("配对链接或配对码"); codeField.setHintTextColor(MUTED);
        codeField.setPadding(dp(16), dp(8), dp(16), dp(8)); codeField.setBackground(rounded(0xffffffff, 0xffd4d5ed));
        layout.addView(codeField, new LinearLayout.LayoutParams(-1, dp(54)));
        if (incomingCode != null) { codeField.setText(incomingCode); incomingCode = null; }
        pairButton = new Button(this); pairButton.setText("连接助手"); pairButton.setTextSize(16);
        pairButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD); pairButton.setTextColor(0xffffffff);
        pairButton.setBackgroundTintList(null);
        pairButton.setBackground(new android.graphics.drawable.RippleDrawable(ColorStateList.valueOf(0x22000000), rounded(ACCENT, 0), null));
        LinearLayout.LayoutParams buttonLayout = new LinearLayout.LayoutParams(-1, dp(50)); buttonLayout.topMargin = dp(12);
        layout.addView(pairButton, buttonLayout); pairButton.setOnClickListener(v -> pair());
        codeField.setOnEditorActionListener((v, action, event) -> { pair(); return true; });
        pairStatus = text(message, 14, MUTED);
        pairStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        pairStatus.setPadding(0, dp(10), 0, 0); layout.addView(pairStatus);
        layout.requestFocus();
    }
    private void pair() {
        if (pairing || codeField == null) return;
        String code = PairCode.parse(codeField.getText().toString(), BuildConfig.PUBLIC_ORIGIN);
        if (code == null) { pairStatus.setText("请粘贴服务器生成的完整配对链接或配对码。"); return; }
        pairing = true; pairButton.setEnabled(false); pairStatus.setText("正在连接服务器…");
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(codeField.getWindowToken(), 0);
        writes.execute(() -> {
            try {
                Api.call(this, "pair", Api.args("code", code));
                runOnUiThread(() -> {
                    if (!alive()) return;
                    pairing = false;
                    showAssistant(); askReminders(allowed -> {});
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (!alive() || codeField == null) return;
                    pairing = false; pairButton.setEnabled(true); pairStatus.setText(error(e));
                });
            }
        });
    }
    private String error(Exception e) {
        return e instanceof Api.Failure ? e.getMessage() : "暂时连不上服务器，请检查网络后重试。";
    }
    private void askReminders(Consumer<Boolean> done) {
        new AlertDialog.Builder(this).setTitle("开启后台提醒")
                .setMessage("手机会连接你的 Asterhelm 服务器。关闭对话后，有提醒时仍会收到系统通知。开启期间，通知栏会显示后台连接状态。")
                .setNegativeButton("取消", (d,w) -> done.accept(false)).setOnCancelListener(d -> done.accept(false))
                .setPositiveButton("开启", (d,w) -> {
                    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        permissionResult = done;
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION);
                    } else done.accept(enableReminders());
                }).show();
    }
    private boolean enableReminders() {
        boolean enabled = Vault.paired(this) && Reminders.permitted(this);
        if (enabled) Reminders.start(this);
        Toast.makeText(this, enabled ? "后台提醒已开启" : "请在系统通知设置里允许助手提醒", Toast.LENGTH_SHORT).show();
        return enabled;
    }
    @Override public void onRequestPermissionsResult(int req, String[] names, int[] grants) {
        super.onRequestPermissionsResult(req, names, grants);
        if (req != NOTIFICATION_PERMISSION) return;
        boolean result = enableReminders();
        if (permissionResult != null) { permissionResult.accept(result); permissionResult = null; }
    }

    private JSONObject switches() throws Exception {
        return Api.args("paired", Vault.paired(this), "reminders", Reminders.enabled(this), "permitted", Reminders.permitted(this));
    }
    void rememberDraft(AssistantShell source, JSONObject item) throws org.json.JSONException {
        if (shell != source) return;
        String text = item.getString("text");
        if (text.length() > 16000) return;
        JSONObject context = item.optJSONObject("context");
        JSONObject snapshot = Api.args("text", text);
        if (context != null && context.optString("id").length() <= 150 && context.optString("machine").length() <= 128) {
            String title = context.optString("title");
            snapshot.put("context", Api.args("id", context.optString("id"), "machine", context.optString("machine"),
                    "bindingId", context.optString("bindingId"), "title", title.substring(0, Math.min(title.length(), 512))));
        }
        typed = snapshot;
    }
    private JSONObject state() throws Exception {
        JSONObject result = switches();
        String binding = Vault.read(this, "chatBinding");
        result.put("binding", binding.isEmpty() ? JSONObject.NULL : new JSONObject(binding));
        String pending = Vault.read(this, "unsent");
        result.put("pending", pending.isEmpty() ? JSONObject.NULL : new JSONObject(pending));
        result.put("pendingTitle", Vault.read(this, "unsentContextTitle"));
        JSONObject snapshot = typed;
        result.put("typedDraft", snapshot == null ? JSONObject.NULL : snapshot.optString("text"));
        result.put("typedContext", snapshot == null || !snapshot.has("context") ? JSONObject.NULL : snapshot.get("context"));
        return result;
    }
    private void acknowledge(String id) throws Exception {
        String cached = Vault.read(this, "unsent");
        if (!id.isEmpty() && !cached.isEmpty() && id.equals(new JSONObject(cached).optString("requestId"))) {
            Vault.write(this, "unsent", "");
            Vault.write(this, "unsentContextTitle", "");
        }
    }
    private JSONObject execute(String op, JSONObject body, String title) throws Exception {
        switch (op) {
            case "state": return state();
            case "acknowledge": acknowledge(body.getString("requestId")); return new JSONObject();
            case "chat":
                String text = body.getString("text"), id = body.getString("requestId");
                if (text.trim().isEmpty() || text.length() > 16000 || id.isEmpty() || id.length() > 150)
                    throw new Api.Failure(400, "消息内容或编号无效。");
                JSONObject payload = Api.args("text", text, "requestId", id);
                JSONObject context = body.optJSONObject("context");
                if (context != null) payload.put("context", Api.args("machine", context.getString("machine"), "id", context.getString("id")));
                if (context != null && body.has("workId")) payload.put("workId", body.getString("workId"));
                JSONObject pending = new JSONObject(payload.toString());
                if (context != null && body.has("bindingId")) pending.put("bindingId", body.getString("bindingId"));
                Vault.write(this, "unsentContextTitle", title);
                Vault.write(this, "unsent", pending.toString());
                // Keep the idempotency key until the composer reconciles the accepted message.
                return Api.call(this, "chat", payload);
            case "history":
                JSONObject page = new JSONObject();
                if (body.has("before")) page.put("before", body.getLong("before"));
                if (body.has("around")) page.put("around", body.getString("around"));
                if (body.has("limit")) page.put("limit", body.getInt("limit"));
                return Api.call(this, "history", page);
            case "board": return Api.call(this, "board", Api.args("layout", "machines"));
            case "get": case "cancel": return Api.call(this, op, Api.args("id", body.getString("id")));
            case "logout": return Api.call(this, "logout", new JSONObject());
            default: throw new Api.Failure(400, "不支持的操作。");
        }
    }
    void onCommand(AssistantShell source, JSONObject item) {
        if (shell != source || !alive()) return;
        int id = item.optInt("id");
        String op = item.optString("op");
        if ("binding".equals(op)) {
            // A slow send may still be on the network. An explicit switch/exit must survive a cold start immediately.
            try {
                if (!Vault.paired(this)) throw new Api.Failure(401, "请重新配对。");
                JSONObject body = item.getJSONObject("body");
                JSONObject binding = body.optJSONObject("binding");
                // A receipt from an older WebView must respect a later explicit switch or exit.
                if (body.optBoolean("receipt")) {
                    String saved = Vault.read(this, "chatBinding");
                    if (saved.isEmpty() || binding == null ||
                            !new JSONObject(saved).optString("bindingId").equals(binding.optString("bindingId"))) {
                        source.send("id", id, "value", false);
                        return;
                    }
                }
                Vault.write(this, "chatBinding", binding == null ? "" : binding.toString());
                source.send("id", id, "value", true);
            } catch (Exception e) {
                source.send("id", id, "error", "无法保存当前工作", "status", e instanceof Api.Failure ? ((Api.Failure)e).status : 0);
            }
            return;
        }
        if ("settings".equals(op)) {
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
            source.send("id", id, "value", true); return;
        }
        if ("reminders".equals(op)) {
            Consumer<Boolean> complete = enabled -> {
                try { source.send("id", id, "value", switches()); }
                catch (Exception e) { source.send("id", id, "error", "无法读取提醒状态。"); }
            };
            if (Reminders.enabled(this) && Reminders.permitted(this)) { Reminders.stop(this); complete.accept(false); }
            else askReminders(complete);
            return;
        }
        if ("logout".equals(op)) {
            Runnable cancel = () -> source.send("id", id, "status", 0, "code", "cancelled", "error", "已取消解除配对。");
            new AlertDialog.Builder(this).setMessage("解除这台手机与 Asterhelm 的配对？")
                    .setNegativeButton("取消", (d,w) -> cancel.run()).setOnCancelListener(d -> cancel.run())
                    .setPositiveButton("解除配对", (d,w) -> runCommand(source, item)).show();
            return;
        }
        runCommand(source, item);
    }
    private void runCommand(AssistantShell source, JSONObject item) {
        String op = item.optString("op");
        int id = item.optInt("id");
        String account = Vault.prefs(this).getString("credential", "");
        boolean readOnly = "history".equals(op) || "board".equals(op) || "get".equals(op);
        (readOnly ? reads : writes).execute(() -> {
            try {
                if (account.isEmpty() || !account.equals(Vault.prefs(this).getString("credential", "")))
                    throw new Api.Failure(401, "请重新配对。");
                JSONObject result = execute(op, item.getJSONObject("body"), item.optString("title"));
                if ("logout".equals(op)) { clearPairing(account, ""); return; }
                runOnUiThread(() -> { if (alive() && source == shell) source.send("id", id, "value", result); });
            } catch (Exception e) {
                int status = e instanceof Api.Failure ? ((Api.Failure)e).status : 0;
                if (status == 401) {
                    writes.execute(() -> clearPairing(account, "配对已过期，请在服务器上生成新的配对码。"));
                } else runOnUiThread(() -> {
                    if (alive() && source == shell) source.send("id", id, "error", error(e), "status", status);
                });
            }
        });
    }
    private void clearPairing(String account, String reason) {
        if (!account.equals(Vault.prefs(this).getString("credential", ""))) return;
        Reminders.stop(this);
        Vault.prefs(this).edit().clear().commit();
        runOnUiThread(() -> {
            if (alive() && !Vault.paired(this)) {
                openTarget = null; incomingCode = null; permissionResult = null; typed = null; showPairing(reason);
            }
        });
    }
}
