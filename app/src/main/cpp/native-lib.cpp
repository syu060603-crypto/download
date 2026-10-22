#include <jni.h>
#include <string>
#include <stdlib.h>
#include "node.h"

// 调用 nodejs-mobile 的 node::Start 拉起 Node 运行时。
// 包名/类名必须与 Java 侧 MainActivity 的 native 方法签名一致。
extern "C" jint JNICALL
Java_com_xckcdy_xckcdy_MainActivity_startNodeWithArguments(
    JNIEnv *env, jobject /* this */, jobjectArray arguments) {
  jsize argument_count = env->GetArrayLength(arguments);

  // node 的 libuv 要求所有参数在连续内存中
  int c_arguments_size = 0;
  for (int i = 0; i < argument_count; i++) {
    c_arguments_size +=
        env->GetStringUTFLength((jstring)env->GetObjectArrayElement(arguments, i)) + 1;
  }

  char *args_buffer = (char *)calloc(c_arguments_size, sizeof(char));
  char *argv[argument_count];
  char *current_args_position = args_buffer;

  for (int i = 0; i < argument_count; i++) {
    const char *current_argument =
        env->GetStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), 0);
    strncpy(current_args_position, current_argument, strlen(current_argument));
    argv[i] = current_args_position;
    current_args_position += strlen(current_argument) + 1;
    env->ReleaseStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i),
                               current_argument);
  }

  int result = node::Start(argument_count, argv);
  free(args_buffer);
  return result;
}
