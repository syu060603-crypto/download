'use strict';
/**
 * 影视批量下载器 - 本地服务
 * 零第三方依赖（仅 Node 内置模块）
 *
 *   浏览器/WebView  <--同源-->  本服务  <--->  站方页面 & CDN
 *
 * 说明：中间接口不带 CORS 头，浏览器直连会被同源策略拦，所以页面/解析/下载
 * 全部由本服务代劳；界面只跟 127.0.0.1 通信。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const CFG = require('./config');
const { getText, getBuffer } = require('./lib/http');
const parser = require('./lib/parser');
const resolver = require('./lib/resolver');
const jobsMgr = require('./lib/jobs');

const VERSION = '2.0.0';
const START_AT = Date.now();

// ---------------------------------------------------------------- 基础工具
function json(res, code, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function lanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const it of ifs[k] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(CFG.PUBLIC_DIR, safe);
  if (!file.startsWith(CFG.PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 缓存
const searchCache = new Map(); // kw -> {ts, results}
const detailCache = new Map(); // vid -> {ts, data}

function cachePut(map, key, val, max) {
  map.set(key, val);
  if (map.size > max) {
    const oldest = [...map.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) map.delete(oldest[0]);
  }
}

// ---------------------------------------------------------------- 搜索
function looksBlocked(html) {
  return /(访问过于频繁|请输入验证码|安全验证|人机验证|Just a moment|cf-browser-verification)/i.test(html);
}

async function apiSearch(req, res, q) {
  const kw = (q.get('kw') || '').trim().slice(0, 60);
  if (!kw) return json(res, 400, { error: '缺少关键词' });
  const t0 = Date.now();
  const hit = searchCache.get(kw);
  if (hit && Date.now() - hit.ts < CFG.SEARCH_CACHE_TTL && !q.get('refresh')) {
    return json(res, 200, { kw, results: hit.results, cached: true, took: 0 });
  }

  let lastErr = null;
  for (const base of CFG.SITE_CANDIDATES) {
    const url = base + '/search?kw=' + encodeURIComponent(kw);
    try {
      const html = await getText(url, {
        headers: { Referer: base + '/' },
        timeout: 20000,
        retry: 2,
      });
      if (looksBlocked(html)) {
        lastErr = new Error('站点要求验证，请稍后重试');
        continue;
      }
      const results = parser.parseSearch(html, base);
      if (results.length || /没有找到|暂无/i.test(html)) {
        cachePut(searchCache, kw, { ts: Date.now(), results }, CFG.SEARCH_CACHE_MAX);
        return json(res, 200, { kw, results, cached: false, took: Date.now() - t0 });
      }
      lastErr = new Error('站点返回内容异常');
    } catch (e) {
      lastErr = e;
    }
  }

  // 全部失败：有旧缓存就先用旧的，界面提示"离线结果"
  if (hit) {
    return json(res, 200, { kw, results: hit.results, cached: true, stale: true, took: Date.now() - t0 });
  }
  return json(res, 502, { error: '搜索失败：' + (lastErr ? lastErr.message : '网络不可用') + '，请检查网络后重试' });
}

// ---------------------------------------------------------------- 详情
async function apiDetail(req, res, q) {
  const vid = (q.get('vid') || '').trim();
  if (!/^\d+$/.test(vid)) return json(res, 400, { error: 'vid 非法' });
  const hit = detailCache.get(vid);
  if (hit && Date.now() - hit.ts < CFG.DETAIL_CACHE_TTL && !q.get('refresh')) {
    return json(res, 200, Object.assign({ cached: true }, hit.data));
  }
  let lastErr = null;
  for (const base of CFG.SITE_CANDIDATES) {
    try {
      const html = await getText(base + '/vd/' + vid + '.html', {
        headers: { Referer: base + '/' },
        timeout: 20000,
        retry: 2,
      });
      const data = parser.parseDetail(html, base);
      if (!data.groups.length) {
        lastErr = new Error('没有解析到分集，可能已下架');
        continue;
      }
      data.vid = vid;
      data.url = base + '/vd/' + vid + '.html';
      cachePut(detailCache, vid, { ts: Date.now(), data }, 200);
      return json(res, 200, Object.assign({ cached: false }, data));
    } catch (e) {
      lastErr = e;
    }
  }
  if (hit) return json(res, 200, Object.assign({ cached: true, stale: true }, hit.data));
  return json(res, 502, { error: '详情加载失败：' + (lastErr ? lastErr.message : '未知错误') });
}

// ---------------------------------------------------------------- 解析
async function apiResolve(req, res) {
  const body = await readBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json(res, 400, { error: '没有待解析的分集' });
  const concurrency = Math.min(Math.max(parseInt(body.concurrency, 10) || CFG.RESOLVE_CONCURRENCY, 1), 8);
  const results = await resolver.resolveMany(
    items.map((i) => ({ vid: String(i.vid), pid: parseInt(i.pid, 10) || 0, epid: parseInt(i.epid, 10) || 0 })),
    concurrency
  );
  const out = results.map((r, i) => ({
    vid: String(items[i].vid),
    pid: parseInt(items[i].pid, 10) || 0,
    epid: parseInt(items[i].epid, 10) || 0,
    name: items[i].name || '',
    m3u8: r && r.m3u8 ? r.m3u8 : null,
    error: r && r.error ? r.error : null,
  }));
  json(res, 200, { results: out });
}

// ---------------------------------------------------------------- 任务
async function apiDownload(req, res) {
  const body = await readBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json(res, 400, { error: '没有选中的分集' });
  const job = jobsMgr.create(Object.assign({}, body, { items }));
  jobsMgr.runJob(job);
  json(res, 200, { job: jobsMgr.snapshot(job) });
}

function apiJobs(req, res) {
  json(res, 200, { jobs: jobsMgr.list(), active: jobsMgr.activeCount() });
}

async function apiJobAction(req, res, id, action) {
  const job = jobsMgr.get(id);
  if (!job) return json(res, 404, { error: '任务不存在' });
  if (action === 'pause') jobsMgr.pause(id);
  else if (action === 'resume') jobsMgr.resume(id);
  else if (action === 'cancel') jobsMgr.cancel(id);
  else if (action === 'retry') {
    const body = await readBody(req).catch(() => ({}));
    jobsMgr.retry(id, body && body.idx);
  } else return json(res, 400, { error: '未知操作' });
  json(res, 200, { job: jobsMgr.snapshot(jobsMgr.get(id)) });
}

// ---------------------------------------------------------------- 文件
function sendFile(req, res, file, downloadName) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('文件不存在');
  }
  if (!stat.isFile() || stat.size === 0) {
    return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('文件不存在');
  }
  const name = downloadName || path.basename(file);
  const baseHeaders = {
    'Content-Type': 'video/mp2t',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
    'Cache-Control': 'no-store',
  };

  let start = 0;
  let end = stat.size - 1;
  let code = 200;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
      if (start > end || start >= stat.size) {
        return res
          .writeHead(416, { 'Content-Range': 'bytes */' + stat.size })
          .end();
      }
      end = Math.min(end, stat.size - 1);
      code = 206;
    }
  }
  const headers = Object.assign({}, baseHeaders, {
    'Content-Length': end - start + 1,
  });
  if (code === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;

  if (req.method === 'HEAD') {
    res.writeHead(code, headers);
    return res.end();
  }

  res.writeHead(code, headers);
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => {
    try {
      res.destroy();
    } catch (e) {
      /* noop */
    }
  });
  res.on('close', () => {
    try {
      stream.destroy();
    } catch (e) {
      /* noop */
    }
  });
  stream.pipe(res);
}

