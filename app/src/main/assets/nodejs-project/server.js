'use strict';
/**
 * 星辰影视 批量下载器 - 服务端
 * 零第三方依赖 (仅 Node 内置模块)
 *
 * 架构:
 *   浏览器(电脑/手机)  <-->  本服务(同源)  <-->  xckcdy.com / CDN
 *   浏览器受同源策略限制无法直连站方, 故由本服务代抓页面并解析播放地址。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const { getText } = require('./lib/http');
const parser = require('./lib/parser');
const resolver = require('./lib/resolver');
const hls = require('./lib/hls');

const PORT = parseInt(process.env.PORT || '8787', 10);
const SITE = 'https://www.xckcdy.com';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const jobs = new Map();
let jobSeq = 0;
const detailCache = new Map(); // vid -> { ts, data }

// ------------------------------------------------------------------ 工具
function sanitizeName(s) {
  return (s || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
}

function readBody(req, limit = 1024 * 1024) {
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
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ------------------------------------------------------------------ API
async function apiSearch(req, res, q) {
  const kw = (q.get('kw') || '').trim();
  if (!kw) return json(res, 400, { error: '缺少关键词' });
  const url = SITE + '/search?kw=' + encodeURIComponent(kw);
  const html = await getText(url, { headers: { Referer: SITE + '/' }, timeout: 25000 });
  const results = parser.parseSearch(html);
  json(res, 200, { kw, results });
}

async function apiDetail(req, res, q) {
  const vid = (q.get('vid') || '').trim();
  if (!/^\d+$/.test(vid)) return json(res, 400, { error: 'vid 非法' });
  const cached = detailCache.get(vid);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return json(res, 200, cached.data);
  }
  const html = await getText(SITE + '/vd/' + vid + '.html', {
    headers: { Referer: SITE + '/' },
    timeout: 25000,
  });
  const data = parser.parseDetail(html);
  data.vid = vid;
  data.url = SITE + '/vd/' + vid + '.html';
  detailCache.set(vid, { ts: Date.now(), data });
  json(res, 200, data);
}

async function apiResolve(req, res) {
  const body = await readBody(req);
  const items = body.items || [];
  if (!items.length) return json(res, 400, { error: '没有待解析的分集' });
  const concurrency = Math.min(Math.max(parseInt(body.concurrency || '4', 10), 1), 8);
  const results = await resolver.resolveMany(
    items.map((i) => ({ vid: i.vid, pid: i.pid, epid: i.epid })),
    concurrency
  );
  const out = results.map((r, idx) => ({
    vid: items[idx].vid,
    pid: items[idx].pid,
    epid: items[idx].epid,
    name: items[idx].name || '',
    m3u8: r.m3u8 || null,
    error: r.error || null,
  }));
  json(res, 200, { results: out });
}

// ------------------------------------------------------------------ 下载任务
function createJob(body) {
  const id = 'J' + ++jobSeq + '_' + Date.now();
  const title = sanitizeName(body.title || '未命名');
  const items = body.items || [];
  const concurrency = Math.min(Math.max(parseInt(body.concurrency || '8', 10), 1), 32);
  const job = {
    id,
    title,
    created: Date.now(),
    status: 'running',
    cancelled: false,
    concurrency,
    dir: path.join(DOWNLOAD_DIR, title),
    files: items.map((it) => ({
      name: it.name || 'E' + (it.epid + 1),
      vid: it.vid,
      pid: it.pid,
      epid: it.epid,
      m3u8: it.m3u8 || null,
      status: 'pending',
      done: 0,
      total: 0,
      bytes: 0,
      file: null,
      error: null,
    })),
  };
  jobs.set(id, job);
  return job;
}

async function runJob(job) {
  try {
    fs.mkdirSync(job.dir, { recursive: true });
  } catch (e) {
    job.status = 'error';
    job.error = '无法创建目录: ' + e.message;
    return;
  }
  for (let i = 0; i < job.files.length; i++) {
    if (job.cancelled) break;
    const f = job.files[i];
    try {
      f.status = 'resolving';
      if (!f.m3u8) {
        const r = await resolver.resolveEpisode(f.vid, f.pid, f.epid);
        f.m3u8 = r.m3u8;
      }
      const baseName = sanitizeName(job.title + '_' + f.name);
      const outFile = path.join(job.dir, baseName + '.ts');
      f.file = outFile;
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        f.status = 'skipped';
        f.bytes = fs.statSync(outFile).size;
        continue;
      }
      f.status = 'downloading';
      const info = await hls.downloadEpisode(f.m3u8, outFile, {
        concurrency: job.concurrency,
        // 传递取消信号: 用户点「取消」时立即中断当前分片的抓取
        signal: { get cancelled() { return job.cancelled; } },
        onProgress: (p) => {
          f.done = p.done;
          f.total = p.total;
          f.bytes = p.bytes;
        },
      });
      f.total = info.total;
      f.done = info.total;
      f.bytes = info.bytes;
      f.status = 'done';
    } catch (e) {
      const cancelled = job.cancelled || /取消/.test(e.message || '');
      f.status = cancelled ? 'cancelled' : 'error';
      if (!cancelled) f.error = e.message;
      if (cancelled) break;
    }
  }
  // 清理取消留下的 .part 残片
  if (job.cancelled) {
    job.files.forEach((f) => {
      if (f.status === 'cancelled') {
        try { fs.unlinkSync(f.file + '.part'); } catch (e) { /* noop */ }
      }
    });
  }
  job.status = job.cancelled ? 'cancelled' : job.files.some((f) => f.status === 'error') ? 'completed_with_errors' : 'done';
  job.finished = Date.now();
}

