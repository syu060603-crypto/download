'use strict';
// nodejs-mobile 入口：拉起我们现有的星辰影视下载服务端。
// server.js 内部会 require('./lib/*') 并监听 0.0.0.0:8787，
// WebView 通过 http://127.0.0.1:8787 访问。
try {
  require('./server.js');
  console.log('[xckcdy] node server started');
} catch (e) {
  console.error('[xckcdy] server failed:', (e && e.stack) || e);
}