function apiFile(req, res, jobId, idxStr) {
  const job = jobsMgr.get(jobId);
  if (!job) return res.writeHead(404).end('job not found');
  const f = job.files[parseInt(idxStr, 10)];
  if (!f || !f.file) return res.writeHead(404).end('file not ready');
  if (f.status !== 'done' && f.status !== 'skipped') return res.writeHead(409).end('file not ready');
  const dlName = path.basename(f.file);
  sendFile(req, res, f.file, dlName);
}

// ---------------------------------------------------------------- 自动导出
// 安卓端 DownloadService 轮询 /api/export/next，把下完的集搬进
// 「下载/VodBox/<剧名>/」，搬完回报 /api/export/done。
// 桌面端没有这一步：文件本来就在 downloads/<剧名>/ 里。
function apiExportNext(req, res) {
  if (!CFG.EXPORT_AUTO) return json(res, 200, { item: null, auto: false });
  json(res, 200, { item: jobsMgr.nextExport(), auto: true });
}

async function apiExportDone(req, res) {
  const body = await readBody(req);
  const jobId = String(body.jobId || '');
  const idx = parseInt(body.idx, 10);
  if (!jobId || !Number.isFinite(idx)) return json(res, 400, { error: '参数不全' });
  const ok = jobsMgr.markExported(jobId, idx, !!body.ok, body.error ? String(body.error).slice(0, 200) : null);
  json(res, 200, { ok });
}

