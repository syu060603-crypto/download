'use strict';
/**
 * 播放地址解析
 *
 * 设计：不自己逆向站方的混淆解密算法，而是把站方那段播放脚本原样放进
 * Node 的 vm 沙箱里执行，提供假的 jQuery / DOM，拦截它自己的 ajax，
 * 从而拿到它写进 iframe.src 的真实 m3u8。站方改算法时只要重新拉脚本即可。
 *
 * 相比初版的修复：
 *  1. 每次解析用**全新**上下文（脚本只编译一次），彻底避免沙箱状态串味导致的
 *     「第一次能解析、后面全部失败」。
 *  2. 单次解析有硬超时（默认 12s）+ 重试，不会再出现界面一直转圈卡死。
 *  3. 解析结果带 TTL 缓存，重复点「解析」不会重复打站方接口。
 *  4. 连续失败时自动重新拉取站方脚本（自愈）。
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const CFG = require('../config');
const { getText, getBuffer, UA } = require('./http');

const SCRIPT_PATH = '/tpxl/xc_js/dypck.js';
const CACHE_FILE = path.join(CFG.CACHE_DIR, 'player.js');
const PAGE_CACHE = path.join(CFG.CACHE_DIR, 'vp-page.html');

// ---------------------------------------------------------------- 站点脚本
let scriptPromise = null;
let consecutiveFails = 0;

async function fetchSource() {
  const urls = [];
  for (const base of CFG.SITE_CANDIDATES) urls.push(base + SCRIPT_PATH + '?ver=202308211823');
  for (const base of CFG.SITE_CANDIDATES) urls.push(base + SCRIPT_PATH);
  let lastErr = null;
  for (const url of urls) {
    try {
      const txt = await getText(url, { headers: { Referer: CFG.SITE + '/' }, timeout: 15000, retry: 1 });
      if (txt && txt.length > 2000) {
        try {
          fs.mkdirSync(CFG.CACHE_DIR, { recursive: true });
          fs.writeFileSync(CACHE_FILE, txt, 'utf8');
        } catch (e) {
          /* 缓存写不进去不影响运行 */
        }
        return txt;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  // 网络不可用 -> 用本地缓存兜底（离线也能解析已缓存过的剧）
  try {
    const cached = fs.readFileSync(CACHE_FILE, 'utf8');
    if (cached && cached.length > 2000) return cached;
  } catch (e) {
    /* noop */
  }
  throw new Error('播放脚本获取失败' + (lastErr ? ': ' + lastErr.message : ''));
}

function getScript() {
  if (!scriptPromise) {
    scriptPromise = (async () => {
      const src = await fetchSource();
      return new vm.Script(src, { filename: 'player.js' });
    })();
    scriptPromise.catch(() => {
      scriptPromise = null;
    });
  }
  return scriptPromise;
}

