'use strict';
/**
 * HLS(m3u8) 解析与下载
 *
 * 相比初版的关键改进：
 *  1. **断点续传**：分片严格顺序写盘，同时把已写分片数记录在 .part.json，
 *     中断/取消/切后台被杀后再点下载，从断点继续，而不是整集重下。
 *  2. **有界窗口**：内存中最多缓存 N 个分片，慢分片不会让内存无限膨胀（防 OOM）。
 *  3. **异步写盘**：初版每个分片都 fs.writeFileSync，Node 单线程会被磁盘写阻塞，
 *     600+ 分片时明显拖慢整体速度；现在改成异步写 + 单写者保证顺序。
 *  4. **分片级重试 + 内容校验**：校验 TS 同步字节 0x47，拿到错误页会自动重试。
 *  5. **速度/剩余时间**：给界面提供实时速率与 ETA。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CFG = require('../config');
const { getBuffer, getText } = require('./http');
const ads = require('./ads');

const REFERER = CFG.SITE + '/';

function absUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch (e) {
    if (/^https?:\/\//i.test(ref)) return ref;
    const i = base.lastIndexOf('/');
    return i > 0 ? base.slice(0, i + 1) + ref : ref;
  }
}

/** 主播放列表 -> 变体 */
function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
      const bw = /BANDWIDTH=(\d+)/i.exec(lines[i]);
      const res = /RESOLUTION=([\dx]+)/i.exec(lines[i]);
      const uri = lines[i + 1];
      if (uri && uri.charAt(0) !== '#') {
        variants.push({
          bandwidth: bw ? parseInt(bw[1], 10) : 0,
          resolution: res ? res[1] : '',
          url: absUrl(base, uri),
        });
      }
    }
  }
  return variants;
}

/** 媒体播放列表 -> 分片 */
function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segs = [];
  const discs = []; // 每个 #EXT-X-DISCONTINUITY 之后第一个分片的下标
  let key = null;
  let duration = 0;
  let mapUrl = null;
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
    if (l.indexOf('#EXT-X-DISCONTINUITY') === 0 && l.charAt(19) !== '-') {
      // 注意排除 #EXT-X-DISCONTINUITY-SEQUENCE
      if (discs[discs.length - 1] !== segs.length) discs.push(segs.length);
    } else if (l.indexOf('#EXT-X-KEY') === 0) {
      const method = /METHOD=([^,]+)/i.exec(l);
      const uri = /URI="([^"]+)"/i.exec(l);
      const iv = /IV=0x([0-9a-fA-F]+)/i.exec(l);
      key = {
        method: method ? method[1].toUpperCase() : 'NONE',
        url: uri ? absUrl(base, uri[1]) : null,
        iv: iv ? iv[1] : null,
      };
    } else if (l.indexOf('#EXT-X-MAP') === 0) {
      const uri = /URI="([^"]+)"/i.exec(l);
      if (uri) mapUrl = absUrl(base, uri[1]);
    } else if (l.indexOf('#EXTINF') === 0) {
      const d = /([\d.]+)/.exec(l.split(':')[1] || '');
      duration = d ? parseFloat(d[1]) : 0;
    } else if (l.charAt(0) !== '#') {
      segs.push({ url: absUrl(base, l), iv: key && key.iv ? key.iv : null, seq, duration });
      seq++;
    }
  }
  const totalDuration = segs.reduce((a, s) => a + s.duration, 0);
  return { segs, discs, key, mapUrl, mediaSeq, totalDuration };
}

function ivBuffer(seg) {
  if (seg.iv) {
    const b = Buffer.from(seg.iv, 'hex');
    if (b.length === 16) return b;
  }
  const b = Buffer.alloc(16);
  b.writeUInt32BE(seg.seq >>> 0, 12);
  return b;
}

function pickVariant(variants, prefer) {
  if (!variants || variants.length === 0) return null;
  const sorted = variants.slice().sort((a, b) => b.bandwidth - a.bandwidth);
  if (prefer === 'worst' || prefer === 'lowest' || prefer === 'saver') return sorted[sorted.length - 1];
  return sorted[0];
}

