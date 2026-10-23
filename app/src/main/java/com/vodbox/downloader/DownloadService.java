package com.vodbox.downloader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.util.Log;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 前台服务：本地下载服务 + 文件保存。
 *
 * 为什么必须有它：安卓在 App 切到后台后会冻结/回收普通进程的线程，
 * 初版把 Node 服务和保存线程都挂在 Activity 上，一旦切后台下载就停。
 * 这里把 Node 运行时装进前台服务，并持有 WakeLock + WifiLock，
 * 配合常驻通知，切后台、锁屏都能继续下载。
 */
public class DownloadService extends Service {

    private static final String TAG = "VodService";

    public static final String ACTION_START = "com.vodbox.downloader.START";
    public static final String ACTION_SAVE = "com.vodbox.downloader.SAVE";
    public static final String ACTION_STOP = "com.vodbox.downloader.STOP";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_NAME = "name";

    private static final String CHANNEL_ID = "vod_service";
    private static final int NOTIF_SERVICE = 8801;
    private static final int NOTIF_SAVE = 8802;

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Mobile Safari/537.36";

    private static volatile DownloadService instance;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private ExecutorService savePool;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger saving = new AtomicInteger(0);
    private volatile boolean nodeStarted = false;
    private volatile boolean foreground = false;

