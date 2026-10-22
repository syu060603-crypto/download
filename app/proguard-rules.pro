# 关闭混淆（调试/发布都先不混淆，避免 node 资源路径问题）
-dontobfuscate
-keep class com.xckcdy.xckcdy.MainActivity { *; }
