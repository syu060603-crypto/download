'use strict';
/**
 * 极简 HTTP(S) 客户端（零第三方依赖）
 *
 * 相比初版的关键改进：
 *  1. keep-alive 连接池：一个剧集要下 600+ 个分片，复用 TCP/TLS 能省掉大量握手
 *     （手机弱网下尤其明显）。
 *  2. 失败自动重试 + 指数退避：弱网偶发 ECONNRESET / 超时不再直接判死。
 *  3. 整体超时（deadline），不只是 socket 空闲超时，避免连接卡死时永久挂起。
 *  4. 重定向限次，防止站点错误配置导致无限跳转。
 *  5. Cookie 会话保持：部分站点反爬会给 cookie，带上后成功率明显提升。
 *  6. 支持 AbortSignal：用户取消/暂停能立刻中断在途请求。
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const CFG = require('../config');

const UA = CFG.UA;

// ---------------------------------------------------------------- 连接池
const agents = {
  'http:': new http.Agent({
    keepAlive: true,
    maxSockets: CFG.MAX_SOCKETS,
    maxFreeSockets: Math.min(8, CFG.MAX_SOCKETS),
    timeout: 60000,
  }),
  'https:': new https.Agent({
    keepAlive: true,
    maxSockets: CFG.MAX_SOCKETS,
    maxFreeSockets: Math.min(8, CFG.MAX_SOCKETS),
    timeout: 60000,
  }),
};

// ---------------------------------------------------------------- Cookie
const cookies = new Map(); // host -> Map(name -> value)

function cookieHeader(host) {
  const m = cookies.get(host);
  if (!m || m.size === 0) return '';
  return [...m.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

function storeCookies(host, setCookie) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  let m = cookies.get(host);
  if (!m) {
    m = new Map();
    cookies.set(host, m);
  }
  for (const line of list) {
    const first = String(line).split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (k) m.set(k, v);
  }
}

// ---------------------------------------------------------------- 错误分类
const RETRY_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_SOCKET_CLOSED',
]);
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

function isRetryable(err) {
  if (!err) return false;
  if (err.aborted) return false;
  if (err.retryable !== undefined) return err.retryable;
  if (err.code && RETRY_CODES.has(err.code)) return true;
  const m = String(err.message || '');
  return /socket hang up|timeout|超时|aborted|network|reset/i.test(m);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error('已取消');
  e.aborted = true;
  e.retryable = false;
  return e;
}

// ---------------------------------------------------------------- 单次请求
function once(urlStr, opts) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('非法地址: ' + urlStr));
    }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const signal = opts.signal;
    if (signal && signal.aborted) return reject(abortError());

    const headers = Object.assign(
      {
        'User-Agent': UA,
        Accept: opts.accept || '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // 分片是二进制，不压缩，省掉解压 CPU
        'Accept-Encoding': opts.encoding === 'identity' ? 'identity' : 'gzip, deflate',
        Connection: 'keep-alive',
      },
      opts.headers || {}
    );
    const ck = cookieHeader(u.hostname);
    if (ck) headers.Cookie = ck;

    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        agent: opts.agent || agents[u.protocol],
      },
      (res) => {
        storeCookies(u.hostname, res.headers['set-cookie']);

        // 重定向
        const sc = res.statusCode;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          const depth = (opts._depth || 0) + 1;
          if (depth > 5) return done(reject, new Error('重定向次数过多: ' + urlStr));
          const next = new URL(res.headers.location, urlStr).toString();
          once(next, Object.assign({}, opts, { _depth: depth })).then(
            (r) => done(resolve, r),
            (e) => done(reject, e)
          );
          return;
        }

        if (sc !== 200 && sc !== 206) {
          res.resume();
          const err = new Error('HTTP ' + sc + ' <- ' + urlStr);
          err.status = sc;
          err.retryable = RETRY_STATUS.has(sc);
          return done(reject, err);
        }

        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        let bytes = 0;
        stream.on('data', (c) => {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
          bytes += b.length;
          chunks.push(b);
        });
        stream.on('end', () =>
          done(resolve, {
            buffer: Buffer.concat(chunks, bytes),
            headers: res.headers,
            status: sc,
            url: urlStr,
            bytes,
          })
        );
        stream.on('error', (e) => {
          e.retryable = true;
          done(reject, e);
        });
        // 服务端提前断开
        res.on('aborted', () => {
          const e = new Error('连接被中断');
          e.retryable = true;
          done(reject, e);
        });
      }
    );

    const timeout = opts.timeout || CFG.HTTP_TIMEOUT;
    // 空闲超时
    req.setTimeout(timeout, () => {
      const e = new Error('请求超时: ' + urlStr);
      e.code = 'ETIMEDOUT';
      e.retryable = true;
      req.destroy(e);
    });
    // 整体超时（含 DNS + 握手 + 传输）
    const deadline = setTimeout(() => {
      const e = new Error('请求超时(整体): ' + urlStr);
      e.code = 'ETIMEDOUT';
      e.retryable = true;
      req.destroy(e);
    }, timeout * 3);

    function onAbort() {
      const e = abortError();
      req.destroy(e);
      done(reject, e);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      clearTimeout(deadline);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    req.on('error', (e) => {
      if (e && e.aborted) return done(reject, e);
      done(reject, e);
    });
    req.end(opts.body);
  });
}

/**
 * 带重试的请求
 * @param {string} url
 * @param {object} opts { headers, method, timeout, retry, signal, encoding, accept, body }
 */
async function request(url, opts = {}) {
  const retry = opts.retry === undefined ? CFG.HTTP_RETRY : opts.retry;
  let lastErr = null;
  for (let i = 0; i <= retry; i++) {
    if (opts.signal && opts.signal.aborted) throw abortError();
    try {
      return await once(url, opts);
    } catch (e) {
      lastErr = e;
      if (e && e.aborted) throw e;
      if (i >= retry || !isRetryable(e)) break;
      const base = opts.retryDelay || 400;
      await sleep(Math.min(6000, base * Math.pow(2, i)) + Math.floor(Math.random() * 200), opts.signal);
    }
  }
  throw lastErr || new Error('请求失败');
}

async function getBuffer(url, opts) {
  const r = await request(url, opts);
  return r.buffer;
}

async function getText(url, opts) {
  const r = await request(url, Object.assign({ accept: 'text/html,application/xhtml+xml,*/*' }, opts));
  return r.buffer.toString('utf8');
}

/** 多地址容错：按顺序尝试，全部失败才抛错 */
async function getTextFromAny(urls, opts) {
  let lastErr = null;
  for (const u of urls) {
    try {
      return await getText(u, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('全部地址均失败');
}

module.exports = { request, getBuffer, getText, getTextFromAny, UA, agents, isRetryable, abortError };