    public static DownloadService get() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        savePool = Executors.newFixedThreadPool(2);
        acquireLocks();
        Log.i(TAG, "service created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!foreground) goForeground();
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_SAVE.equals(action) && intent != null) {
            enqueueSave(intent.getStringExtra(EXTRA_URL), intent.getStringExtra(EXTRA_NAME));
        } else if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startNodeOnce();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务里划掉 App 时不要跟着退出，下载继续
        Log.i(TAG, "task removed, keep running");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        if (savePool != null) savePool.shutdown();
        instance = null;
        super.onDestroy();
    }

    // ---------------------------------------------------------------- 启动
    public static void start(Context ctx) {
        Intent i = new Intent(ctx, DownloadService.class);
        i.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    private void goForeground() {
        Notification n = buildServiceNotification("正在准备…");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_SERVICE, n);
        }
        foreground = true;
    }

    private void startNodeOnce() {
        if (nodeStarted) return;
        nodeStarted = true;
        final File projDir = new File(getFilesDir(), "nodejs-project");
        final File mainJs = new File(projDir, "main.js");
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Log.i(TAG, "starting node: " + mainJs.getAbsolutePath());
                    NodeRunner.start(new String[]{"node", mainJs.getAbsolutePath()});
                    Log.w(TAG, "node exited");
                } catch (Throwable e) {
                    Log.e(TAG, "node start failed", e);
                }
            }
        }, "node-runtime").start();
    }

    // ---------------------------------------------------------------- 锁
    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vodbox:download");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (Throwable e) {
            Log.w(TAG, "wake lock failed: " + e.getMessage());
        }
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null && wifiLock == null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "vodbox:wifi");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Throwable e) {
            Log.w(TAG, "wifi lock failed: " + e.getMessage());
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Throwable ignored) {
        }
        wakeLock = null;
        wifiLock = null;
    }

    // ---------------------------------------------------------------- 通知
    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "下载服务", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("后台下载与文件保存");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent contentIntent() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private Notification buildServiceNotification(String text) {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("下载服务运行中")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setVisibility(Notification.VISIBILITY_PUBLIC);
        }
        return b.build();
    }

    private void updateServiceNotification(String text) {
        if (!foreground) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_SERVICE, buildServiceNotification(text));
        } catch (Throwable ignored) {
        }
    }

    private void notifySaved(String name) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setContentTitle("保存完成")
                    .setContentText(name + " 已保存到 下载/影视资源")
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setAutoCancel(true)
                    .setContentIntent(contentIntent());
            nm.notify(NOTIF_SAVE, b.build());
        } catch (Throwable ignored) {
        }
    }

    private void toast(final String msg) {
        main.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    // ---------------------------------------------------------------- 保存到系统下载目录
    public void enqueueSave(final String url, final String name) {
        if (url == null || url.isEmpty()) return;
        if (savePool == null) savePool = Executors.newFixedThreadPool(2);
        final int n = saving.incrementAndGet();
        updateServiceNotification("正在保存 " + n + " 个文件…");
        savePool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    saveOne(url, name);
                } catch (Throwable e) {
                    Log.e(TAG, "save failed", e);
                    toast("保存失败：" + (e.getMessage() == null ? String.valueOf(e) : e.getMessage()));
                } finally {
                    int left = saving.decrementAndGet();
                    updateServiceNotification(left > 0 ? ("正在保存 " + left + " 个文件…") : "后台下载中");
                }
            }
        });
    }

    private void saveOne(String urlStr, String rawName) throws IOException {
        String name = (rawName == null || rawName.trim().isEmpty())
                ? ("video_" + System.currentTimeMillis() + ".ts")
                : rawName.trim();
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (!name.toLowerCase().endsWith(".ts")) name = name + ".ts";

        HttpURLConnection conn = null;
        InputStream in = null;
        OutputStream out = null;
        Uri pendingUri = null;
        boolean isQ = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        try {
            URL u = new URL(urlStr);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", UA);
            int code = conn.getResponseCode();
            if (code != 200 && code != 206) throw new IOException("HTTP " + code);
            long total = conn.getContentLengthLong();
            in = conn.getInputStream();

            if (isQ) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/" + MediaStoreHelper.FOLDER);
                v.put(MediaStore.Downloads.MIME_TYPE, "video/mp2t");
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                pendingUri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (pendingUri == null) throw new IOException("无法创建下载条目");
                out = getContentResolver().openOutputStream(pendingUri);
            } else {
                File dir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        MediaStoreHelper.FOLDER);
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录");
                out = new FileOutputStream(new File(dir, name));
            }
            if (out == null) throw new IOException("无法写入文件");

            byte[] buf = new byte[64 * 1024];
            long done = 0;
            int read;
            long lastNotify = 0;
            while ((read = in.read(buf)) > 0) {
                out.write(buf, 0, read);
                done += read;
                long now = System.currentTimeMillis();
                if (now - lastNotify > 700) {
                    lastNotify = now;
                    int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    updateServiceNotification("正在保存 " + name + " " + pct + "%");
                }
            }
            out.flush();
            out.close();
            out = null;
            in.close();
            in = null;

            if (isQ && pendingUri != null) {
                ContentValues done1 = new ContentValues();
                done1.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(pendingUri, done1, null, null);
            }
            notifySaved(name);
            toast("已保存到 下载/" + MediaStoreHelper.FOLDER + "/" + name);
        } catch (Throwable e) {
            if (isQ && pendingUri != null) {
                try {
                    getContentResolver().delete(pendingUri, null, null);
                } catch (Throwable ignored) {
                }
            }
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException(e.getMessage() == null ? String.valueOf(e) : e.getMessage());
        } finally {
            closeQuietly(in);
            closeQuietly(out);
            if (conn != null) conn.disconnect();
        }
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Throwable ignored) {
        }
    }

    /** 从 Content-Disposition 里取文件名（兼容 filename*=UTF-8''） */
    public static String parseFileName(String cd) {
        if (cd == null) return null;
        try {
            int i = cd.indexOf("filename*=UTF-8''");
            if (i >= 0) {
                String s = cd.substring(i + "filename*=UTF-8''".length()).trim();
                int semi = s.indexOf(';');
                if (semi > 0) s = s.substring(0, semi);
                return URLDecoder.decode(s, "UTF-8");
            }
            int j = cd.indexOf("filename=");
            if (j >= 0) {
                String s = cd.substring(j + "filename=".length()).trim();
                int semi = s.indexOf(';');
                if (semi > 0) s = s.substring(0, semi);
                if (s.startsWith("\"") && s.endsWith("\"") && s.length() > 1) {
                    s = s.substring(1, s.length() - 1);
                }
                return s;
            }
        } catch (Throwable ignored) {
        }
        return null;
    }
}
