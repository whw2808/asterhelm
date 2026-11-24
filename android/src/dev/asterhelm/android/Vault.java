package dev.asterhelm.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class Vault {
    private static final String ALIAS = "asterhelm-vault-v1";
    // An update built for a different server must establish a separate pairing.

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(BuildConfig.PREFERENCES, Context.MODE_PRIVATE);
    }
    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        SecretKey found = (SecretKey) ks.getKey(ALIAS, null);
        if (found != null) return found;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    static synchronized String read(Context c, String slot) throws Exception {
        String stored = prefs(c).getString(slot, "");
        if (stored.isEmpty()) return "";
        String[] fields = stored.split("\\.", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(fields[0], Base64.NO_WRAP)));
        cipher.updateAAD(slot.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(fields[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
    static synchronized void write(Context c, String slot, String value) throws Exception {
        if (value.isEmpty()) {
            prefs(c).edit().remove(slot).commit();
            return;
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(slot.getBytes(StandardCharsets.UTF_8));
        byte[] bytes = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(bytes, Base64.NO_WRAP);
        if (!prefs(c).edit().putString(slot, stored).commit()) throw new IllegalStateException("无法保存手机状态");
    }
    static boolean paired(Context c) { return prefs(c).contains("credential"); }
}
