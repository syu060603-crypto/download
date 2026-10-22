cmake_minimum_required(VERSION 3.22.1)
project("xckcdy")

# nodejs-mobile 头文件（CI 会把官方 zip 解压到 app/libnode/）
include_directories(${CMAKE_SOURCE_DIR}/../libnode/include)

# 导入官方 libnode.so
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/../libnode/bin/${ANDROID_ABI}/libnode.so)

# 我们的 JNI 桥：调用 node::Start 拉起 nodejs-project
add_library(xckcdy SHARED native-lib.cpp)
target_link_libraries(xckcdy node log)
