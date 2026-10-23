package com.vodbox.downloader;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 界面容器：启动前台服务（内部跑本地 Node 服务），再用 WebView 打开 127.0.0.1。
 *
 * 关键点（都是踩过的坑）：
 *  - Node 与保存任务都放在 DownloadService 里，Activity 被销毁/切后台不影响下载；
 *  - WebChromeClient 必须设置，否则页面里的 alert/confirm 会静默失效；
 *  - 任何 IO 都不能在 UI 线程碰 WebView，否则抛
 *    "A WebView method was called on thread ..."；
 *  - assets 里的前端代码只在首次安装时拷贝，升级 APK 后必须按版本号重新拷贝，
 *    否则用户看到的还是旧界面。
 */
public class MainActivity extends Activity {

    private static final String TAG = "VodMain";
    private static final int PORT = 8787;
    private static final String PROJECT = "nodejs-project";
    /** 改动 assets/nodejs-project 里的任何文件后，把这个数字 +1，升级时才会覆盖旧文件 */
    private static final int ASSET_VERSION = 4;

    private WebView webView;
    private LinearLayout splash;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
            }
        }

        copyProjectIfNeeded();
        DownloadService.start(this);
        waitAndLoad();
    }

    // ---------------------------------------------------------------- UI
    private void buildUi() {
        FrameLayout root = new FrameLayout(this);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFFF5F6FA);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        // 固定字体缩放：系统调大字体时页面不会错位
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, "console: " + cm.message() + " @" + cm.lineNumber());
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                // 回调在 UI 线程：这里只做转发，真正的 IO 交给前台服务
                String name = DownloadService.parseFileName(contentDisposition);
                DownloadService svc = DownloadService.get();
                if (svc != null) {
                    svc.enqueueSave(url, name);
                } else {
                    DownloadService.start(MainActivity.this);
                    Toast.makeText(MainActivity.this, "服务启动中，请稍后重试", Toast.LENGTH_SHORT).show();
                }
            }
        });

        webView.addJavascriptInterface(new Bridge(), "VodApp");
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 启动遮罩
        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(android.view.Gravity.CENTER);
        splash.setBackgroundColor(0xFFF5F6FA);
        ProgressBar pb = new ProgressBar(this);
        TextView tv = new TextView(this);
        tv.setText("正在启动本地服务…");
        tv.setTextColor(0xFF6B7280);
        tv.setTextSize(13);
        tv.setPadding(0, 28, 0, 0);
        splash.addView(pb);
        splash.addView(tv);
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private void hideSplash() {
        if (splash == null) return;
        splash.animate().alpha(0f).setDuration(220).withEndAction(() -> {
            if (splash != null) splash.setVisibility(View.GONE);
        }).start();
    }

    // ---------------------------------------------------------------- 启动流程
    private void waitAndLoad() {
        new Thread(() -> {
            boolean ok = false;
            for (int i = 0; i < 40; i++) {
                if (ping()) {
                    ok = true;
                    break;
                }
                try {
                    Thread.sleep(500);
                } catch (InterruptedException ignored) {
                }
            }
            final boolean ready = ok;
            main.post(() -> {
                if (ready) {
                    webView.loadUrl("http://127.0.0.1:" + PORT + "/");
                } else {
                    if (splash != null) splash.setVisibility(View.GONE);
                    Toast.makeText(MainActivity.this, "本地服务启动失败，请重启应用", Toast.LENGTH_LONG).show();
                }
            });
        }, "wait-node").start();
    }

    private boolean ping() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + "/api/health").openConnection();
            c.setConnectTimeout(600);
            c.setReadTimeout(800);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ---------------------------------------------------------------- 资源拷贝
    private void copyProjectIfNeeded() {
        File dest = new File(getFilesDir(), PROJECT);
        File verFile = new File(dest, ".asset_version");
        if (dest.isDirectory() && new File(dest, "main.js").isFile() && readVersion(verFile) == ASSET_VERSION) {
            return;
        }
        try {
            // 只清理代码文件，保留 downloads / data / cache（用户已下载的内容和任务状态）
            File[] kids = dest.listFiles();
            if (kids != null) {
                for (File k : kids) {
                    String n = k.getName();
                    if (n.equals("downloads") || n.equals("data") || n.equals("cache")) continue;
                    deleteRecursive(k);
                }
            }
            dest.mkdirs();
            copyAssetFolder(getAssets(), PROJECT, dest.getAbsolutePath());
            writeVersion(verFile);
        } catch (IOException e) {
            Log.e(TAG, "copy assets failed", e);
        }
    }

    private static int readVersion(File f) {
        try {
            InputStream in = new java.io.FileInputStream(f);
            byte[] b = new byte[16];
            int n = in.read(b);
            in.close();
            return Integer.parseInt(new String(b, 0, Math.max(0, n)).trim());
        } catch (Throwable e) {
            return -1;
        }
    }

    private static void writeVersion(File f) {
        try {
            OutputStream out = new FileOutputStream(f);
            out.write(String.valueOf(ASSET_VERSION).getBytes("UTF-8"));
            out.close();
        } catch (Throwable ignored) {
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static boolean copyAssetFolder(AssetManager am, String from, String to) throws IOException {
        String[] files = am.list(from);
        if (files == null || files.length == 0) {
            return copyAsset(am, from, to);
        }
        File dir = new File(to);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed: " + to);
        boolean res = true;
        for (String f : files) {
            res &= copyAssetFolder(am, from + "/" + f, to + "/" + f);
        }
        return res;
    }

    private static boolean copyAsset(AssetManager am, String from, String to) throws IOException {
        InputStream in = am.open(from);
        File parent = new File(to).getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        OutputStream out = new FileOutputStream(to);
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        in.close();
        out.close();
        return true;
    }

    // ---------------------------------------------------------------- JS 桥
    public class Bridge {
        /** 页面里点「保存」时调用；url 可能是相对路径 */
        @JavascriptInterface
        public void save(String url, String name) {
            String abs = url;
            if (abs != null && abs.startsWith("/")) abs = "http://127.0.0.1:" + PORT + abs;
            DownloadService svc = DownloadService.get();
            if (svc != null) {
                svc.enqueueSave(abs, name);
            } else {
                DownloadService.start(MainActivity.this);
            }
        }

        @JavascriptInterface
        public void toast(String msg) {
            main.post(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String version() {
            return "2.0.0";
        }
    }

    // ---------------------------------------------------------------- 生命周期
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        // 只回收 WebView，服务继续在后台跑（下载不会因为退出界面而中断）
        try {
            if (webView != null) {
                ViewGroup p = (ViewGroup) webView.getParent();
                if (p != null) p.removeView(webView);
                webView.destroy();
                webView = null;
            }
        } catch (Throwable e) {
            Log.w(TAG, "destroy webview: " + e.getMessage());
        }
        super.onDestroy();
    }
}
