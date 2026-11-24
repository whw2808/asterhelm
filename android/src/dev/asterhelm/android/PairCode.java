package dev.asterhelm.android;

import java.net.URI;
import java.util.regex.Pattern;

final class PairCode {
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");

    static String parse(String raw, String trustedOrigin) {
        if (raw == null) return null;
        String input = raw.trim();
        if (TOKEN.matcher(input).matches()) return input;
        try {
            URI link = URI.create(input);
            URI origin = URI.create(trustedOrigin);
            String argument;
            if ("https".equalsIgnoreCase(link.getScheme()) && link.getHost() != null
                    && link.getRawUserInfo() == null && !link.getRawAuthority().endsWith(":")
                    && origin.getHost().equalsIgnoreCase(link.getHost())
                    && httpsPort(origin) == httpsPort(link)
                    && "/".equals(link.getRawPath()) && link.getRawQuery() == null) {
                argument = link.getRawFragment();
            } else if ("asterhelm".equals(link.getScheme()) && "pair".equals(link.getRawAuthority())
                    && "".equals(link.getRawPath()) && link.getRawFragment() == null) {
                argument = link.getRawQuery();
            } else {
                return null;
            }
            if (argument != null && argument.startsWith("t=")) {
                String token = argument.substring(2);
                if (TOKEN.matcher(token).matches()) return token;
            }
        } catch (IllegalArgumentException ignored) { }
        return null;
    }

    private static int httpsPort(URI uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
    }
}
