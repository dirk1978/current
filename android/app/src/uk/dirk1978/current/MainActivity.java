package uk.dirk1978.current;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowInsets;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Full-screen WebView around the bundled web UI (assets/web), drawn edge to edge under the system bars. */
public class MainActivity extends Activity {
    private WebView web;
    private int insetTop, insetBottom;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);

        web = new WebView(this);
        web.setBackgroundColor(0xff06080f);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setTextZoom(100); // the design is sized in px; ignore the system font scale
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i("Current", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) { pushInsets(); }
        });
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            float d = getResources().getDisplayMetrics().density;
            insetTop = Math.round(insets.getSystemWindowInsetTop() / d);
            insetBottom = Math.round(insets.getSystemWindowInsetBottom() / d);
            pushInsets();
            return insets;
        });
        setContentView(web);
        Servers.fromLink(this, getIntent().getData());
        load();
    }

    /** Opens the UI, handing it the saved server details (built-in ones reach it through config.js instead). */
    private void load() {
        String url = "file:///android_asset/web/index.html";
        String[] bases = Servers.bases(this);
        if (!Servers.builtIn() && bases.length > 0) {
            url += "#bases=" + Uri.encode(String.join(",", bases)) + "&key=" + Uri.encode(Servers.key(this));
        }
        web.loadUrl(url);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // scanned a connect QR code while the app was open
        if (Servers.fromLink(this, intent.getData())) {
            load();
            sendBroadcast(new Intent(Widget.ACTION_REFRESH).setClass(this, Widget.class));
        }
    }

    private void pushInsets() {
        web.evaluateJavascript("(function(r){if(!r)return;r.style.setProperty('--safe-top','" + insetTop + "px');"
                + "r.style.setProperty('--safe-bottom','" + insetBottom + "px');})(document.documentElement)", null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.evaluateJavascript("window.CurrentApp && CurrentApp.refresh()", null);
    }

    @Override
    protected void onPause() {
        web.onPause();
        // keep the home-screen widget in step with what was just seen
        sendBroadcast(new Intent(Widget.ACTION_REFRESH).setClass(this, Widget.class));
        super.onPause();
    }

    class Bridge {
        @JavascriptInterface
        public void saveConfig(String bases, String key) {
            Servers.save(MainActivity.this, bases, key);
            sendBroadcast(new Intent(Widget.ACTION_REFRESH).setClass(MainActivity.this, Widget.class));
        }

        @JavascriptInterface
        public void haptic() {
            web.post(() -> web.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK));
        }
    }
}
