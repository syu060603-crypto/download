'use strict';
/**
 * 全局配置（唯一一处需要改动站点信息的地方）
 *
 * 说明：
 *  - 站点地址只在这里出现，界面与提示文案里不再出现任何站点名称/域名。
 *  - 所有可调参数都能用环境变量覆盖，方便桌面端调试。
 */
const path = require('path');

const IS_ANDROID = process.platform === 'android';

function envStr(k, d) {
  const v = process.env[k];
  return v === undefined || v === '' ? d : String(v);
}
function envInt(k, d) {
  const v = parseInt(process.env[k], 10);
  return Number.isFinite(v) ? v : d;
}
function envBool(k, d) {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return !/^(0|false|no|off)$/i.test(String(v));
}

const SITE = envStr('APP_SITE', 'https://www.xckcdy.com').replace(/\/+$/, '');

/** 站点可能在不同域名/子域间切换，作为故障转移候选 */
function siteCandidates() {
  const out = [SITE];
  try {
    const u = new URL(SITE);
    const bare = u.hostname.replace(/^www\./, '');
    out.push(u.protocol + '//' + bare);
    out.push(u.protocol + '//m.' + bare);
  } catch (e) {
    /* noop */
  }
  return [...new Set(out)];
}

/** 页面标题里需要被剔除的品牌/站点词（只用于清洗标题，不影响正文） */
const BRAND_WORDS = [
  '星辰影视',
  '星辰影院',
  '星辰视频',
  '星辰电影网',
  '星辰TV',
  '星辰',
];

/** 标题里常见的站点后缀噪声 */
const TITLE_NOISE = [
  '免费在线观看',
  '高清完整版',
  '在线观看',
  '完整版',
  '高清版',
  '高清',
  '免费观看',
  '手机播放',
  '极速播放',
  '播放',
  '下载',
];

const ROOT = __dirname;

module.exports = {
  IS_ANDROID,
  ROOT,
  SITE,
  SITE_CANDIDATES: siteCandidates(),
  BRAND_WORDS,
  TITLE_NOISE,

  PORT: envInt('PORT', 8787),
  // 手机端只监听回环地址：同一 WiFi 下的其它设备无法访问，避免隐私泄露
  BIND: envStr('APP_BIND', IS_ANDROID ? '127.0.0.1' : '0.0.0.0'),

  DATA_DIR: envStr('APP_DATA', path.join(ROOT, 'data')),
  CACHE_DIR: envStr('APP_CACHE', path.join(ROOT, 'cache')),
  DOWNLOAD_DIR: envStr('APP_DOWNLOAD', path.join(ROOT, 'downloads')),
  PUBLIC_DIR: path.join(ROOT, 'public'),

  UA:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  // ---------------------------------------------------------------- 网络
  MAX_SOCKETS: envInt('APP_MAX_SOCKETS', 32), // 全局并发连接上限（keep-alive 复用）
  HTTP_TIMEOUT: envInt('APP_HTTP_TIMEOUT', 20000),
  HTTP_RETRY: envInt('APP_HTTP_RETRY', 3),

  // ---------------------------------------------------------------- 解析
  RESOLVE_TIMEOUT: envInt('APP_RESOLVE_TIMEOUT', 12000),
  RESOLVE_RETRY: envInt('APP_RESOLVE_RETRY', 3),
  RESOLVE_CACHE_TTL: 10 * 60 * 1000,
  RESOLVE_CONCURRENCY: envInt('APP_RESOLVE_CONC', 4),

  // ---------------------------------------------------------------- 下载
  EPISODE_CONCURRENCY: envInt('APP_EP_CONC', 2), // 同时下载几集（多文件提速的关键）
  SEGMENT_CONCURRENCY: envInt('APP_SEG_CONC', 8), // 单集内分片并发
  SEGMENT_CONCURRENCY_MAX: envInt('APP_SEG_CONC_MAX', 24),
  SEGMENT_RETRY: envInt('APP_SEG_RETRY', 4),
  SEGMENT_TIMEOUT: envInt('APP_SEG_TIMEOUT', 25000),

  // ---------------------------------------------------------------- 广告剔除
  // 站方会在正片中间插播整段广告：广告分片的编码参数与正片不同、时间轴从 0 重来。
  // 保留这些分片会导致手机播放器「解析中」卡住、音画不同步，所以下载时直接丢掉。
  STRIP_ADS: envBool('APP_STRIP_ADS', true),
  AD_PROBE_BYTES: envInt('APP_AD_PROBE_BYTES', 65536), // 每个候选块只取首片前 64KB 探测
  AD_MAX_BLOCK_SECONDS: envInt('APP_AD_MAX_BLOCK', 180), // 超过这个时长的块不可能是广告
  AD_PTS_RESTART: envInt('APP_AD_PTS_RESTART', 12), // 首帧 PTS < 12s 视为时间轴重启
  AD_MAX_RATIO: 0.5, // 剔除超过一半就判定为误判，全部保留

  // ---------------------------------------------------------------- 缓存
  SEARCH_CACHE_TTL: 10 * 60 * 1000,
  DETAIL_CACHE_TTL: 30 * 60 * 1000,
  SEARCH_CACHE_MAX: 60,
};
