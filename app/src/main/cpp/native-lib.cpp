#include <jni.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include "node.h"

// 调用 nodejs-mobile 的 node::Start 拉起 Node 运行时。
// 包名/类名必须与 Java 侧 NodeRunner 的 native 方法签名一致：
//   com.vodbox.downloader.NodeRunner.start(String[])
// 改包名/类名时，这个符号名也要同步改，否则运行时 UnsatisfiedLinkError。
extern "C" JNIEXPORT jint JNICALL
Java_com_vodbox_downloader_NodeRunner_start(
    JNIEnv *env, jclass /* clazz */, jobjectArray arguments) {
  jsize argument_count = env->GetArrayLength(arguments);

  // node 的 libuv 要求所有参数在连续内存中
  int c_arguments_size = 0;
  for (int i = 0; i < argument_count; i++) {
    jstring js = (jstring)env->GetObjectArrayElement(arguments, i);
    c_arguments_size += (int)env->GetStringUTFLength(js) + 1;
    env->DeleteLocalRef(js);
  }

  char *args_buffer = (char *)calloc(c_arguments_size + 1, sizeof(char));
  if (args_buffer == nullptr) return -1;

  // 可变长数组不能直接初始化，用堆分配
  char **argv = (char **)calloc(argument_count + 1, sizeof(char *));
  if (argv == nullptr) {
    free(args_buffer);
    return -1;
  }

  char *current_args_position = args_buffer;
  for (int i = 0; i < argument_count; i++) {
    jstring js = (jstring)env->GetObjectArrayElement(arguments, i);
    const char *current_argument = env->GetStringUTFChars(js, nullptr);
    size_t len = strlen(current_argument);
    memcpy(current_args_position, current_argument, len);
    current_args_position[len] = '\0';
    argv[i] = current_args_position;
    current_args_position += len + 1;
    env->ReleaseStringUTFChars(js, current_argument);
    env->DeleteLocalRef(js);
  }

  int result = node::Start(argument_count, argv);
  free(argv);
  free(args_buffer);
  return result;
}
