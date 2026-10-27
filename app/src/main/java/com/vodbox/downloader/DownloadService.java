package com.vodbox.downloader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
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

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.List;
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
    public static final String EXTRA_FOLDER = "folder";

    private static final String CHANNEL_ID = "vod_service";
    private static final int NOTIF_SERVICE = 8801;
    private static final int NOTIF_SAVE = 8802;

    /** 本地 Node 服务端口（MainActivity 也用它） */
    public static final int PORT = 8787;
    private static final String BASE_URL = "http://127.0.0.1:" + PORT;
    /** 导出线程空闲时的轮询间隔 */
    private static final long EXPORT_IDLE_MS = 2000;

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
    private volatile boolean exporting = false;

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
            enqueueSave(intent.getStringExtra(EXTRA_URL), intent.getStringExtra(EXTRA_NAME),
                    intent.getStringExtra(EXTRA_FOLDER));
        } else if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startNodeOnce();
        startExportPump();
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
        exporting = false;
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

    private void notifySaved(String folder, String name) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            String where = MediaStoreHelper.FOLDER
                    + (folder == null || folder.isEmpty() ? "" : "/" + folder);
            b.setContentTitle("已保存到 下载/" + where)
                    .setContentText(name)
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

    // ---------------------------------------------------------------- 自动导出
    /**
     * 轮询本地服务的 /api/export/next，把 Node 下完的集搬进
     * 「下载/VodBox/<剧名>/」，搬完回报 /api/export/done。
     *
     * 为什么放在服务里：Activity 被销毁、App 划掉后还要继续搬；
     * 为什么轮询而不是回调：Node 没法反向调 Java，本地回环 HTTP 最省事。
     */
    private void startExportPump() {
        if (exporting) return;
        exporting = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                exportLoop();
            }
        }, "export-pump").start();
    }

    private void exportLoop() {
        int idle = 0;
        while (exporting) {
            JSONObject resp;
            try {
                resp = fetchNextExport();
                idle = 0;
            } catch (Throwable e) {
                // 本地服务还没起来 / 正在重启，等一下再试
                sleepQuietly(2000);
                continue;
            }
            if (!resp.optBoolean("auto", true)) {
                Log.i(TAG, "auto export disabled by server");
                exporting = false;
                return;
            }
            JSONObject item = resp.isNull("item") ? null : resp.optJSONObject("item");
            if (item == null) {
                sleepQuietly(++idle > 15 ? 5000 : EXPORT_IDLE_MS);
                continue;
            }
            String jobId = item.optString("jobId", "");
            int idx = item.optInt("idx", -1);
            try {
                exportItem(item);
                reportExport(jobId, idx, true, null);
            } catch (Throwable e) {
                String msg = e.getMessage() == null ? String.valueOf(e) : e.getMessage();
                Log.e(TAG, "export failed: " + msg);
                reportExport(jobId, idx, false, msg);
                sleepQuietly(1000);
            }
        }
    }

    private JSONObject fetchNextExport() throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE_URL + "/api/export/next").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(8000);
            c.setRequestProperty("User-Agent", UA);
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            return new JSONObject(readAll(c.getInputStream()));
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void reportExport(String jobId, int idx, boolean ok, String error) {
        if (jobId == null || jobId.isEmpty() || idx < 0) return;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE_URL + "/api/export/done").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(2000);
            c.setReadTimeout(8000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            JSONObject o = new JSONObject();
            o.put("jobId", jobId);
            o.put("idx", idx);
            o.put("ok", ok);
            if (error != null) o.put("error", error);
            OutputStream out = c.getOutputStream();
            out.write(o.toString().getBytes("UTF-8"));
            out.close();
            c.getResponseCode();
        } catch (Throwable e) {
            Log.w(TAG, "report export failed: " + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 把一个已下完的集从 App 私有目录搬到系统下载目录 */
    private void exportItem(JSONObject item) throws Exception {
        String folder = safeName(item.optString("title", ""), 60);
        String fileName = item.optString("fileName", "");
        if (fileName.isEmpty()) fileName = item.optString("name", "video");
        fileName = safeName(fileName, 90);
        if (!fileName.toLowerCase().endsWith(".ts")) fileName += ".ts";

        File src = new File(item.optString("path", ""));
        if (!src.isFile() || src.length() <= 0) throw new IOException("源文件不存在");
        long size = src.length();

        updateServiceNotification("正在保存 " + folder + " · " + fileName);
        InputStream in = new FileInputStream(src);
        try {
            writeToDownloads(in, size, folder, fileName);
        } finally {
            closeQuietly(in);
        }
        notifySaved(folder, fileName);
    }

    private void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } finally {
            closeQuietly(in);
        }
    }

    /** 文件名/文件夹名清洗：去掉路径分隔符等在安卓上会出问题的字符 */
    private static String safeName(String raw, int max) {
        String s = raw == null ? "" : raw.trim();
        s = s.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]+", " ").replaceAll("\\s+", " ").trim();
        s = s.replaceAll("^[. ]+", "").replaceAll("[. ]+$", "").trim();
        if (s.length() > max) s = s.substring(0, max).trim();
        return s.isEmpty() ? "未命名" : s;
    }

    // ---------------------------------------------------------------- 保存到系统下载目录
    public void enqueueSave(final String url, final String name, final String folder) {
        if (url == null || url.isEmpty()) return;
        if (savePool == null) savePool = Executors.newFixedThreadPool(2);
        final int n = saving.incrementAndGet();
        updateServiceNotification("正在保存 " + n + " 个文件…");
        savePool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    saveOne(url, name, folder);
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

    private void saveOne(String urlStr, String rawName, String rawFolder) throws IOException {
        String folder = (rawFolder == null || rawFolder.trim().isEmpty()) ? null : safeName(rawFolder, 60);
        String name = safeName(rawName, 90);
        if (!name.toLowerCase().endsWith(".ts")) name = name + ".ts";

        HttpURLConnection conn = null;
        InputStream in = null;
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
            writeToDownloads(in, total, folder, name);
            notifySaved(folder, name);
        } finally {
            closeQuietly(in);
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * 真正的落盘：Android 10+ 走 MediaStore（「下载」目录下的子文件夹），
     * 9 及以下走公共目录 File API。
     */
    private void writeToDownloads(InputStream in, long total, String folder, String fileName) throws IOException {
        boolean isQ = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        String sub = MediaStoreHelper.FOLDER + (folder == null || folder.isEmpty() ? "" : "/" + folder);
        if (isQ) {
            String rel = Environment.DIRECTORY_DOWNLOADS + "/" + sub + "/";
            // 已经存过就直接跳过（重下同一集时不会出现 "xxx(1).ts"）
            if (mediaCompletedExists(rel, fileName)) return;

            Uri pending = null;
            OutputStream out = null;
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                v.put(MediaStore.Downloads.RELATIVE_PATH, rel);
                v.put(MediaStore.Downloads.MIME_TYPE, "video/mp2t");
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                pending = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (pending == null) throw new IOException("无法创建下载条目");
                out = getContentResolver().openOutputStream(pending);
                if (out == null) throw new IOException("无法写入文件");
                copyStream(in, out, total, fileName);
                out.flush();
                out.close();
                out = null;
                ContentValues done1 = new ContentValues();
                done1.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(pending, done1, null, null);
            } catch (Throwable e) {
                closeQuietly(out);
                if (pending != null) {
                    try {
                        getContentResolver().delete(pending, null, null);
                    } catch (Throwable ignored) {
                    }
                }
                throw asIoException(e);
            } finally {
                closeQuietly(out);
            }
        } else {
            File base = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File dir = new File(base, sub);
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录");
            File dst = new File(dir, fileName);
            if (dst.isFile() && dst.length() > 0) return;
            File tmp = new File(dir, fileName + ".part");
            OutputStream out = null;
            try {
                out = new FileOutputStream(tmp);
                copyStream(in, out, total, fileName);
                out.flush();
                out.close();
                out = null;
                if (dst.exists() && !dst.delete()) throw new IOException("无法覆盖旧文件");
                if (!tmp.renameTo(dst)) throw new IOException("重命名失败");
            } catch (Throwable e) {
                closeQuietly(out);
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                throw asIoException(e);
            }
        }
    }

    private void copyStream(InputStream in, OutputStream out, long total, String label) throws IOException {
        byte[] buf = new byte[128 * 1024];
        long done = 0;
        int read;
        long last = 0;
        while ((read = in.read(buf)) > 0) {
            out.write(buf, 0, read);
            done += read;
            long now = System.currentTimeMillis();
            if (now - last > 800) {
                last = now;
                int pct = total > 0 ? (int) (done * 100 / total) : 0;
                updateServiceNotification("正在保存 " + label + " " + pct + "%");
            }
        }
        if (total > 0 && done != total) throw new IOException("写入不完整 " + done + "/" + total);
    }

    /** 目标目录里是否已有同名成品；顺手清掉上次中断留下的半成品条目 */
    private boolean mediaCompletedExists(String rel, String name) {
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String[] proj = {MediaStore.Downloads._ID, MediaStore.Downloads.IS_PENDING};
        String sel = MediaStore.Downloads.DISPLAY_NAME + "=? AND " + MediaStore.Downloads.RELATIVE_PATH + "=?";
        boolean completed = false;
        List<Long> stale = new ArrayList<>();
        Cursor cur = null;
        try {
            cur = getContentResolver().query(collection, proj, sel, new String[]{name, rel}, null);
            while (cur != null && cur.moveToNext()) {
                long id = cur.getLong(0);
                int pending = cur.isNull(1) ? 0 : cur.getInt(1);
                if (pending == 1) stale.add(id);
                else completed = true;
            }
        } catch (Throwable ignored) {
        } finally {
            if (cur != null) cur.close();
        }
        for (Long id : stale) {
            try {
                getContentResolver().delete(ContentUris.withAppendedId(collection, id), null, null);
            } catch (Throwable ignored) {
            }
        }
        return completed;
    }

    private static IOException asIoException(Throwable e) {
        if (e instanceof IOException) return (IOException) e;
        return new IOException(e.getMessage() == null ? String.valueOf(e) : e.getMessage());
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
