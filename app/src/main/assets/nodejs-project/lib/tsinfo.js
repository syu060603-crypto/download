'use strict';
/**
 * MPEG-TS 轻量分析（零依赖）
 *
 * 用途：从一个 .ts 分片的字节里读出「流参数指纹」——视频分辨率、H.264
 * profile/level、音频采样率/声道、PID 集合。站方插广告时，广告片是另一条
 * 编码链产的，指纹必然和正片不同，这是识别广告最可靠的信号。
 *
 * 另外还取首帧 PTS：插播广告的时间轴是从 0 重新开始的，正片是连续递增的，
 * 所以「PTS 突然回到接近 0」同样能判定为插播块。
 */

// ---------------------------------------------------------------- 位读取
function BitReader(buf) {
  let bit = 0;
  return {
    u(n) {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = buf[bit >> 3];
        if (byte === undefined) throw new Error('eof');
        v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
        bit++;
      }
      return v >>> 0;
    },
    ue() {
      let zeros = 0;
      while (this.u(1) === 0) {
        if (++zeros > 32) throw new Error('bad ue');
      }
      return zeros === 0 ? 0 : Math.pow(2, zeros) - 1 + this.u(zeros);
    },
    se() {
      const k = this.ue();
      return k & 1 ? (k + 1) >> 1 : -(k >> 1);
    },
  };
}

/** 去掉 H.264 的 0x000003 防竞争字节 */
function unescapeRbsp(b) {
  const out = Buffer.alloc(b.length);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    if (i >= 2 && b[i] === 0x03 && b[i - 1] === 0x00 && b[i - 2] === 0x00) continue;
    out[o++] = b[i];
  }
  return out.subarray(0, o);
}

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
const SUB_W = [1, 2, 2, 1];
const SUB_H = [1, 2, 1, 1];

/** 解析 H.264 SPS，得到分辨率 */
function parseSps(rbsp) {
  const r = BitReader(rbsp);
  const profile = r.u(8);
  r.u(8);
  const level = r.u(8);
  r.ue();
  let chromaFormat = 1;
  let separateColour = 0;
  if (HIGH_PROFILES.indexOf(profile) >= 0) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separateColour = r.u(1);
    r.ue();
    r.ue();
    r.u(1);
    if (r.u(1)) {
      const n = chromaFormat !== 3 ? 8 : 12;
      for (let i = 0; i < n; i++) {
        if (r.u(1)) {
          const size = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            if (next !== 0) last = next;
          }
        }
      }
    }
  }
  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue();
  r.u(1);
  const wMbs = r.ue() + 1;
  const hMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let cropL = 0;
  let cropR = 0;
  let cropT = 0;
  let cropB = 0;
  if (r.u(1)) {
    cropL = r.ue();
    cropR = r.ue();
    cropT = r.ue();
    cropB = r.ue();
  }
  const chromaArrayType = separateColour ? 0 : chromaFormat;
  const cropX = chromaArrayType === 0 ? 1 : SUB_W[chromaFormat] || 1;
  const cropY = (chromaArrayType === 0 ? 1 : SUB_H[chromaFormat] || 1) * (2 - frameMbsOnly);
  const width = wMbs * 16 - cropX * (cropL + cropR);
  const height = (2 - frameMbsOnly) * hMapUnits * 16 - cropY * (cropT + cropB);
  return { profile, level, width, height };
}

// ---------------------------------------------------------------- TS 包
function pidOf(p) {
  return ((p[1] & 0x1f) << 8) | p[2];
}

/** 展开 TS 包（只保留有负载的） */
function unpack(buf) {
  const out = [];
  const n = Math.floor(buf.length / 188);
  for (let i = 0; i < n; i++) {
    const off = i * 188;
    if (buf[off] !== 0x47) continue;
    const p = buf.subarray(off, off + 188);
    const afc = (p[3] >> 4) & 0x3;
    if (afc === 2) continue;
    let s = 4;
    if (afc === 3) s = 5 + p[4];
    if (s >= 188) continue;
    out.push({ pid: pidOf(p), pusi: (p[1] & 0x40) !== 0, payload: p.subarray(s) });
  }
  return out;
}

const VIDEO_TYPES = [0x1b, 0x24, 0x01, 0x02];
const AUDIO_TYPES = [0x0f, 0x03, 0x04, 0x81, 0x87];

/** 解析 PAT，拿到 PMT PID */
function pmtPidOf(packets) {
  for (const pk of packets) {
    if (pk.pid !== 0 || !pk.pusi) continue;
    const ptr = pk.payload[0];
    const sec = pk.payload.subarray(1 + ptr);
    if (sec[0] !== 0x00) continue;
    const secLen = ((sec[1] & 0x0f) << 8) | sec[2];
    const end = 3 + secLen - 4;
    for (let i = 8; i + 4 <= end; i += 4) {
      const prog = (sec[i] << 8) | sec[i + 1];
      if (prog !== 0) return ((sec[i + 2] & 0x1f) << 8) | sec[i + 3];
    }
  }
  return -1;
}

