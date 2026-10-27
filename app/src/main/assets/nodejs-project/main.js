'use strict';
/**
 * nodejs-mobile 入口：在手机本地拉起下载服务。
 * server.js 监听 127.0.0.1:8787（手机上不对外暴露），WebView 通过回环地址访问。
 */
process.env.APP_BIND = process.env.APP_BIND || '127.0.0.1';

try {
  require('./server.js');
  console.log('[app] service started');
} catch (e) {
  console.error('[app] service failed:', (e && e.stack) || e);
}
