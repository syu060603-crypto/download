# 星辰下载 · Android APK（手机独立运行版）

把之前做好的 **星辰影视批量下载服务端** 通过 [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)
直接塞进一个安卓 App：App 启动时在手机本地拉起 Node 运行时（跑 `server.js`），再用内置 WebView
打开 `http://127.0.0.1:8787`。**服务端就跑在手机上，不依赖任何电脑或外部服务器。**

- 搜索剧名 → 选线路（量子/优质/非凡/暴风…）→ 勾选分集 → 批量下载
- 断点跳过、中途取消、保存到本机（落到系统「下载/xckcdy」）
- 复用电脑版 100% 的解析/下载逻辑，站方改版后调 `/api/refresh` 自愈

---

## 一、云构建（推荐，本地零安装）

你只需要一个 GitHub 仓库，其余全自动。

1. 在 github.com 新建一个**空仓库**（public / private 均可）。
2. 把本目录全部内容 push 上去（见下方命令）。
3. 进仓库 **Actions** 选项卡 → 左边选 `Build APK` → **Run workflow**（其实 push 上去就会自动触发）。
4. 等待 3–8 分钟，构建完成后在 **Artifacts** 里下载 `app-debug.apk`。
5. 手机安装：把 `app-debug.apk` 拷到手机，允许「未知来源」安装即可。
   （debug 签名对个人使用完全够用；要正式签名版看第三节。）

> ⚠️ 本目录已经是 git 仓库，`origin` 已指向你的 `download.git`，当前分支是 `master`，
> 代码也已提交。你只需在**自己电脑的终端**（不要走本工具的代理网络）执行下面一行即可推送：

```bash
# 在 E:/WorkBuddyPath/2026-10-22-12-52-28/xckcdy-apk 目录下
git push -u origin master
```

- 如果提示 `failed to push` 是因为远程仓库已有提交（非真正空仓），先 `git pull origin master --rebase` 再推。
- 构建必须在 GitHub 上触发（需要 Android SDK + NDK + nodejs-mobile 二进制，本地没有也能构建）。

---

## 二、目录结构

```
xckcdy-apk/
├── build.gradle / settings.gradle      Gradle 工程配置
├── gradle.properties
├── app/
│   ├── build.gradle                    AGP 8.5 / minSdk 24 / ndk 26
│   ├── CMakeLists.txt                  nodejs-mobile 链接配置
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── cpp/native-lib.cpp          JNI：调用 node::Start 拉起 Node
│       ├── java/.../MainActivity.java  启动 Node + WebView + 保存文件
│       └── assets/nodejs-project/       ← 直接复用电脑版的 Node 代码
│           ├── main.js                 入口
│           ├── server.js               服务端（原样）
│           ├── lib/{http,parser,resolver,hls}.js
│           └── public/index.html       前端界面（原样）
└── .github/workflows/build.yml         GitHub Actions 云构建
```

`app/libnode/` 由 CI 自动下载填充，**不需要你手动放任何 .so**。

---

## 三、正式签名版（可选）

1. 本地生成密钥（一次性）：
   ```bash
   keytool -genkey -v -keystore xckcdy.keystore -alias xckcdy \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
2. 在仓库 **Settings → Secrets → Actions** 增加：
   - `KEYSTORE_BASE64`：`base64 -w0 xckcdy.keystore` 的输出
   - `KEY_ALIAS` = `xckcdy`
   - `KEY_PASSWORD` / `STORE_PASSWORD` = 你的密码
3. 取消 `build.yml` 末尾 release 段注释，并补一段解码密钥的步骤（参考标准 GitHub Actions 安卓签名范例）。
4. 重新 Run workflow，下载 `app-release.apk`（可上架/长期分发）。

---

## 四、说明

- 仅作技术研究与离线收藏用途，请勿用于传播受版权保护的内容。
- 首次启动会把 `nodejs-project` 从 APK 拷到应用私有目录，之后直接复用，不会重复拷贝。
- 若站方更换加密脚本，`POST /api/refresh`（或重启 App）会让 `resolver.js` 重新拉取最新 `dypck.js`。
- 下载文件为标准 MPEG-TS，PotPlayer / VLC / nPlayer 均可播放；转 mp4：
  `ffmpeg -i 第1集.ts -c copy 第1集.mp4`
