# 影视下载器 · Android（手机独立运行）

用 [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 把一个本地 Node 服务塞进安卓 App：
App 启动时在手机本地拉起服务（`127.0.0.1:8787`），内置 WebView 打开界面。
**服务跑在手机上，不依赖电脑或任何外部服务器。**

- 搜索剧名 → 选线路 → 勾选分集 → 批量下载
- 前台服务保活：切后台、锁屏、划掉任务卡片都能继续下
- 多集并行、分片并发、断点续传、暂停/继续/重试
- **自动剔除正片中间插播的广告**（不影响时间轴，播放不再卡顿、不再音画不同步）
- 保存到系统「下载/VodBox」，通知栏显示进度

| 搜索 | 选集 | 下载 | 深色模式 |
|---|---|---|---|
| ![搜索](docs/screens/search.png) | ![选集](docs/screens/detail.png) | ![下载](docs/screens/jobs.png) | ![深色](docs/screens/jobs-dark.png) |

<p align="center">
  <img src="docs/screens/ads.png" width="300" alt="剔除广告">
  <br>
  <sub>选集面板底部的「剔除广告」开关，默认开启</sub>
</p>

---

## 一、云构建（推荐，本地零安装）

只需要一个 GitHub 仓库，其余全自动。

1. 新建**空仓库**（public / private 均可）。
2. 把本目录内容 push 上去。
3. 进 **Actions** → `Build APK` → 自动触发（也可 Run workflow）。
4. 等 3–8 分钟，在 **Artifacts** 下载 `app-debug-apk`（内含 `app-debug.apk`）。
5. 手机安装：允许「未知来源」即可。debug 签名个人使用足够。

```bash
git add -A
git commit -m "feat: 2.0 重构"
git push -u origin master
```

> 构建必须在 GitHub 上跑（需要 Android SDK + NDK + nodejs-mobile 二进制）。

---

## 二、目录结构

```
.
├── build.gradle / settings.gradle / gradle.properties
├── app/
│   ├── build.gradle                    AGP 8.5 / minSdk 24 / targetSdk 34
│   ├── CMakeLists.txt                 导入 libnode.so + 编译 JNI 桥
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── cpp/native-lib.cpp          JNI：node::Start
│       ├── java/com/vodbox/downloader/
│       │   ├── MainActivity.java       WebView + JS 桥
│       │   ├── DownloadService.java    前台服务：Node + 保存 + 通知
│       │   ├── NodeRunner.java         native 入口
│       │   └── MediaStoreHelper.java
│       └── assets/nodejs-project/      Node 服务 + 前端（电脑上也能直接跑）
└── .github/workflows/build.yml         GitHub Actions
```

`app/libnode/` 由 CI 自动下载填充，**不需要手动放任何 .so**。

---

## 三、电脑上直接跑（调试最方便）

```bash
cd app/src/main/assets/nodejs-project
node server.js
# 浏览器打开 http://localhost:8787
```

同一 WiFi 的手机可直接访问 `http://<电脑IP>:8787`。

可调参数都在 `config.js`，也支持环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8787 | 端口 |
| `APP_BIND` | 安卓 `127.0.0.1` / 桌面 `0.0.0.0` | 监听地址 |
| `APP_SITE` | 内置站点 | 站点地址（唯一配置点） |
| `APP_EP_CONC` | 2 | 同时下载几集 |
| `APP_SEG_CONC` | 8 | 单集分片并发 |
| `APP_MAX_SOCKETS` | 32 | 全局连接上限 |
| `APP_STRIP_ADS` | 1 | 是否剔除插播广告（0 关闭） |

---

## 四、正式签名版（可选）

1. 生成密钥：
   ```bash
   keytool -genkey -v -keystore vodbox.keystore -alias vodbox \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
2. 仓库 **Settings → Secrets → Actions** 增加：
   - `KEYSTORE_BASE64`：`base64 -w0 vodbox.keystore` 的输出
   - `KEY_ALIAS` = `vodbox`
   - `KEY_PASSWORD` / `STORE_PASSWORD`
3. 取消 `build.yml` 末尾 release 段注释，补一段解码密钥的步骤。
4. 重新 Run workflow，下载 `app-release.apk`。

---

## 五、常见问题

**改了前端/服务端代码，装了新 APK 却没变化？**
`assets` 只在首次安装时拷到私有目录。改完代码要把 `MainActivity.ASSET_VERSION` 加 1，
App 升级时会重新拷贝（会保留 `downloads/`、`data/`、`cache/`）。

**下载的文件在哪？**
App 内部：应用私有目录 `downloads/<剧名>/`；点「保存」后复制到系统 `下载/VodBox/`。

**下载不动/很慢？**
先把「同时下载」调到 2–3 集；分片并发 8–12 即可。弱网会自动重试，中断后再点下载会从断点续传。

**播到中间会卡住、音画不同步？**
那是站方插播的广告段（分辨率/编码参数和正片不同，时间轴还会倒回 0）。下载时保持「剔除广告」开关打开即可，
服务端会按 `EXT-X-DISCONTINUITY` 切块并探测分片流参数，把广告整段丢掉，剩下的时间轴天然连续。
已经下好的旧文件不会自动修好，需要重新下载一次。

**站方改版导致解析失败？**
`POST /api/refresh` 会重新拉取播放脚本；连续失败时服务端也会自动重新拉取。

---

## 六、说明

- 仅作技术研究与离线收藏用途，请勿传播受版权保护的内容。
- 输出为标准 MPEG-TS（`.ts`），PotPlayer / VLC / nPlayer 可直接播放；
  转 mp4：`ffmpeg -i 第1集.ts -c copy 第1集.mp4`
- 详细设计与踩坑记录见 `影视下载器-方案文档.md`。