async function fetchPlaylist(url, signal) {
  const text = await getText(url, {
    headers: { Referer: REFERER },
    timeout: 20000,
    retry: 3,
    signal,
  });
  if (!/#EXTM3U/.test(text)) throw new Error('播放列表无效（可能已过期）');
  return text;
}

/** 跟随 master -> media */
async function resolveMediaPlaylist(m3u8Url, opts = {}) {
  const text = await fetchPlaylist(m3u8Url, opts.signal);
  const variants = parseMaster(text, m3u8Url);
  if (variants.length > 0) {
    const chosen = pickVariant(variants, opts.quality);
    const mText = await fetchPlaylist(chosen.url, opts.signal);
    return { text: mText, base: chosen.url, variant: chosen, variants, master: true };
  }
  return { text, base: m3u8Url, variant: null, variants: [], master: false };
}

// ---------------------------------------------------------------- 工具
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('已取消'), { aborted: true }));
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(Object.assign(new Error('已取消'), { aborted: true }));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function looksLikeSegment(buf) {
  if (!buf || buf.length < 188) return false;
  if (buf[0] === 0x47) return true; // MPEG-TS
  const head = buf.slice(0, 64).toString('utf8').toLowerCase();
  if (head.indexOf('<!doctype') >= 0 || head.indexOf('<html') >= 0) return false;
  // fMP4 分片：以 box 长度开头
  return buf.length > 8;
}

async function fetchSegment(seg, opts) {
  const retry = opts.retry === undefined ? CFG.SEGMENT_RETRY : opts.retry;
  let lastErr = null;
  for (let i = 0; i <= retry; i++) {
    if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
    try {
      const buf = await getBuffer(seg.url, {
        headers: { Referer: REFERER },
        timeout: CFG.SEGMENT_TIMEOUT,
        retry: 0,
        encoding: 'identity',
        signal: opts.signal,
      });
      if (!looksLikeSegment(buf)) throw new Error('分片内容异常');
      return buf;
    } catch (e) {
      lastErr = e;
      if (e && e.aborted) throw e;
      if (i < retry) await sleep(300 * Math.pow(2, i) + Math.floor(Math.random() * 200), opts.signal);
    }
  }
  throw lastErr || new Error('分片下载失败');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (e) {
    /* noop */
  }
}

// ---------------------------------------------------------------- 下载
/**
 * 下载整集
 * @param {string} m3u8Url
 * @param {string} outFile
 * @param {object} opts { concurrency, signal, onProgress, quality, resume, stripAds }
 * @returns {Promise<{total,bytes,segments,bandwidth,resumed,ads}>}
 */
