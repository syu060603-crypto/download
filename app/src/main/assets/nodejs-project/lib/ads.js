'use strict';
/**
 * 广告分片识别
 *
 * 站方的插播广告是「整段换一条编码链」塞进 m3u8 的：
 *
 *   ...正片分片...
 *   #EXT-X-DISCONTINUITY      <- 广告开始
 *   #EXTINF:4.00, ad-01.ts    <- 1080p、PTS 从 0 重新计时
 *   ...
 *   #EXT-X-DISCONTINUITY      <- 回到正片
 *   #EXTINF:5.76, main.ts     <- 720p、PTS 接着之前往下走
 *
 * 所以有两条互相独立的判据，任一条成立即认定为广告：
 *   1. **流参数指纹不同**：分辨率 / profile-level / 音频参数 / PID 集合变了。
 *   2. **时间轴重启**：该块首帧 PTS 接近 0（正片块不会，正片是一直递增的）。
 *
 * 关键性质：正片两侧的 PTS 是连续的（实测 297.69 + 3.84 = 301.53），
 * 因此**直接丢掉广告块**，剩下的分片拼起来时间轴依然连续，不需要重写 PTS。
 *
 * 探测成本：只取每个候选块首片的头 64KB（HTTP Range），通常 2~5 个请求。
 */
const CFG = require('../config');
const { getBuffer } = require('./http');
const { analyze } = require('./tsinfo');

const REFERER = CFG.SITE + '/';

const cache = new Map(); // key -> { ts, result }
const CACHE_TTL = 60 * 60 * 1000;
const CACHE_MAX = 200;

function cachePut(k, v) {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(k, v);
}

/** 播放列表指纹（用于跨次复用探测结果） */
function playlistKey(segs, discs) {
  if (!segs.length) return '';
  return segs.length + '|' + segs[0].url.replace(/^https?:\/\/[^/]+/, '') + '|' + (discs || []).join(',');
}

/** 由 DISC 位置切块 */
function buildBlocks(segs, discs) {
  const n = segs.length;
  const marks = [0];
  for (const d of discs || []) {
    if (d > 0 && d < n && marks[marks.length - 1] !== d) marks.push(d);
  }
  if (marks[marks.length - 1] !== n) marks.push(n);

  const blocks = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const from = marks[i];
    const to = marks[i + 1];
    if (to <= from) continue;
    let seconds = 0;
    for (let k = from; k < to; k++) seconds += segs[k].duration || 0;
    blocks.push({ from, to, segments: to - from, seconds });
  }
  return blocks;
}

/** 只取分片开头一段，解析流参数 */
async function probe(seg, signal) {
  if (!seg) return null;
  try {
    const buf = await getBuffer(seg.url, {
      headers: {
        Referer: REFERER,
        Range: 'bytes=0-' + (CFG.AD_PROBE_BYTES - 1),
      },
      timeout: 15000,
      retry: 2,
      encoding: 'identity',
      signal,
    });
    if (!buf || buf.length < 188 || buf[0] !== 0x47) return null;
    const a = analyze(buf);
    if (!a.ok && !a.sampleRate) return null;
    return a;
  } catch (e) {
    if (e && e.aborted) throw e;
    return null;
  }
}

function emptyResult(reason) {
  return {
    enabled: true,
    ok: false,
    reason: reason || '',
    totalSeconds: 0,
    baseline: null,
    blocks: [],
    ranges: [],
    removedSegments: 0,
    removedSeconds: 0,
  };
}

/**
 * 识别广告块
 * @param {Array} segs parseMedia 得到的原始分片
 * @param {Array<number>} discs 每个 #EXT-X-DISCONTINUITY 之后第一个分片的下标
 * @param {object} opts { signal }
 */