async function apiDownload(req, res) {
  const body = await readBody(req, 4 * 1024 * 1024);
  const items = body.items || [];
  if (!items.length) return json(res, 400, { error: '没有选中的分集' });
  const job = createJob(body);
  runJob(job); // 后台执行
  json(res, 200, { jobId: job.id, title: job.title, dir: job.dir });
}

function apiJobs(req, res) {
  const list = [...jobs.values()].map((j) => ({
    id: j.id,
    title: j.title,
    status: j.status,
    dir: j.dir,
    concurrency: j.concurrency,
    files: j.files.map((f) => ({
      name: f.name,
      status: f.status,
      done: f.done,
      total: f.total,
      bytes: f.bytes,
      m3u8: f.m3u8,
      file: f.file,
      error: f.error,
    })),
  }));
  json(res, 200, { jobs: list });
}

async function apiJobAction(req, res, id, action) {
  const job = jobs.get(id);
  if (!job) return json(res, 404, { error: '任务不存在' });
  if (action === 'cancel') {
    job.cancelled = true;
    return json(res, 200, { ok: true });
  }
  if (action === 'delete') {
    jobs.delete(id);
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: '未知操作' });
}

/** 把文件以附件形式流出, 支持 Range; 客户端断开时不向上抛错 */
function streamFile(res, file, start, end) {
  const stream = fs.createReadStream(file, start !== undefined ? { start, end } : undefined);
  stream.on('error', (e) => {
    // 客户端提前断开 / 文件被删: 只做资源回收, 不当成 500
    try { res.destroy(); } catch (_) { /* noop */ }
    if (e && e.code === 'ENOENT') {
      try { res.writeHead(404).end('file gone'); } catch (_) { /* noop */ }
    }
  });
  stream.pipe(res);
}

function apiFile(req, res, id, idxStr) {
  const job = jobs.get(id);
  if (!job) return res.writeHead(404).end('job not found');
  const idx = parseInt(idxStr || '0', 10);
  const f = job.files[idx];
  if (!f || !f.file || !fs.existsSync(f.file)) {
    return res.writeHead(404).end('file not ready');
  }
  const stat = fs.statSync(f.file);
  const fname = path.basename(f.file);
  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Content-Length': stat.size,
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
    'Accept-Ranges': 'bytes',
  });
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= 0 && end < stat.size && start <= end) {
        res.writeHead(206, {
          'Content-Type': 'video/mp2t',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
        });
        streamFile(res, f.file, start, end);
        return;
      }
    }
  }
  streamFile(res, f.file);
}

function json(res, code, obj) {
  if (res.headersSent) return; // 已开始响应(如文件流)时不再写头, 避免崩溃
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ------------------------------------------------------------------ 路由
const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400).end('bad request');
    return;
  }
  const p = u.pathname;

  try {
    if (p === '/' || p === '/index.html') return serveStatic(req, res, '/index.html');
    if (p === '/favicon.ico') return res.writeHead(204).end();

    if (p === '/api/search') return await apiSearch(req, res, u.searchParams);
    if (p === '/api/detail') return await apiDetail(req, res, u.searchParams);
    if (p === '/api/resolve' && req.method === 'POST') return await apiResolve(req, res);
    if (p === '/api/download' && req.method === 'POST') return await apiDownload(req, res);
    if (p === '/api/jobs') return apiJobs(req, res);
    if (p === '/api/info') {
      return json(res, 200, {
        site: SITE,
        downloadDir: DOWNLOAD_DIR,
        port: PORT,
        lanIps: lanIps(),
      });
    }
    if (p === '/api/refresh' && req.method === 'POST') {
      await resolver.rebuild();
      return json(res, 200, { ok: true, msg: '已重新加载站方解析脚本' });
    }
    const act = /^\/api\/job\/([^/]+)\/(cancel|delete)$/.exec(p);
    if (act && req.method === 'POST') return await apiJobAction(req, res, act[1], act[2]);
    const fm = /^\/api\/file\/([^/]+)\/(\d+)$/.exec(p);
    if (fm) return apiFile(req, res, fm[1], fm[2]);

    if (p.startsWith('/api/')) return json(res, 404, { error: '未知接口' });
    return serveStatic(req, res, p);
  } catch (e) {
    // 客户端提前断开(ECONNRESET 等)属于正常现象, 静默回收即可
    if (e && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
      try { res.destroy(); } catch (_) { /* noop */ }
      return;
    }
    return json(res, 500, { error: e.message || '服务器内部错误' });
  }
});

// 兜底: 任何未捕获异常都不能让进程退出
process.on('uncaughtException', (e) => {
  if (e && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ERR_STREAM_PREMATURE_CLOSE')) return;
  console.error('[未捕获异常]', e && e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理的Promise拒绝]', (e && e.message) || e);
});

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIps();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║        星辰影视 批量下载器 已启动                    ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  本机访问:   http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  手机访问:   http://' + ip + ':' + PORT + '   (与电脑同一 WiFi)'));
  console.log('');
  console.log('  下载保存目录: ' + DOWNLOAD_DIR);
  console.log('');
  // 预热解析器
  resolver.initPool().then(
    () => console.log('  [就绪] 播放地址解析引擎已加载'),
    (e) => console.log('  [警告] 解析引擎加载失败: ' + e.message)
  );
});
