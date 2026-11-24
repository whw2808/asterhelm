package dev.asterhelm.android;

import android.content.Context;
import org.json.JSONObject;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

final class Api {
    static class Failure extends IOException {
        final int status;
        Failure(int status, String message) { super(message); this.status = status; }
    }
    static JSONObject args(Object... kv) throws org.json.JSONException {
        JSONObject object = new JSONObject();
        for (int i = 0; i < kv.length; i += 2) object.put((String)kv[i], kv[i+1]);
        return object;
    }
    static JSONObject call(Context c, String op, JSONObject input) throws Exception {
        HttpsURLConnection con = (HttpsURLConnection)new URL(BuildConfig.PUBLIC_ORIGIN + "/api/" + op).openConnection();
        con.setInstanceFollowRedirects(false);
        con.setUseCaches(false);
        con.setRequestMethod("POST");
        con.setConnectTimeout(12000);
        con.setReadTimeout(20000 + Math.max(0, input.optInt("waitMs")));
        con.setRequestProperty("Content-Type", "application/json");
        con.setRequestProperty("Accept", "application/json");
        con.setDoOutput(true);
        try {
            if (!op.equals("pair")) {
                String credential = Vault.read(c, "credential");
                if (credential.isEmpty()) throw new Failure(401, "请先配对");
                con.setRequestProperty("Cookie", "__Host-sa=" + credential);
            }
            byte[] body = input.toString().getBytes(StandardCharsets.UTF_8);
            con.setFixedLengthStreamingMode(body.length);
            try (OutputStream stream = con.getOutputStream()) { stream.write(body); }
            int status = con.getResponseCode();
            JSONObject reply;
            try (InputStream stream = status >= 400 ? con.getErrorStream() : con.getInputStream()) {
                if (stream == null) throw new Failure(status, "服务暂时无法连接");
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int n;
                while ((n = stream.read(chunk)) != -1) {
                    if (output.size() + n > 8 * 1024 * 1024) throw new IOException("返回的数据过大");
                    output.write(chunk, 0, n);
                }
                try { reply = new JSONObject(output.toString("UTF-8")); }
                catch (org.json.JSONException e) { throw new Failure(status, "暂时无法连接到 Asterhelm（HTTP " + status + "）"); }
            }
            if (status != 200 || reply.has("error")) {
                throw new Failure(status, reply.optString("error", "请求失败（HTTP " + status + "）"));
            }
            if (op.equals("pair")) {
                for (Map.Entry<String,List<String>> header : con.getHeaderFields().entrySet()) {
                    if (!"Set-Cookie".equalsIgnoreCase(header.getKey())) continue;
                    for (String value : header.getValue()) {
                        String first = value.split(";",2)[0];
                        if (first.matches("__Host-sa=[A-Za-z0-9_-]{43}")) {
                            long pairedAt = con.getHeaderFieldDate("Date", System.currentTimeMillis());
                            Vault.prefs(c).edit().putLong("pairedAt", pairedAt).commit();
                            Vault.write(c, "credential", first.substring("__Host-sa=".length()));
                            return reply;
                        }
                    }
                }
                throw new IOException("服务器没有返回配对凭据");
            }
            JSONObject value = reply.optJSONObject("value");
            return value == null ? reply : value;
        } finally { con.disconnect(); }
    }
}