async function downloadEpisode(m3u8Url, outFile, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || CFG.SEGMENT_CONCURRENCY, 64));
  const onProgress = opts.onProgress || function () {};
  const signal = opts.signal || null;
  const partFile = outFile + '.part';
  const stateFile = outFile + '.part.json';

  const { text, base, variant, variants } = await resolveMediaPlaylist(m3u8Url, {
    signal,
    quality: opts.quality,
  });
  const media = parseMedia(text, base);
  const allSegs = media.segs;
  if (!allSegs.length) throw new Error('播放列表中没有分片');

  // ---------------------------------------------------------------- 广告剔除
  // 广告块被两段 #EXT-X-DISCONTINUITY 包住，编码参数与正片不同、时间轴从 0 重来。
  // 直接丢掉这些分片即可：正片两侧的 PTS 本来就是连着的，不需要重写时间戳。
  const playlistSig = ads.playlistKey(allSegs, media.discs);
  const prevState = readJson(stateFile);
  const prevChecked =
    prevState && prevState.playlistSig === playlistSig && Array.isArray(prevState.adRanges);

  let adInfo = null;
  let adRanges = [];
  if (opts.stripAds !== false && CFG.STRIP_ADS) {
    if (prevChecked) {
      // 上次已经探测过：直接复用，避免重下时探测结果抖动导致断点失效
      adRanges = prevState.adRanges;
      let segsN = 0;
      let secs = 0;
      for (const r of adRanges) {
        segsN += r.segments || 0;
        secs += r.seconds || 0;
      }
      adInfo = { enabled: true, ok: true, ranges: adRanges, removedSegments: segsN, removedSeconds: Math.round(secs), reused: true };
    } else {
      adInfo = await ads.detect(allSegs, media.discs, { signal });
      adRanges = (adInfo && adInfo.ranges) || [];
    }
  }

  let keep = adRanges.length ? ads.buildKeep(allSegs.length, adRanges) : null;
  if (keep && !keep.length) {
    // 理论上不会发生（有 AD_MAX_RATIO 兜底），真发生了就退化为不剔除
    keep = null;
    adRanges = [];
    adInfo = null;
  }
  const segs = keep ? keep.map((i) => allSegs[i]) : allSegs;
  const adSummary =
    adRanges.length && adInfo
      ? {
          ranges: adRanges.length,
          segments: adInfo.removedSegments || 0,
          seconds: adInfo.removedSeconds || 0,
        }
      : null;

  // 指纹：用于判断 .part 是否属于同一次下载（不含域名/token，重新解析后仍可续传）
  const sig =
    segs.length +
    '|' +
    segs[0].url.replace(/^https?:\/\/[^/]+/, '') +
    (adRanges.length ? '|ad' + adRanges.map((r) => r.from + '-' + r.to).join('.') : '');

  let keyBuf = null;
  if (media.key && media.key.method === 'AES-128' && media.key.url) {
    keyBuf = await getBuffer(media.key.url, {
      headers: { Referer: REFERER },
      timeout: 20000,
      retry: 3,
      encoding: 'identity',
      signal,
    });
    if (keyBuf.length !== 16) throw new Error('AES 密钥长度异常: ' + keyBuf.length);
  }

  const total = segs.length;
  let startIdx = 0;
  let bytes = 0;
  let resumed = false;

  // ---- 断点续传判定
  if (opts.resume !== false) {
    const st = readJson(stateFile);
    if (st && st.sig === sig && st.written > 0 && st.written < total) {
      try {
        const size = fs.statSync(partFile).size;
        if (size >= (st.bytes || 0) - 4096) {
          startIdx = st.written;
          bytes = size;
          resumed = true;
        }
      } catch (e) {
        startIdx = 0;
      }
    }
  }

  // 先上报一次总片数：界面立刻能显示 x/总片数，而不是 0/0
  onProgress({ done: startIdx, total, bytes, speed: 0, eta: 0, resumed, ads: adSummary });

  const fd = fs.openSync(partFile, startIdx > 0 ? 'a' : 'w');
  let closed = false;
  const closeFd = () => {
    if (closed) return;
    closed = true;
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* noop */
    }
  };

  // ---- 写盘：单写者，严格顺序
  const pending = new Map(); // idx -> Buffer
  let nextWrite = startIdx; // 下一个要写的分片
  let waiters = [];
  let failed = null;
  const notify = () => {
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  };
  const waitSignal = () => new Promise((r) => waiters.push(r));

  const maxPending = Math.max(4, concurrency * 3);

  const writeOne = (buf) =>
    new Promise((resolve, reject) => {
      fs.write(fd, buf, 0, buf.length, null, (e) => (e ? reject(e) : resolve()));
    });

  const writer = (async () => {
    try {
      while (nextWrite < total) {
        if (failed) break;
        const buf = pending.get(nextWrite);
        if (buf === undefined) {
          await waitSignal();
          continue;
        }
        pending.delete(nextWrite);
        await writeOne(buf);
        bytes += buf.length;
        nextWrite++;
        notify();
      }
    } catch (e) {
      failed = failed || e;
      notify();
    }
  })();

  // ---- 进度节流 + 速率
  let lastEmit = 0;
  let samples = [];
  let avgSegBytes = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    samples.push({ t: now, b: bytes });
    if (samples.length > 8) samples.shift();
    let speed = 0;
    if (samples.length >= 2) {
      const first = samples[0];
      const dt = (now - first.t) / 1000;
      if (dt > 0.2) speed = (bytes - first.b) / dt;
    }
    const done = nextWrite - startIdx;
    const remainSegs = total - nextWrite;
    const perSeg = done > 0 ? bytes / Math.max(1, nextWrite) : 0;
    const eta = speed > 0 ? Math.round((remainSegs * (perSeg || avgSegBytes || 0)) / speed) : 0;
    onProgress({
      done: nextWrite,
      total,
      bytes,
      speed: Math.round(speed),
      eta: Math.max(0, Math.min(eta, 86400)),
      resumed,
      ads: adSummary,
    });
  };

  // ---- 拉取
  let nextFetch = startIdx;
  const abortErr = () => Object.assign(new Error('已取消'), { aborted: true });

  const worker = async () => {
    for (;;) {
      if (failed) return;
      if (signal && signal.aborted) throw abortErr();
      while (pending.size >= maxPending && !failed) {
        await waitSignal();
      }
      if (failed) return;
      const idx = nextFetch++;
      if (idx >= total) return;
      const seg = segs[idx];
      let buf = await fetchSegment(seg, { signal, retry: CFG.SEGMENT_RETRY });
      if (keyBuf) {
        const d = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuffer(seg));
        buf = Buffer.concat([d.update(buf), d.final()]);
      }
      if (failed) return;
      if (signal && signal.aborted) throw abortErr();
      pending.set(idx, buf);
      if (!avgSegBytes) avgSegBytes = buf.length;
      notify();
      emit(false);
    }
  };

  // 状态文件同时记下广告剔除方案：重下时直接复用，不重新探测（探测结果抖动会让断点失效）
  const saveState = () =>
    writeJson(stateFile, {
      sig,
      total,
      written: nextWrite,
      bytes,
      ts: Date.now(),
      playlistSig,
      adRanges,
    });

  const stateSaver = setInterval(() => {
    if (nextWrite > startIdx) saveState();
  }, 2000);

  try {
    // fMP4 初始化段
    if (media.mapUrl && startIdx === 0) {
      try {
        const init = await getBuffer(media.mapUrl, {
          headers: { Referer: REFERER },
          timeout: 20000,
          retry: 2,
          encoding: 'identity',
          signal,
        });
        await writeOne(init);
        bytes += init.length;
      } catch (e) {
        /* 拿不到 init 段不致命 */
      }
    }

    emit(true);
    const pool = [];
    for (let i = 0; i < Math.min(concurrency, Math.max(1, total - startIdx)); i++) pool.push(worker());
    await Promise.all(pool);
    await writer;
    if (failed) throw failed;
  } catch (e) {
    failed = e;
    notify();
    // 让写者尽快退出
    await writer.catch(() => {});
    writeJson(stateFile, { sig, total, written: nextWrite, bytes, ts: Date.now(), playlistSig, adRanges });
    closeFd();
    if (e && e.aborted) {
      throw e; // 保留 .part 以便续传
    }
    throw e;
  } finally {
    clearInterval(stateSaver);
    closeFd();
  }

  if (signal && signal.aborted) throw abortErr();
  if (nextWrite < total) throw new Error('下载未完成（' + nextWrite + '/' + total + '）');

  emit(true);
  // 完成：改名并清理续传标记
  try {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    fs.renameSync(partFile, outFile);
  } catch (e) {
    throw new Error('保存文件失败: ' + e.message);
  }
  try {
    fs.unlinkSync(stateFile);
  } catch (e) {
    /* noop */
  }

  return {
    total,
    bytes,
    segments: segs.length,
    sourceSegments: allSegs.length,
    bandwidth: variant ? variant.bandwidth : 0,
    resolution: variant ? variant.resolution : '',
    variants: variants.map((v) => ({ bandwidth: v.bandwidth, resolution: v.resolution })),
    resumed,
    ads: adSummary,
  };
}

/** 只探测播放列表信息（给界面显示清晰度用） */
async function probe(m3u8Url, opts = {}) {
  const r = await resolveMediaPlaylist(m3u8Url, opts);
  const m = parseMedia(r.text, r.base);
  return {
    variants: r.variants,
    segments: m.segs.length,
    duration: m.totalDuration,
    encrypted: !!(m.key && m.key.method === 'AES-128'),
    discontinuities: m.discs.length,
  };
}

module.exports = {
  absUrl,
  parseMaster,
  parseMedia,
  pickVariant,
  resolveMediaPlaylist,
  downloadEpisode,
  probe,
  SITE: CFG.SITE,
};