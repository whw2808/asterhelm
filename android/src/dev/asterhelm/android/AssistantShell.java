package dev.asterhelm.android;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.AssetManager;
import android.net.Uri;
import android.view.ViewGroup;
import android.webkit.*;
import android.widget.Toast;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

final class AssistantShell extends WebView {
    private static final Uri ORIGIN = Uri.parse("https://appassets.androidplatform.net");
    private static final String HOME = ORIGIN.toString() + "/";
    private static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self'; "
            + "img-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; "
            + "worker-src 'none'; base-uri 'none'; form-action 'none'";
    private final MainActivity activity;
    private final AssetManager assets;
    private WebMessagePort channel;
    private boolean closed, readyRequested;
    private int awaitingBack, nextBack;
    private String pendingOpen;

    AssistantShell(MainActivity activity) {
        super(activity);
        this.activity = activity;
        this.assets = activity.getAssets();
        setBackgroundColor(MainActivity.PAPER);
        setSaveEnabled(false);
        WebSettings settings = getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false); // Native draft restoration uses instance state and Vault.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false);
        setWebViewClient(new LocalContent());
    }

    void load() { loadUrl(HOME); }

    private static WebResourceResponse response(int status, String type, InputStream content) {
        Map<String,String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", CSP);
        headers.put("Referrer-Policy", "no-referrer");
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse(type, type.startsWith("image/") ? null : "UTF-8",
                status, status == 200 ? "OK" : "Forbidden", headers, content);
    }
    private static WebResourceResponse empty(int status) {
        return response(status, "text/plain", new ByteArrayInputStream(new byte[0]));
    }
    private final class LocalContent extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!"GET".equals(request.getMethod()) || !"https".equals(url.getScheme())
                    || !ORIGIN.getEncodedAuthority().equals(url.getEncodedAuthority())
                    || url.getEncodedQuery() != null || url.getEncodedFragment() != null) return empty(403);
            String path = url.getEncodedPath();
            if (request.isForMainFrame() != "/".equals(path)) return empty(403);
            if ("/native-ready".equals(path)) {
                post(() -> { readyRequested = true; connect(); });
                return empty(200);
            }
            if (path == null || !path.matches("/[a-z0-9.-]*") || path.contains("..")) return empty(403);
            String file = "/".equals(path) ? "index.html" : path.substring(1);
            String type;
            if ("/".equals(path)) type = "text/html";
            else if (file.endsWith(".js") || file.endsWith(".mjs")) type = "text/javascript";
            else if (file.endsWith(".css")) type = "text/css";
            else if (file.endsWith(".png")) type = "image/png";
            else if (file.endsWith(".webp")) type = "image/webp";
            else return empty(403);
            try { return response(200, type, assets.open("site/" + file)); }
            catch (IOException e) { return empty(403); }
        }
        @Override public void onPageFinished(WebView view, String url) {
            if (readyRequested) connect();
        }
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (request.isForMainFrame() && request.hasGesture() && url.getHost() != null
                    && !ORIGIN.getHost().equals(url.getHost())
                    && ("https".equals(url.getScheme()) || "http".equals(url.getScheme()))) {
                try { activity.startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)); }
                catch (ActivityNotFoundException e) { Toast.makeText(activity, "找不到能打开链接的浏览器", Toast.LENGTH_SHORT).show(); }
            }
            return true; // The embedded document is always the locally served app.
        }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            activity.recoverShell(AssistantShell.this);
            return true;
        }
    }
    private void connect() {
        if (closed || channel != null || !HOME.equals(getUrl())) return;
        WebMessagePort[] ports = createWebMessageChannel();
        channel = ports[0];
        channel.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort port, WebMessage message) {
                if (closed || channel != port) return;
                String data = message.getData();
                if (data == null || data.length() > 150000) return;
                try {
                    JSONObject item = new JSONObject(data);
                    if (item.has("event")) {
                        String event = item.optString("event");
                        if ("draft".equals(event)) activity.rememberDraft(AssistantShell.this, item);
                        if ("opened".equals(event) && item.optString("target").equals(pendingOpen)) pendingOpen = null;
                        if ("back".equals(event) && awaitingBack != 0 && item.optInt("serial") == awaitingBack) {
                            awaitingBack = 0;
                            if (!item.optBoolean("handled")) activity.finish();
                        }
                    } else if (item.optInt("id") > 0 && item.optJSONObject("body") != null) {
                        activity.onCommand(AssistantShell.this, item);
                    }
                } catch (JSONException ignored) { }
            }
        });
        postWebMessage(new WebMessage("asterhelm-android-v1", new WebMessagePort[]{ports[1]}), ORIGIN);
        if (pendingOpen != null) send("event", "open", "target", pendingOpen);
    }
    void open(String target) {
        pendingOpen = target;
        if (target != null) send("event", "open", "target", target);
    }
    String pendingOpen() { return pendingOpen; }
    void back() {
        if (channel == null) { activity.finish(); return; }
        if (awaitingBack != 0) return;
        final int serial = ++nextBack;
        awaitingBack = serial;
        send("event", "back", "serial", serial);
        postDelayed(() -> { if (!closed && awaitingBack == serial) activity.finish(); }, 1200);
    }
    void resumed() {
        onResume();
        send("event", "resume");
    }
    void send(Object... fields) {
        if (closed || channel == null) return;
        try { channel.postMessage(new WebMessage(Api.args(fields).toString())); }
        catch (JSONException | IllegalStateException ignored) { }
    }
    void closeShell() {
        closed = true;
        if (channel != null) { channel.close(); channel = null; }
        if (getParent() instanceof ViewGroup) ((ViewGroup)getParent()).removeView(this);
        destroy();
    }
}
