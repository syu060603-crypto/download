# 关闭混淆（避免 node 资源路径 / JNI 符号 / JS 桥被改写）
-dontobfuscate

# JNI 入口与 JS 桥必须保留
-keep class com.vodbox.downloader.NodeRunner { *; }
-keep class com.vodbox.downloader.MainActivity { *; }
-keep class com.vodbox.downloader.MainActivity$Bridge { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
