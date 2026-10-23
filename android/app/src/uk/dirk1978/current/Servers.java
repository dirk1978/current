package uk.dirk1978.current;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

/**
 * Where the server is and the access key. Personal builds have them built in (Config, from .env at build time);
 * the published app gets them from a current://connect link (the QR code on the server's web page) or the setup
 * screen, and keeps them here so the widget can use them too.
 */
final class Servers {
    private Servers() { }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("server", Context.MODE_PRIVATE);
    }

    static boolean builtIn() { return Config.KEY.length() > 0; }

    static String[] bases(Context c) {
        if (builtIn()) return Config.BASES;
        String s = prefs(c).getString("bases", "");
        return s.isEmpty() ? new String[0] : s.split(",");
    }

    static String key(Context c) {
        return builtIn() ? Config.KEY : prefs(c).getString("key", "");
    }

    static void save(Context c, String bases, String key) {
        if (builtIn() || bases == null || key == null || bases.isEmpty() || key.isEmpty()) return;
        prefs(c).edit().putString("bases", bases).putString("key", key).apply();
    }

    /** Saves the details from a current://connect?bases=...&key=... link; returns whether it was one. */
    static boolean fromLink(Context c, Uri u) {
        if (u == null || !"current".equals(u.getScheme()) || !"connect".equals(u.getHost())) return false;
        save(c, u.getQueryParameter("bases"), u.getQueryParameter("key"));
        return true;
    }
}
