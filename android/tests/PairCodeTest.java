package dev.asterhelm.android;

import java.util.Base64;

public final class PairCodeTest {
    public static void main(String[] args) {
        String origin = "https://assistant.example.test";
        String portOrigin = origin + ":8443";
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
        String fragment = "/#t=" + token;

        for (String input : new String[]{token, "  " + token + "  ", origin + fragment,
                origin.toUpperCase(java.util.Locale.ROOT) + ":443" + fragment, "asterhelm://pair?t=" + token}) {
            if (!token.equals(PairCode.parse(input, origin))) throw new AssertionError("Expected valid input");
        }
        if (!token.equals(PairCode.parse(portOrigin + fragment, portOrigin))) {
            throw new AssertionError("Expected configured nonstandard HTTPS port");
        }
        for (String input : new String[]{null, "", "http://assistant.example.test" + fragment,
                origin + "/?t=" + token, "https://other.example.test" + fragment, portOrigin + fragment,
                origin + ":" + fragment, "https://reader@assistant.example.test" + fragment,
                origin + "@other.example.test" + fragment, origin + "/%2f#t=" + token,
                origin + "/#t=x", "asterhelm://wrong?t=" + token, "asterhelm://pair/?t=" + token,
                origin + fragment + "&t=" + token, "asterhelm://pair?t=" + token + "#fragment"}) {
            if (PairCode.parse(input, origin) != null) throw new AssertionError("Expected invalid input");
        }
        System.out.println("Pairing URL and token checks passed.");
    }
}
