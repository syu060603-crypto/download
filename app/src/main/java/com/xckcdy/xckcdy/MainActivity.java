package com.xckcdy.xckcdy;

import android.app.Activity;
import android.content.ContentValues;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.app.AlertDialog;
import android.util.Log;
import android.webkit.DownloadListener;
import android.webkit.JsResult;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;

/**
 * 启动 nodejs-mobile 运行时（内部跑我们现有的服务端 server.js），
 * 再用 WebView 加载 http://127.0.0.1:8787 提供的网页界面。
 * 服务端在手机本地，不依赖任何外部服务器或电脑。
 */
public class MainActivity extends Activity {
    private static final int PORT = 8787;
    private static final String PROJECT = "nodejs-project";

    private WebView webView;

    static {
        System.loadLibrary("xckcdy");
    }

    // 由 native-lib.cpp 提供：拉起 Node 运行时
    public native int startNodeWithArguments(String[] arguments);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.getSettings().setUseWideViewPort(true);
        webView.setWebViewClient(new WebViewClient());
        // 关键：不设置 WebChromeClient 时，网页里的 confirm()/alert() 会静默失效
        // （confirm 直接返回 false），导致「批量下载」在点确认前就被 return 中断。
        // 这里用原生对话框承接 JS 的 alert/confirm，并把 console 日志输出到 logcat。
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d("XckcdyWebView", "console: " + cm.message() + " (" + cm.sourceId() + ":" + cm.lineNumber() + ")");
                return true;
            }
        });
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                // DownloadListener 在 UI 线程回调：在这里取好 UA（回调自带 userAgent 参数），
                // 后台线程只做 IO，绝不触碰 WebView —— 否则抛
                // "A WebView method was called on thread ..." 导致保存失败。
                final String ua = (userAgent != null && !userAgent.isEmpty())
                        ? userAgent : webView.getSettings().getUserAgentString();
                new Thread(() -> saveToDownloads(url, ua)).start();
            }
        });
        setContentView(webView);

        copyProject();
        startNode();
        waitAndLoad();
    }

    private void startNode() {
        new Thread(() -> {
            File projDir = new File(getFilesDir(), PROJECT);
            File mainJs = new File(projDir, "main.js");
            startNodeWithArguments(new String[]{"node", mainJs.getAbsolutePath()});
        }).start();
    }

    private void waitAndLoad() {
        new Thread(() -> {
            boolean ok = false;
            for (int i = 0; i < 60; i++) {
                if (ping()) {
                    ok = true;
                    break;
                }
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ignored) {
                }
            }
            final boolean ready = ok;
            runOnUiThread(() -> {
                if (ready) {
                    webView.loadUrl("http://127.0.0.1:" + PORT + "/");
                } else {
                    Toast.makeText(MainActivity.this, "服务启动失败，请查看日志", Toast.LENGTH_LONG).show();
                }
            });
        }).start();
    }

    private boolean ping() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + "/")
                    .openConnection();
            c.setConnectTimeout(800);
            c.setReadTimeout(800);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    /** 首次启动把 assets/nodejs-project 拷到可写目录（APK 内的 assets 只读） */
    private void copyProject() {
        File dest = new File(getFilesDir(), PROJECT);
        if (dest.listFiles() != null && dest.listFiles().length > 0) {
            return; // 已拷贝过，跳过
        }
        try {
            copyAssetFolder(getAssets(), PROJECT, dest.getAbsolutePath());
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    private static boolean copyAssetFolder(AssetManager am, String from, String to) throws IOException {
        String[] files = am.list(from);
        if (files == null || files.length == 0) {
            return copyAsset(am, from, to);
        }
        new File(to).mkdirs();
        boolean res = true;
        for (String f : files) {
            res &= copyAssetFolder(am, from + "/" + f, to + "/" + f);
        }
        return res;
    }

    private static boolean copyAsset(AssetManager am, String from, String to) throws IOException {
        InputStream in = am.open(from);
        new File(to).getParentFile().mkdirs();
        OutputStream out = new FileOutputStream(to);
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        in.close();
        out.close();
        return true;
    }

    /** 把前端「保存到本机」的 localhost 下载请求落盘到系统下载目录（仅做 IO，禁止碰 WebView） */
    private void saveToDownloads(String urlStr, String userAgent) {
        try {
            URL u = new URL(urlStr);
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            c.setRequestProperty("User-Agent", userAgent);
            c.connect();

            String cd = c.getHeaderField("Content-Disposition");
            String name = "xckcdy_" + System.currentTimeMillis() + ".ts";
            if (cd != null) {
                int i = cd.indexOf("filename*=UTF-8''");
                if (i >= 0) {
                    name = URLDecoder.decode(cd.substring(i + "filename*=UTF-8''".length()).trim(), "UTF-8");
                }
            }

            InputStream in = c.getInputStream();
            OutputStream out;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/xckcdy");
                v.put(MediaStore.Downloads.MIME_TYPE, "video/mp2t");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                out = getContentResolver().openOutputStream(uri);
            } else {
                File f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        "xckcdy/" + name);
                f.getParentFile().mkdirs();
                out = new FileOutputStream(f);
            }

            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            in.close();
            out.close();
            final String savedName = name;
            runOnUiThread(() -> Toast.makeText(this, "已保存到 下载/xckcdy/" + savedName, Toast.LENGTH_SHORT).show());
        } catch (Throwable e) {
            // 注意：WebView 内部抛的是裸 Throwable（不是 Exception），必须按 Throwable 接住，
            // 否则线程直接死掉、看不到任何提示。
            final String msg = (e.getMessage() != null) ? e.getMessage() : String.valueOf(e);
            runOnUiThread(() -> Toast.makeText(this, "保存失败: " + msg, Toast.LENGTH_LONG).show());
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