/** 解析 PMT，拿到音视频 PID */
function streamsOf(packets, pmtPid) {
  for (const pk of packets) {
    if (pk.pid !== pmtPid || !pk.pusi) continue;
    const ptr = pk.payload[0];
    const sec = pk.payload.subarray(1 + ptr);
    if (sec[0] !== 0x02) continue;
    const secLen = ((sec[1] & 0x0f) << 8) | sec[2];
    const end = 3 + secLen - 4;
    let i = 8;
    const pil = ((sec[i + 2] & 0x0f) << 8) | sec[i + 3];
    i += 4 + pil;
    const list = [];
    while (i + 5 <= end) {
      const type = sec[i];
      const pid = ((sec[i + 1] & 0x1f) << 8) | sec[i + 2];
      const esl = ((sec[i + 3] & 0x0f) << 8) | sec[i + 4];
      list.push({ type, pid });
      i += 5 + esl;
    }
    return list;
  }
  return [];
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseAdts(payload) {
  const lim = Math.min(payload.length - 7, 64);
  for (let i = 0; i < lim; i++) {
    if (payload[i] === 0xff && (payload[i + 1] & 0xf0) === 0xf0) {
      const sfi = (payload[i + 2] >> 2) & 0x0f;
      const ch = ((payload[i + 2] & 0x01) << 2) | ((payload[i + 3] >> 6) & 0x03);
      return { sampleRate: ADTS_RATES[sfi] || 0, channels: ch };
    }
  }
  return null;
}

function findSps(payload) {
  for (let i = 0; i + 4 < payload.length; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0 || payload[i + 2] !== 1) continue;
    if ((payload[i + 3] & 0x1f) !== 7) continue;
    let j = i + 4;
    while (j + 3 < payload.length) {
      if (payload[j] === 0 && payload[j + 1] === 0 && payload[j + 2] === 1) break;
      j++;
    }
    try {
      return parseSps(unescapeRbsp(payload.subarray(i + 4, j)));
    } catch (e) {
      return null;
    }
  }
  return null;
}

/** 从 PES 头读 33 位 PTS（90kHz） */
function pesPts(p) {
  if (p.length < 14 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return null;
  const flags = (p[7] >> 6) & 3;
  if (flags !== 2 && flags !== 3) return null;
  return Math.round(
    (p[9] & 0x0e) * 536870912 +
      (p[10] & 0xff) * 4194304 +
      (p[11] & 0xfe) * 16384 +
      (p[12] & 0xff) * 128 +
      (p[13] & 0xfe) / 2
  );
}

/**
 * 分析一个 TS 分片
 * @returns {{ok, width, height, profile, level, sampleRate, channels,
 *            videoPid, audioPid, streams, firstPts, fingerprint}}
 */
function analyze(buf) {
  const packets = unpack(buf);
  const pmtPid = pmtPidOf(packets);
  const list = pmtPid >= 0 ? streamsOf(packets, pmtPid) : [];
  let videoPid = -1;
  let audioPid = -1;
  for (const s of list) {
    if (videoPid < 0 && VIDEO_TYPES.indexOf(s.type) >= 0) videoPid = s.pid;
    else if (audioPid < 0 && AUDIO_TYPES.indexOf(s.type) >= 0) audioPid = s.pid;
  }

  let sps = null;
  let adts = null;
  let firstPts = null;
  for (const pk of packets) {
    if (!pk.pusi) continue;
    if (pk.pid === videoPid) {
      if (!firstPts) firstPts = pesPts(pk.payload);
      if (!sps) sps = findSps(pk.payload);
    } else if (pk.pid === audioPid) {
      if (!adts) adts = parseAdts(pk.payload);
    }
  }

  const r = {
    ok: !!sps,
    width: sps ? sps.width : 0,
    height: sps ? sps.height : 0,
    profile: sps ? sps.profile : 0,
    level: sps ? sps.level : 0,
    sampleRate: adts ? adts.sampleRate : 0,
    channels: adts ? adts.channels : 0,
    videoPid,
    audioPid,
    streams: list
      .map((s) => s.type + ':' + s.pid)
      .sort()
      .join(','),
    firstPts: firstPts === null ? null : firstPts / 90000,
  };
  r.fingerprint = [r.width + 'x' + r.height, r.profile + '.' + r.level, r.sampleRate + '/' + r.channels, r.streams].join('|');
  return r;
}

module.exports = { analyze, parseSps, parseAdts };