async function apiExportRetry(req, res) {
  const body = await readBody(req);
  const jobId = String(body.jobId || '');
  if (!jobId) return json(res, 400, { error: '缺少 jobId' });
  const idx = body.idx === undefined || body.idx === null ? null : parseInt(body.idx, 10);
  const n = jobsMgr.retryExport(jobId, Number.isFinite(idx) ? idx : null);
  json(res, 200, { ok: true, queued: n });
}

// ---------------------------------------------------------------- 封面代理
const imgCache = new Map(); // url -> {buf, type, ts}
const IMG_CACHE_MAX = 160;

async function apiImg(req, res, q) {
  const u = q.get('u');
  if (!u || !/^https?:\/\//i.test(u)) return res.writeHead(400).end('bad url');
  const hit = imgCache.get(u);
  if (hit && Date.now() - hit.ts < 6 * 3600 * 1000) {
    res.writeHead(200, {
      'Content-Type': hit.type,
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end(hit.buf);
  }
  try {
    const buf = await getBuffer(u, {
      headers: { Referer: CFG.SITE + '/', Accept: 'image/*' },
      timeout: 12000,
      retry: 2,
      encoding: 'identity',
    });
    const isWebp = buf.slice(8, 12).toString('ascii') === 'WEBP';
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const ct = isWebp ? 'image/webp' : isPng ? 'image/png' : 'image/jpeg';
    if (buf.length < 8 * 1024 * 1024) {
      imgCache.set(u, { buf, type: ct, ts: Date.now() });
      if (imgCache.size > IMG_CACHE_MAX) {
        const oldest = [...imgCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) imgCache.delete(oldest[0]);
      }
    }
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  } catch (e) {
    res.writeHead(404).end('img failed');
  }
}

// ---------------------------------------------------------------- SSE
const sseClients = new Set();
let sseTimer = null;
let sseDirty = false;

function pushJobs() {
  if (!sseClients.size) return;
  const payload = JSON.stringify({ jobs: jobsMgr.list(), active: jobsMgr.activeCount() });
  for (const res of sseClients) {
    try {
      res.write('event: jobs\ndata: ' + payload + '\n\n');
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

jobsMgr.bus.on('update', () => {
  sseDirty = true;
  if (sseTimer) return;
  sseTimer = setTimeout(() => {
    sseTimer = null;
    if (sseDirty) {
      sseDirty = false;
      pushJobs();
    }
  }, 400);
});

function apiEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write('event: jobs\ndata: ' + JSON.stringify({ jobs: jobsMgr.list(), active: jobsMgr.activeCount() }) + '\n\n');
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      /* noop */
    }
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// ---------------------------------------------------------------- 路由
const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400).end('bad request');
    return;
  }
  const p = u.pathname;
  const q = u.searchParams;

  try {
    if (p === '/favicon.ico') return res.writeHead(204).end();

    if (p === '/api/info') {
      return json(res, 200, {
        version: VERSION,
        platform: CFG.IS_ANDROID ? 'android' : process.platform,
        port: CFG.PORT,
        lanIps: lanIps(),
        downloadDir: CFG.DOWNLOAD_DIR,
        uptime: Math.round((Date.now() - START_AT) / 1000),
        defaults: {
          episodeConcurrency: CFG.EPISODE_CONCURRENCY,
          segmentConcurrency: CFG.SEGMENT_CONCURRENCY,
          stripAds: CFG.STRIP_ADS,
          exportAuto: CFG.EXPORT_AUTO,
        },
      });
    }
    if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION });

    if (p === '/api/search') return await apiSearch(req, res, q);
    if (p === '/api/detail') return await apiDetail(req, res, q);
    if (p === '/api/img') return await apiImg(req, res, q);
    if (p === '/api/events') return apiEvents(req, res);
    if (p === '/api/resolve' && req.method === 'POST') return await apiResolve(req, res);
    if (p === '/api/download' && req.method === 'POST') return await apiDownload(req, res);
    if (p === '/api/jobs') return apiJobs(req, res);
    if (p === '/api/files') return json(res, 200, { files: jobsMgr.listFiles() });
    if (p === '/api/export/next') return apiExportNext(req, res);
    if (p === '/api/export/done' && req.method === 'POST') return await apiExportDone(req, res);
    if (p === '/api/export/retry' && req.method === 'POST') return await apiExportRetry(req, res);

    if (p === '/api/refresh' && req.method === 'POST') {
      await resolver.rebuild();
      return json(res, 200, { ok: true, msg: '解析脚本已重新加载' });
    }

    let m = /^\/api\/job\/([^/]+)\/(pause|resume|cancel|retry)$/.exec(p);
    if (m && req.method === 'POST') return await apiJobAction(req, res, m[1], m[2]);

    m = /^\/api\/job\/([^/]+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      const withFiles = q.get('files') === '1';
      jobsMgr.remove(m[1], withFiles);
      return json(res, 200, { ok: true });
    }

    m = /^\/api\/file\/([^/]+)\/(\d+)$/.exec(p);
    if (m) return apiFile(req, res, m[1], m[2]);

    if (p.startsWith('/api/')) return json(res, 404, { error: '未知接口' });

    return serveStatic(req, res, p);
  } catch (e) {
    if (e && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
      try {
        res.destroy();
      } catch (_) {
        /* noop */
      }
      return;
    }
    try {
      json(res, 500, { error: (e && e.message) || '服务器内部错误' });
    } catch (_) {
      /* noop */
    }
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

process.on('uncaughtException', (e) => {
  if (e && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ERR_STREAM_PREMATURE_CLOSE')) return;
  console.error('[未捕获异常]', (e && e.stack) || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理的 Promise 拒绝]', (e && e.message) || e);
});

for (const d of [CFG.DOWNLOAD_DIR, CFG.CACHE_DIR, CFG.DATA_DIR]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    /* noop */
  }
}

server.listen(CFG.PORT, CFG.BIND, () => {
  const ips = lanIps();
  console.log('');
  console.log('  影视批量下载器 v' + VERSION + ' 已启动');
  console.log('  监听: ' + CFG.BIND + ':' + CFG.PORT);
  if (!CFG.IS_ANDROID) {
    console.log('  本机: http://localhost:' + CFG.PORT);
    ips.forEach((ip) => console.log('  局域网: http://' + ip + ':' + CFG.PORT));
  }
  console.log('  下载目录: ' + CFG.DOWNLOAD_DIR);
  console.log('');
  resolver.warmup().then(
    () => console.log('  [就绪] 解析引擎已加载'),
    (e) => console.log('  [警告] 解析引擎预加载失败（首次解析时会重试）: ' + e.message)
  );
});

process.on('SIGTERM', () => {
  try {
    jobsMgr.saveNow();
  } catch (e) {
    /* noop */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
