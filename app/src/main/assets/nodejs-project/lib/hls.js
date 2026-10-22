'use strict';
/**
 * HLS (m3u8) 解析与下载
 *
 * 逆向结论:
 *   站方 CDN 返回的 m3u8 为「主播放列表(master)」, 形如:
 *     #EXTM3U
 *     #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=800000,RESOLUTION=1080x608
 *     2000k/hls/mixed.m3u8
 *   需再取变体(media)播放列表, 其中为相对路径的 .ts 分片。
 *   本例 43 分钟剧集 -> 652 个 .ts 分片, 无 AES 加密。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBuffer, getText } = require('./http');

const SITE = 'https://www.xckcdy.com';

function absUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch (e) {
    if (/^https?:\/\//i.test(ref)) return ref;
    // 兜底: 基于 base 目录拼接
    const i = base.lastIndexOf('/');
    return i > 0 ? base.slice(0, i + 1) + ref : ref;
  }
}

/** 解析主播放列表 -> 变体列表 */
function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
      const bw = /BANDWIDTH=(\d+)/.exec(lines[i]);
      const res = /RESOLUTION=([\dx]+)/i.exec(lines[i]);
      const uriLine = lines[i + 1];
      if (uriLine && uriLine.charAt(0) !== '#') {
        variants.push({
          bandwidth: bw ? parseInt(bw[1], 10) : 0,
          resolution: res ? res[1] : '',
          url: absUrl(base, uriLine),
        });
      }
    }
  }
  return variants;
}

/**
 * 解析媒体播放列表 -> { segs:[{url,iv,duration}], key, mediaSeq }
 * 处理 EXT-X-KEY (AES-128)
 */
function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segs = [];
  let key = null;
  let duration = 0;

  let mediaSeq = 0;
  for (const l of lines) {
    if (l.indexOf('#EXT-X-MEDIA-SEQUENCE') === 0) {
      const m = /:(\d+)/.exec(l);
      if (m) mediaSeq = parseInt(m[1], 10);
      break;
    }
  }
  let seq = mediaSeq;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.indexOf('#EXT-X-KEY') === 0) {
      const method = /METHOD=([^,]+)/.exec(l);
      const uri = /URI="([^"]+)"/.exec(l);
      const iv = /IV=0x([0-9a-fA-F]+)/.exec(l);
      key = {
        method: method ? method[1] : 'NONE',
        url: uri ? absUrl(base, uri[1]) : null,
        iv: iv ? iv[1] : null,
      };
    } else if (l.indexOf('#EXTINF') === 0) {
      const d = /([\d.]+)/.exec(l.split(':')[1] || '');
      duration = d ? parseFloat(d[1]) : 0;
    } else if (l.charAt(0) !== '#') {
      segs.push({ url: absUrl(base, l), iv: key && key.iv ? key.iv : null, seq: seq, duration: duration });
      seq++;
    }
  }
  return { segs, key, mediaSeq, totalDuration: segs.reduce((a, s) => a + s.duration, 0) };
}

function ivBuffer(seg) {
  if (seg.iv) {
    const b = Buffer.from(seg.iv, 'hex');
    if (b.length === 16) return b;
  }
  // 未显式给出 IV 时, 按 HLS 规范使用媒体序列号作为 128bit 大端 IV
  const b = Buffer.alloc(16);
  b.writeUInt32BE(seg.seq >>> 0, 12);
  return b;
}

function pickVariant(variants, prefer) {
  if (!variants || variants.length === 0) return null;
  const sorted = variants.slice().sort((a, b) => b.bandwidth - a.bandwidth);
  if (prefer === 'lowest') return sorted[sorted.length - 1];
  // 默认取最高码率
  return sorted[0];
}

async function fetchWithRetry(url, tries = 3, timeout = 30000) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await getBuffer(url, { headers: { Referer: SITE + '/' }, timeout });
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 获取媒体播放列表(自动跟随 master)
 */
async function resolveMediaPlaylist(m3u8Url) {
  const text = await getText(m3u8Url, { headers: { Referer: SITE + '/' }, timeout: 20000 });
  const variants = parseMaster(text, m3u8Url);
  if (variants.length > 0) {
    const chosen = pickVariant(variants);
    const mText = await getText(chosen.url, { headers: { Referer: SITE + '/' }, timeout: 20000 });
    return { text: mText, base: chosen.url, variant: chosen, master: true, variants };
  }
  return { text, base: m3u8Url, variant: null, master: false, variants: [] };
}

/**
 * 下载整集并写入文件
 * 分段并发下载, 但严格按分片顺序写入, 保证输出为连续可播的 TS
 */
async function downloadEpisode(m3u8Url, outFile, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || 8, 64));
  const onProgress = opts.onProgress || function () {};
  const signal = opts.signal || null;
  const partFile = outFile + '.part';

  const { text, base, variant } = await resolveMediaPlaylist(m3u8Url);
  const media = parseMedia(text, base);
  const segs = media.segs;
  if (!segs.length) throw new Error('播放列表中没有分片');

  let keyBuf = null;
  if (media.key && media.key.method === 'AES-128' && media.key.url) {
    keyBuf = await fetchWithRetry(media.key.url, 3, 20000);
    if (keyBuf.length !== 16) throw new Error('AES 密钥长度异常: ' + keyBuf.length);
  }

  const total = segs.length;
  let bytes = 0;
  let written = 0;          // 已写入文件的分片数(严格有序)
  let nextFetch = 0;        // 下一个待取的分片下标
  const pending = new Map(); // idx -> Buffer

  const fd = fs.openSync(partFile, 'w');
  const abortErr = new Error('已取消');

  const flushReady = () => {
    // 按序写出所有已就绪的连续分片 —— 慢分片不会阻塞后续写入
    let b;
    while ((b = pending.get(written)) !== undefined) {
      pending.delete(written);
      fs.writeFileSync(fd, b);
      bytes += b.length;
      written++;
    }
    onProgress({ done: written, total, bytes, bandwidth: variant ? variant.bandwidth : 0 });
  };

  const worker = async () => {
    for (;;) {
      if (signal && signal.cancelled) throw abortErr;
      const idx = nextFetch++;
      if (idx >= total) return;
      const seg = segs[idx];
      let buf = await fetchWithRetry(seg.url, 3, 30000);
      if (keyBuf) {
        const d = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuffer(seg));
        buf = Buffer.concat([d.update(buf), d.final()]);
      }
      if (signal && signal.cancelled) throw abortErr;
      pending.set(idx, buf);
      flushReady();
    }
  };

  try {
    const pool = [];
    for (let i = 0; i < Math.min(concurrency, total); i++) pool.push(worker());
    await Promise.all(pool);
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* noop */ }
  }

  if (signal && signal.cancelled) {
    try { fs.unlinkSync(partFile); } catch (e) { /* noop */ }
    throw abortErr;
  }

  fs.renameSync(partFile, outFile);
  return { total, bytes, segments: segs.length, bandwidth: variant ? variant.bandwidth : 0 };
}

module.exports = {
  absUrl,
  parseMaster,
  parseMedia,
  pickVariant,
  resolveMediaPlaylist,
  downloadEpisode,
  SITE,
};
