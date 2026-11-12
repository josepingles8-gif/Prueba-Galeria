package com.galeria.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends ComponentActivity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int DARK_BG = 0xFF0D0E10;
    private static final int LIGHT_BG = 0xFFF5F6F8;

    private FrameLayout root;
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;
    private ActivityResultLauncher<String> storagePermissionLauncher;
    private AndroidBridge bridge;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        boolean night = (getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        int bg = night ? DARK_BG : LIGHT_BG;

        root = new FrameLayout(this);
        root.setBackgroundColor(bg);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        webView = new WebView(this);
        webView.setBackgroundColor(bg);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyBars(night);

        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(), result -> {
                    ValueCallback<Uri[]> cb = filePathCallback;
                    filePathCallback = null;
                    if (cb == null) return;
                    Uri[] uris = null;
                    Intent data = result.getData();
                    if (result.getResultCode() == RESULT_OK && data != null) {
                        if (data.getClipData() != null) {
                            int n = data.getClipData().getItemCount();
                            uris = new Uri[n];
                            for (int i = 0; i < n; i++) {
                                uris[i] = data.getClipData().getItemAt(i).getUri();
                            }
                        } else if (data.getData() != null) {
                            uris = new Uri[]{data.getData()};
                        }
                    }
                    cb.onReceiveValue(uris);
                });

        bridge = new AndroidBridge(this);
        storagePermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestPermission(),
                granted -> bridge.onStoragePermissionResult(granted));

        configureWebView();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (customView != null) {
                    hideCustomView();
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){try{return !!(window.__galleryCanGoBack ? window.__galleryCanGoBack() : history.length>1);}catch(e){return false;}})()",
                        value -> {
                            if ("true".equals(value)) {
                                webView.evaluateJavascript("history.back()", null);
                            } else {
                                finish();
                            }
                        });
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView() {
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", path -> {
                    String p = path.isEmpty() || path.equals("/") ? "index.html" : path;
                    try {
                        java.io.InputStream in = getAssets().open("www/" + p);
                        return new WebResourceResponse(mimeFor(p), "UTF-8", in);
                    } catch (java.io.IOException e) {
                        return null;
                    }
                })
                .build();

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);

        webView.addJavascriptInterface(bridge, "AndroidBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    fileChooserLauncher.launch(Intent.createChooser(intent, null));
                } catch (Exception e) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                view.setBackgroundColor(Color.BLACK);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                WindowInsetsControllerCompat c =
                        WindowCompat.getInsetsController(getWindow(), root);
                c.hide(WindowInsetsCompat.Type.systemBars());
                c.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }
        });
    }

    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        webView.setVisibility(View.VISIBLE);
        WindowCompat.getInsetsController(getWindow(), root)
                .show(WindowInsetsCompat.Type.systemBars());
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
    }

    static String mimeFor(String path) {
        String p = path.toLowerCase(java.util.Locale.ROOT);
        int q = p.indexOf('?');
        if (q >= 0) p = p.substring(0, q);
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /** Debe llamarse en el hilo de UI. */
    void applyTheme(boolean isDark) {
        int bg = isDark ? DARK_BG : LIGHT_BG;
        root.setBackgroundColor(bg);
        webView.setBackgroundColor(bg);
        getWindow().getDecorView().setBackgroundColor(bg);
        applyBars(isDark);
    }

    @SuppressWarnings("deprecation")
    private void applyBars(boolean isDark) {
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), root);
        c.setAppearanceLightStatusBars(!isDark);
        c.setAppearanceLightNavigationBars(!isDark);
    }

    void requestStoragePermission() {
        runOnUiThread(() -> storagePermissionLauncher.launch(
                android.Manifest.permission.WRITE_EXTERNAL_STORAGE));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (isFinishing()) bridge.cleanup();
        root.removeAllViews();
        webView.destroy();
        super.onDestroy();
    }
}
