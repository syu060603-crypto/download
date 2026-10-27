cmake_minimum_required(VERSION 3.22.1)
project("vodbox")

# nodejs-mobile 头文件（CI 会把官方 zip 解压并重排到 app/libnode/）
# 头文件统一放在 app/libnode/include/node/（node.h、v8.h、uv.h…），
# 必须把 include/node 加进搜索路径，#include "node.h" 才能解析。
include_directories(${CMAKE_SOURCE_DIR}/libnode/include/node)

# 导入官方 libnode.so（CI 已按 ABI 拷到 app/libnode/lib/<abi>/libnode.so）
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/libnode/lib/${ANDROID_ABI}/libnode.so)

# JNI 桥：调用 node::Start 拉起 nodejs-project
# 注意：CMakeLists.txt 位于 app/，源码在 app/src/main/cpp/，必须写相对路径
add_library(vodbox SHARED src/main/cpp/native-lib.cpp)
target_link_libraries(vodbox node log)