// ---------------------------------------------------------------- 沙箱
function createSandbox(script, pageUrl) {
  const captured = {};
  const timers = new Set();
  const els = {};

  const loc = {
    href: pageUrl,
    protocol: 'https:',
    host: '',
    hostname: '',
    origin: '',
    pathname: '/',
    search: '',
    hash: '',
    toString() {
      return this.href;
    },
  };
  try {
    const u = new URL(pageUrl);
    loc.protocol = u.protocol;
    loc.host = u.host;
    loc.hostname = u.hostname;
    loc.origin = u.origin;
    loc.pathname = u.pathname;
  } catch (e) {
    /* noop */
  }

  function makeEl(id) {
    const el = {
      id,
      _src: '',
      _attrs: {},
      innerHTML: '',
      textContent: '',
      style: {},
      setAttribute(k, v) {
        if (k === 'src') captured[id] = v;
        this._attrs[k] = v;
      },
      getAttribute(k) {
        return this._attrs[k];
      },
      appendChild() {},
      removeChild() {},
      addEventListener() {},
      removeEventListener() {},
      click() {},
      focus() {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      getElementsByTagName: () => [],
    };
    Object.defineProperty(el, 'src', {
      configurable: true,
      get() {
        return this._src;
      },
      set(v) {
        captured[id] = v;
        this._src = v;
      },
    });
    return el;
  }

  function makeJq() {
    const self = {
      length: 0,
      each() {
        return self;
      },
      addClass() {
        return self;
      },
      removeClass() {
        return self;
      },
      css() {
        return self;
      },
      show() {
        return self;
      },
      hide() {
        return self;
      },
      html() {
        return self;
      },
      text() {
        return '';
      },
      find() {
        return self;
      },
      on() {
        return self;
      },
      click() {
        return self;
      },
      val() {
        return '';
      },
      append() {
        return self;
      },
      remove() {
        return self;
      },
      empty() {
        return self;
      },
      prop() {
        return self;
      },
      animate() {
        return self;
      },
      attr(k, v) {
        if (k === 'src' && v !== undefined) captured['attr:src'] = v;
        return self;
      },
    };
    return self;
  }

  const jQueryObj = makeJq();
  const sandbox = {
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    setTimeout(fn, ms) {
      const t = setTimeout(() => {
        timers.delete(t);
        try {
          if (typeof fn === 'function') fn();
        } catch (e) {
          /* noop */
        }
      }, Math.min(ms || 0, 2000));
      timers.add(t);
      return t;
    },
    clearTimeout(t) {
      timers.delete(t);
      clearTimeout(t);
    },
    setInterval() {
      return 0;
    },
    clearInterval() {},
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    encodeURIComponent,
    decodeURI,
    decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    location: loc,
    navigator: { userAgent: UA, platform: 'Win32', language: 'zh-CN', cookieEnabled: true },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
    history: { pushState() {}, replaceState() {} },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
      clear() {},
    },
    document: {
      getElementById(id) {
        return els[id] || (els[id] = makeEl(id));
      },
      createElement: () => makeEl('dyn'),
      getElementsByTagName: () => [],
      getElementsByClassName: () => [],
      querySelector: () => makeEl('qs'),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {}, removeChild() {}, style: {} },
      head: { appendChild() {} },
      cookie: '',
      title: '',
      referrer: CFG.SITE + '/',
      location: loc,
    },
    $: jQueryObj,
    jQuery: jQueryObj,
    XMLHttpRequest: function FakeXHR() {
      this.readyState = 4;
      this.status = 200;
      this.responseText = '';
      this.response = '';
      this.onreadystatechange = null;
      this.open = function () {};
      this.send = function () {};
      this.setRequestHeader = function () {};
      this.abort = function () {};
      this.getAllResponseHeaders = () => '';
    },
    __captured: captured,
    __onGet: null,
  };

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.location = loc;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.document = sandbox.document;

  jQueryObj.get = function (url, cb) {
    if (typeof sandbox.__onGet === 'function') sandbox.__onGet(url, cb);
  };
  jQueryObj.post = function (url, data, cb) {
    if (typeof sandbox.__onGet === 'function') sandbox.__onGet(url, typeof cb === 'function' ? cb : data);
  };
  jQueryObj.ajax = function (opts) {
    if (typeof sandbox.__onGet === 'function' && opts && opts.url) {
      sandbox.__onGet(opts.url, opts.success);
    }
  };
  jQueryObj.each = function () {};
  jQueryObj.extend = function () {
    return {};
  };

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx, { timeout: 8000 });

  return {
    sandbox,
    captured,
    loc,
    destroy() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      sandbox.__onGet = null;
    },
  };
}

// ---------------------------------------------------------------- 解析
const cache = new Map(); // key -> { m3u8, player, ts }

function cacheKey(vid, pid, epid) {
  return vid + '-' + pid + '-' + epid;
}

function pageUrl(vid, pid, epid) {
  return CFG.SITE + '/vp/' + vid + '-' + pid + '-' + epid + '.html';
}

