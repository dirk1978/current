package uk.dirk1978.current;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.SystemClock;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Home-screen widget: grid mix ring with carbon intensity, power in use now, today's cost and the car.
 * Drawn as one bitmap so it can look like the app. Refreshes every 15 minutes and whenever the app closes.
 */
public class Widget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "uk.dirk1978.current.REFRESH";
    private static final String[] FUELS = {"wind", "solar", "nuclear", "gas", "hydro", "biomass", "imports", "other"};
    private static final int[] FUEL_COLOURS = {0xff00a99c, 0xffbe8700, 0xff8968d4, 0xffd95737, 0xff1f7dcf, 0xff499537, 0xffd162a5, 0xff5a616c};
    private static final int INK = 0xfff2f4f8, INK2 = 0xffb4bccb, INK3 = 0xff7a8396;
    private static final int GOOD = 0xff34d399, WARN = 0xfffbbf24, BAD = 0xfff87171, ELEC = 0xff3fb6ff, CAR = 0xff8f7cff;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        schedule(ctx);
        refresh(ctx);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle o) {
        refresh(ctx);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (ACTION_REFRESH.equals(intent.getAction())) refresh(ctx);
        else super.onReceive(ctx, intent);
    }

    @Override
    public void onDisabled(Context ctx) {
        ((AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE)).cancel(alarmIntent(ctx));
    }

    private static PendingIntent alarmIntent(Context ctx) {
        return PendingIntent.getBroadcast(ctx, 1, new Intent(ACTION_REFRESH).setClass(ctx, Widget.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                AlarmManager.INTERVAL_FIFTEEN_MINUTES, alarmIntent(ctx));
    }

    private void refresh(Context ctx) {
        final PendingResult pr = goAsync();
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try {
                JSONObject data = null;
                try { data = fetch(app); } catch (Exception ignored) { }
                SharedPreferences prefs = app.getSharedPreferences("widget", Context.MODE_PRIVATE);
                if (data != null) prefs.edit().putString("last", data.toString()).apply();
                else {
                    String last = prefs.getString("last", null);
                    if (last != null) data = new JSONObject(last);
                }
                AppWidgetManager mgr = AppWidgetManager.getInstance(app);
                for (int id : mgr.getAppWidgetIds(new ComponentName(app, Widget.class))) {
                    RemoteViews rv = new RemoteViews(app.getPackageName(), R.layout.widget);
                    rv.setImageViewBitmap(R.id.img, draw(app, mgr.getAppWidgetOptions(id), data));
                    Intent open = new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    rv.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(app, 0, open, PendingIntent.FLAG_IMMUTABLE));
                    mgr.updateAppWidget(id, rv);
                }
            } catch (Exception ignored) {
            } finally {
                pr.finish();
            }
        }).start();
    }

    /** Tries each configured server (internet first, then LAN). */
    private static JSONObject fetch(Context ctx) throws Exception {
        Exception last = null;
        for (String base : Servers.bases(ctx)) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/all").openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(12000);
                c.setRequestProperty("Authorization", "Bearer " + Servers.key(ctx));
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                InputStream in = c.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                in.close();
                return new JSONObject(out.toString("UTF-8"));
            } catch (Exception e) {
                last = e;
            }
        }
        throw last != null ? last : new Exception("no server set up yet");
    }

    private static Typeface font(Context ctx, int weight) {
        try {
            return Typeface.create(Typeface.createFromAsset(ctx.getAssets(), "fonts/manrope.ttf"), weight, false);
        } catch (Exception e) {
            return Typeface.create(Typeface.SANS_SERIF, weight, false);
        }
    }

    private static Bitmap draw(Context ctx, Bundle opts, JSONObject d) {
        float dens = ctx.getResources().getDisplayMetrics().density;
        int wDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250);
        int hDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110);
        if (wDp < 100) wDp = 250;
        if (hDp < 60) hDp = 110;
        float sc = Math.min(dens, 1400f / wDp); // keep the bitmap within RemoteViews' memory limit
        int W = Math.round(wDp * sc), H = Math.round(hDp * sc);
        Bitmap bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        float u = sc; // 1dp
        RectF all = new RectF(0, 0, W, H);
        float rad = 24 * u;

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setShader(new LinearGradient(0, 0, W, H, 0xff0e1424, 0xff06080f, Shader.TileMode.CLAMP));
        c.drawRoundRect(all, rad, rad, p);

        JSONObject grid = d == null ? null : d.optJSONObject("grid");
        JSONObject now = grid == null ? null : grid.optJSONObject("now");
        JSONObject home = d == null ? null : d.optJSONObject("home");
        JSONObject car = d == null ? null : d.optJSONObject("car");

        int carbon = -1;
        if (now != null && now.optJSONObject("carbon") != null) carbon = now.optJSONObject("carbon").optInt("value", -1);
        int status = carbon < 0 ? INK3 : carbon < 120 ? GOOD : carbon < 200 ? WARN : BAD;
        String statusLabel = carbon < 0 ? "" : carbon < 40 ? "VERY LOW" : carbon < 120 ? "LOW" : carbon < 200 ? "MODERATE" : carbon < 290 ? "HIGH" : "VERY HIGH";

        // Glow tinted by the grid's carbon status
        p.setShader(new RadialGradient(H * 0.5f, H * 0.5f, H * 0.95f, Color.argb(70, Color.red(status), Color.green(status), Color.blue(status)), 0, Shader.TileMode.CLAMP));
        c.drawRoundRect(all, rad, rad, p);
        p.setShader(null);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(1 * u);
        p.setColor(0x14ffffff);
        RectF inset = new RectF(0.5f * u, 0.5f * u, W - 0.5f * u, H - 0.5f * u);
        c.drawRoundRect(inset, rad, rad, p);

        // ---- Ring
        float pad = 14 * u;
        float ringD = H - 2 * pad;
        float cx = pad + ringD / 2, cy = H / 2f;
        float stroke = Math.max(5 * u, ringD * 0.075f);
        RectF ring = new RectF(cx - ringD / 2 + stroke / 2, cy - ringD / 2 + stroke / 2, cx + ringD / 2 - stroke / 2, cy + ringD / 2 - stroke / 2);
        p.setStrokeWidth(stroke);
        p.setColor(0x0dffffff);
        c.drawArc(ring, 0, 360, false, p);
        if (now != null && now.optJSONObject("mix") != null) {
            JSONObject mix = now.optJSONObject("mix");
            double total = 0;
            for (String f : FUELS) total += Math.max(0, mix.optDouble(f, 0));
            float start = -90, gap = 2.2f;
            for (int i = 0; i < FUELS.length; i++) {
                float sweep = (float) (Math.max(0, mix.optDouble(FUELS[i], 0)) / total * 360);
                if (sweep > gap + 0.5f) {
                    p.setColor(FUEL_COLOURS[i]);
                    c.drawArc(ring, start + gap / 2, sweep - gap, false, p);
                }
                start += sweep;
            }
        }
        p.setStyle(Paint.Style.FILL);
        p.setTextAlign(Paint.Align.CENTER);
        p.setTypeface(font(ctx, 700));
        p.setColor(INK);
        float big = ringD * 0.3f;
        p.setTextSize(big);
        c.drawText(carbon < 0 ? "–" : String.valueOf(carbon), cx, cy + big * 0.22f, p);
        p.setTypeface(font(ctx, 700));
        p.setTextSize(Math.max(7 * u, ringD * 0.075f));
        p.setLetterSpacing(0.08f);
        p.setColor(status);
        c.drawText(statusLabel, cx, cy + big * 0.22f + ringD * 0.15f, p);
        p.setColor(INK3);
        c.drawText("gCO₂/kWh", cx, cy - big * 0.62f, p);
        p.setLetterSpacing(0);

        // ---- Right side
        float x = pad + ringD + 16 * u;
        float right = W - pad;
        if (right - x < 80 * u) return bmp;
        p.setTextAlign(Paint.Align.LEFT);

        JSONObject live = home == null ? null : home.optJSONObject("live");
        JSONObject tariff = home == null ? null : home.optJSONObject("tariff");
        boolean offPeak = tariff != null && tariff.optBoolean("offPeakNow");
        int rateColour = offPeak ? GOOD : ELEC;
        double watts = live == null ? -1 : live.optDouble("w", -1);

        float y = pad + 10 * u;
        label(c, p, ctx, "USING NOW", x, y, u, rateColour);
        float valueSize = Math.min(30 * u, H * 0.24f);
        y += valueSize + 2 * u;
        p.setTypeface(font(ctx, 700));
        p.setTextSize(valueSize);
        p.setColor(INK);
        String val = watts < 0 ? "–" : watts >= 1000 ? String.format(Locale.UK, "%.2f", watts / 1000) : String.valueOf(Math.round(watts));
        c.drawText(val, x, y, p);
        float vw = p.measureText(val);
        p.setTextSize(valueSize * 0.42f);
        p.setColor(INK2);
        String unit = watts >= 1000 ? " kW" : " W";
        c.drawText(unit, x + vw, y, p);
        if (tariff != null && watts >= 0) {
            double rate = tariff.optDouble("rateNow", 0);
            String cost = Math.round(watts / 1000 * rate) + "p/h · " + (offPeak ? "off-peak" : "peak");
            float uw = p.measureText(unit);
            p.setTypeface(font(ctx, 600));
            p.setTextSize(Math.max(9 * u, valueSize * 0.36f));
            p.setColor(rateColour);
            float cw = p.measureText(cost);
            if (x + vw + uw + 10 * u + cw < right) c.drawText(cost, x + vw + uw + 10 * u, y, p);
        }

        // Today's cost
        JSONObject today = home == null ? null : home.optJSONObject("today");
        float small = Math.max(10 * u, Math.min(13 * u, H * 0.105f));
        if (today != null && H > 95 * u) {
            y += small + 10 * u;
            p.setTypeface(font(ctx, 600));
            p.setTextSize(small);
            float xx = x;
            xx = dotText(c, p, "£" + String.format(Locale.UK, "%.2f", today.optInt("elecP") / 100.0), xx, y, ELEC, u, INK);
            xx = dotText(c, p, "£" + String.format(Locale.UK, "%.2f", today.optInt("gasP") / 100.0), xx + 12 * u, y, 0xffff8a4c, u, INK);
            p.setColor(INK3);
            String tl = "today";
            if (xx + 8 * u + p.measureText(tl) < right) c.drawText(tl, xx + 8 * u, y, p);
        }

        // Car
        if (car != null && car.has("status") && H > 120 * u) {
            y += small + 10 * u;
            String st = car.optString("status");
            String stLabel = "charging".equals(st) ? "Charging " + String.format(Locale.UK, "%.1f kW", car.optDouble("watts", 0) / 1000)
                    : "plugged".equals(st) ? "Plugged in" : "finished".equals(st) ? "Charged" : "paused".equals(st) ? "Paused" : "Unplugged";
            int soc = car.isNull("soc") ? -1 : car.optInt("soc", -1);
            p.setTypeface(font(ctx, 600));
            p.setTextSize(small);
            float barW = 34 * u, barH = small * 0.62f;
            RectF bar = new RectF(x, y - barH, x + barW, y);
            p.setColor(0x1affffff);
            c.drawRoundRect(bar, barH / 2, barH / 2, p);
            if (soc >= 0) {
                p.setColor(CAR);
                c.drawRoundRect(new RectF(x, y - barH, x + barW * soc / 100f, y), barH / 2, barH / 2, p);
            }
            p.setColor(INK);
            String t = soc >= 0 ? soc + "%  " : "";
            c.drawText(t, x + barW + 8 * u, y, p);
            p.setColor(INK3);
            c.drawText(stLabel, x + barW + 8 * u + p.measureText(t), y, p);
        }

        // Updated time
        p.setTypeface(font(ctx, 600));
        p.setTextSize(Math.max(8 * u, 9 * u));
        p.setColor(INK3);
        p.setTextAlign(Paint.Align.RIGHT);
        String upd = d == null ? "no connection" : new SimpleDateFormat("HH:mm", Locale.UK).format(new Date(d.optLong("serverTime")));
        c.drawText(upd, right, pad + 8 * u, p);
        return bmp;
    }

    private static void label(Canvas c, Paint p, Context ctx, String s, float x, float y, float u, int dot) {
        p.setColor(dot);
        c.drawCircle(x + 3 * u, y - 3.5f * u, 3 * u, p);
        p.setTypeface(font(ctx, 700));
        p.setTextSize(9 * u);
        p.setLetterSpacing(0.14f);
        p.setColor(INK3);
        c.drawText(s, x + 11 * u, y, p);
        p.setLetterSpacing(0);
    }

    private static float dotText(Canvas c, Paint p, String s, float x, float y, int dot, float u, int ink) {
        p.setColor(dot);
        c.drawCircle(x + 3.5f * u, y - p.getTextSize() * 0.36f, 3.5f * u, p);
        p.setColor(ink);
        c.drawText(s, x + 11 * u, y, p);
        return x + 11 * u + p.measureText(s);
    }
}