async function detect(segs, discs, opts = {}) {
  const signal = opts.signal || null;
  if (!segs || !segs.length) return emptyResult('无分片');

  const key = playlistKey(segs, discs);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.result;

  const blocks = buildBlocks(segs, discs);
  const totalSeconds = blocks.reduce((a, b) => a + b.seconds, 0);

  // 只有一块 = 全片没有断点，不存在插播广告
  if (blocks.length < 2) {
    const r = Object.assign(emptyResult('无断点'), { ok: true, blocks, totalSeconds });
    cachePut(key, { ts: Date.now(), result: r });
    return r;
  }

  const maxBlock = CFG.AD_MAX_BLOCK_SECONDS;
  // 基准块：最长的那个块基本一定是正片
  let baseIdx = 0;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].seconds > blocks[baseIdx].seconds) baseIdx = i;
  }

  const baseProbe = await probe(segs[blocks[baseIdx].from], signal);
  if (!baseProbe) {
    // 探测失败就别乱删，宁可保留广告也不要删错正片
    return Object.assign(emptyResult('基准探测失败'), { blocks, totalSeconds });
  }
  const baseline = baseProbe;

  let removedSegments = 0;
  let removedSeconds = 0;
  const ranges = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i === baseIdx) {
      b.ad = false;
      b.reason = '基准';
      continue;
    }
    // 广告块一定很短；长块直接跳过，省掉探测请求
    if (b.seconds > maxBlock) {
      b.ad = false;
      b.reason = '长块';
      continue;
    }

    const p = await probe(segs[b.from], signal);
    if (!p) {
      b.ad = false;
      b.reason = '探测失败';
      continue;
    }

    const diffFp = p.fingerprint !== baseline.fingerprint;
    const restart = p.firstPts !== null && p.firstPts < CFG.AD_PTS_RESTART;
    b.fingerprint = p.fingerprint;
    b.firstPts = p.firstPts;

    // 两个信号同时成立才判广告（取交集，宁可不删也不删错）：
    //  - 广告是另一条编码链产的 -> 分辨率/profile 不同；
    //  - 广告的时间轴从 0 重新计时 -> 首帧 PTS 接近 0。
    // 真正的多段拼接（比如上下部拼一起）虽然 PTS 也会从 0 开始，但编码参数一致，
    // 用交集就能保住它。PTS 读不出来时退化成只看参数，避免漏判。
    if (p.firstPts === null) {
      b.ad = diffFp;
      b.reason = diffFp ? '流参数不同(PTS未知)' : '';
    } else {
      b.ad = diffFp && restart;
      b.reason = b.ad ? '流参数不同+时间轴重启' : '';
    }

    if (b.ad) {
      ranges.push({
        from: b.from,
        to: b.to,
        segments: b.segments,
        seconds: Math.round(b.seconds),
      });
      removedSegments += b.segments;
      removedSeconds += b.seconds;
    }
  }

  // 安全阀：删得太多说明判断逻辑出问题了，宁可全留
  const ratio = totalSeconds > 0 ? removedSeconds / totalSeconds : 0;
  if (ratio > CFG.AD_MAX_RATIO) {
    return Object.assign(emptyResult('剔除比例过高，已放弃'), { blocks, totalSeconds, baseline });
  }

  const result = {
    enabled: true,
    ok: true,
    totalSeconds: Math.round(totalSeconds),
    baseline: {
      width: baseline.width,
      height: baseline.height,
      sampleRate: baseline.sampleRate,
      fingerprint: baseline.fingerprint,
    },
    blocks,
    ranges,
    removedSegments,
    removedSeconds: Math.round(removedSeconds),
  };
  cachePut(key, { ts: Date.now(), result });
  return result;
}

/** 由广告区间算出要保留的分片下标 */
function buildKeep(n, ranges) {
  const list = (ranges || []).slice().sort((a, b) => a.from - b.from);
  const keep = [];
  let r = 0;
  for (let i = 0; i < n; i++) {
    while (r < list.length && i >= list[r].to) r++;
    if (r < list.length && i >= list[r].from && i < list[r].to) continue;
    keep.push(i);
  }
  return keep;
}

/** 给界面用的简短描述 */
function summary(info) {
  if (!info || !info.ranges || !info.ranges.length) return '';
  const s = info.removedSeconds >= 60
    ? Math.floor(info.removedSeconds / 60) + ' 分 ' + (info.removedSeconds % 60) + ' 秒'
    : info.removedSeconds + ' 秒';
  return '剔除 ' + info.ranges.length + ' 段广告 · ' + s;
}

module.exports = { detect, buildKeep, buildBlocks, probe, summary, playlistKey, _cache: cache };
