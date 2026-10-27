package com.vodbox.downloader;

/**
 * 在独立线程里拉起 nodejs-mobile 运行时。
 *
 * 注意：native 方法签名必须与 native-lib.cpp 里的 JNI 符号一一对应
 * （Java_com_vodbox_downloader_NodeRunner_start），改包名/类名时两边必须同步。
 */
public final class NodeRunner {
    static {
        System.loadLibrary("vodbox");
    }

    private NodeRunner() {}

    public static native int start(String[] arguments);
}