/** 兜底：直接从播放页 HTML 里抠 m3u8（站方有时会把地址写进页面/注释） */
async function fallbackFromPage(vid, pid, epid) {
  try {
    const html = await getText(pageUrl(vid, pid, epid), {
      headers: { Referer: CFG.SITE + '/' },
      timeout: 12000,
      retry: 1,
    });
    const m = /[?&]url=([^&"'\s]+\.m3u8[^&"'\s]*)/i.exec(html) || /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i.exec(html);
    if (m) {
      return { m3u8: decodeURIComponent(m[1]), player: '' };
    }
  } catch (e) {
    /* noop */
  }
  return null;
}

/** 单次解析（不含重试） */
async function resolveOnce(vid, pid, epid, timeout) {
  const script = await getScript();
  const url = pageUrl(vid, pid, epid);
  const box = createSandbox(script, url);
  const { sandbox, captured } = box;

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let checks = 0;
      const finish = () => {
        if (settled) return;
        const player = captured['vp-iframe'] || captured['attr:src'] || '';
        if (!player) {
          // 站方脚本有时把赋值放在下一轮事件循环，给几次补查机会
          if (checks++ < 12) setTimeout(finish, 120);
          return;
        }
        const m = /[?&]url=([^&#]+)/.exec(player);
        if (!m) {
          settled = true;
          clearTimeout(timer);
          return reject(new Error('播放地址格式异常'));
        }
        settled = true;
        clearTimeout(timer);
        resolve({ m3u8: decodeURIComponent(m[1]), player });
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('解析超时'));
      }, timeout);

      sandbox.__onGet = (u, cb) => {
        const full = /^https?:\/\//i.test(u) ? u : CFG.SITE + (u.charAt(0) === '/' ? u : '/' + u);
        getBuffer(full, {
          headers: { Referer: url, Accept: '*/*' },
          timeout: Math.min(timeout, 15000),
          retry: 1,
        })
          .then((buf) => {
            try {
              if (typeof cb === 'function') cb(buf.toString('utf8'));
            } catch (e) {
              /* 站方解密回调内部报错时仍然尝试读取结果 */
            }
            finish();
          })
          .catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          });
      };

      try {
        if (typeof sandbox.getPlay !== 'function') {
          throw new Error('播放脚本缺少 getPlay');
        }
        sandbox.getPlay('vp-iframe', 'gpx');
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
  } finally {
    box.destroy();
  }
}

/**
 * 解析单集 -> { m3u8, player, cached }
 */
async function resolveEpisode(vid, pid, epid, opts = {}) {
  const key = cacheKey(vid, pid, epid);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < (opts.ttl || CFG.RESOLVE_CACHE_TTL)) {
    return { m3u8: hit.m3u8, player: hit.player, cached: true };
  }

  const retry = opts.retry === undefined ? CFG.RESOLVE_RETRY : opts.retry;
  const timeout = opts.timeout || CFG.RESOLVE_TIMEOUT;
  let lastErr = null;

  for (let i = 0; i < Math.max(1, retry); i++) {
    try {
      const r = await resolveOnce(vid, pid, epid, timeout);
      cache.set(key, { m3u8: r.m3u8, player: r.player, ts: Date.now() });
      consecutiveFails = 0;
      return Object.assign({ cached: false }, r);
    } catch (e) {
      lastErr = e;
      // 站方脚本可能已更新：连续失败时重新拉取
      if (++consecutiveFails >= 3) {
        consecutiveFails = 0;
        scriptPromise = null;
      }
    }
  }

  // 最后兜底：从播放页 HTML 里抠
  const fb = await fallbackFromPage(vid, pid, epid);
  if (fb) {
    cache.set(key, { m3u8: fb.m3u8, player: fb.player, ts: Date.now() });
    return Object.assign({ cached: false }, fb);
  }
  throw new Error('解析失败: ' + (lastErr ? lastErr.message : '未知原因'));
}

/** 批量解析 */
async function resolveMany(items, concurrency) {
  const n = Math.max(1, Math.min(concurrency || CFG.RESOLVE_CONCURRENCY, items.length));
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      const it = items[i];
      try {
        results[i] = await resolveEpisode(it.vid, it.pid, it.epid);
      } catch (e) {
        results[i] = { error: e.message, vid: it.vid, pid: it.pid, epid: it.epid };
      }
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** 预热：启动时先把脚本拉下来编译好 */
async function warmup() {
  await getScript();
  return true;
}

/** 站方脚本更新后重建 */
async function rebuild() {
  scriptPromise = null;
  cache.clear();
  await getScript();
}

module.exports = {
  resolveEpisode,
  resolveMany,
  warmup,
  rebuild,
  pageUrl,
  _cache: cache,
};
