'use strict';
/**
 * 极简 HTTP(S) 客户端 - 零第三方依赖
 * 支持 gzip/deflate、自动跟随重定向、超时控制
 */
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 发起请求，返回 { buffer, headers, status, url }
 */
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = Object.assign(
      {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'keep-alive',
      },
      opts.headers || {}
    );

    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        timeout: opts.timeout || 30000,
      },
      (res) => {
        // 跟随重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return request(next, opts).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' <- ' + url));
        }
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on('end', () =>
          resolve({
            buffer: Buffer.concat(chunks),
            headers: res.headers,
            status: res.statusCode,
            url: url,
          })
        );
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时: ' + url)));
    req.on('error', reject);
    req.end();
  });
}

async function getBuffer(url, opts) {
  const r = await request(url, opts);
  return r.buffer;
}

async function getText(url, opts) {
  const r = await request(url, opts);
  return r.buffer.toString('utf8');
}

module.exports = { request, getBuffer, getText, UA };
