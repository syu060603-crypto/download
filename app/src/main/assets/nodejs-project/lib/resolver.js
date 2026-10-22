'use strict';
/**
 * 播放地址解析器
 *
 * 逆向结论:
 *   播放页 /vp/{vid}-{pid}-{epid}.html 内的 <iframe id="vp-iframe"> 是空的,
 *   其 src 由站方 混淆后的 dypck.js 中的 getPlay('vp-iframe','gpx') 动态填充。
 *
 *   getPlay 流程:
 *     1) 从 window.location.href 匹配 /\/(\d+)-(\d+)-(\d+)/ 取 vid/pid/epid
 *     2) $.get('/gpx?vid=..&pid=..&epid=..&t=<时间戳>&k=<签名>')
 *     3) /gpx 返回一段 十六进制密文 (本例 131 字节)
 *     4) 前端解密后得到播放页地址:
 *        /dydysf/player/dpx2/?screenshot=1&mmt=1&hls=1&maxbuff=200&url=<m3u8 地址>
 *     5) 赋值给 document.getElementById('vp-iframe').src
 *
 * 设计取舍:
 *   密文算法藏在 jsjiami.v7 混淆里且会随站方更新而变化。
 *   因此本模块 **不重新实现解密算法**, 而是在 Node 沙箱(vm)中原样执行站方的
 *    dypck.js, 复用它自己的解密逻辑, 稳态可自适应站方改版。
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getBuffer, getText } = require('./http');

const SITE = 'https://www.xckcdy.com';
const DYPckPath = '/tpxl/xc_js/dypck.js';
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'dypck.js');
const POOL_SIZE = parseInt(process.env.XCK_POOL || '4', 10);

// ---------------------------------------------------------------- 加载站方脚本
async function fetchDypck() {
  // 先用一个已知版本参数, 失败则不带参数重试
  const candidates = [SITE + DYPckPath + '?ver=202308211823', SITE + DYPckPath];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const txt = await getText(url, { headers: { Referer: SITE + '/' }, timeout: 20000 });
      if (txt && txt.length > 2000) {
        try {
          fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
          fs.writeFileSync(CACHE_FILE, txt, 'utf8');
        } catch (e) { /* 缓存写入失败不影响运行 */ }
        return txt;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  // 网络不可用 -> 回落本地缓存
  try {
    const cached = fs.readFileSync(CACHE_FILE, 'utf8');
    if (cached && cached.length > 2000) {
      return cached;
    }
  } catch (e) { /* noop */ }
  throw new Error('无法获取站方 dypck.js: ' + (lastErr ? lastErr.message : '未知错误'));
}

// ---------------------------------------------------------------- 沙箱构造
function createSandbox(src) {
  const captured = {};
  const els = {};
  const loc = {
    href: SITE + '/',
    protocol: 'https:',
    host: 'www.xckcdy.com',
    hostname: 'www.xckcdy.com',
    origin: SITE,
    pathname: '/',
    search: '',
    hash: '',
  };

  function makeEl(id) {
    const el = {
      id: id,
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
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      getElementsByTagName() { return []; },
    };
    Object.defineProperty(el, 'src', {
      configurable: true,
      get() { return this._src; },
      set(v) { captured[id] = v; this._src = v; },
    });
    return el;
  }

  function makeJq() {
    const self = {
      length: 0,
      each() { return self; },
      addClass() { return self; },
      removeClass() { return self; },
      css() { return self; },
      show() { return self; },
      hide() { return self; },
      html() { return self; },
      text() { return ''; },
      find() { return self; },
      on() { return self; },
      click() { return self; },
      val() { return ''; },
      append() { return self; },
      remove() { return self; },
      empty() { return self; },
      prop() { return self; },
      animate() { return self; },
      attr(k, v) {
        if (k === 'src' && v !== undefined) captured['attr:src'] = v;
        return self;
      },
    };
    return self;
  }

  const jQueryObj = makeJq();
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
  jQueryObj.extend = function () { return {}; };

  function FakeXHR() {
    this.readyState = 4;
    this.status = 200;
    this.responseText = '';
    this.response = '';
    this.onreadystatechange = null;
    this.open = function () {};
    this.send = function () {};
    this.setRequestHeader = function () {};
    this.abort = function () {};
    this.getAllResponseHeaders = function () { return ''; };
  }

  const sandbox = {
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    Math: Math,
    JSON: JSON,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Array: Array,
    Object: Object,
    RegExp: RegExp,
    Error: Error,
    TypeError: TypeError,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    isFinite: isFinite,
    encodeURI: encodeURI,
    encodeURIComponent: encodeURIComponent,
    decodeURI: decodeURI,
    decodeURIComponent: decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    location: loc,
    navigator: { userAgent: require('./http').UA, platform: 'Win32', language: 'zh-CN' },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
    history: { pushState() {}, replaceState() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: {
      getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
      createElement() { return makeEl('dyn'); },
      getElementsByTagName() { return []; },
      getElementsByClassName() { return []; },
      querySelector() { return makeEl('qs'); },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {}, removeChild() {}, style: {} },
      head: { appendChild() {} },
      cookie: '',
      title: '',
      referrer: SITE + '/',
      location: loc,
    },
    $: jQueryObj,
    jQuery: jQueryObj,
    XMLHttpRequest: FakeXHR,
    __captured: captured,
    __onGet: null,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.window.location = loc;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.document = sandbox.document;
  sandbox.window.XMLHttpRequest = FakeXHR;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 15000 });
  return { sandbox, captured, loc };
}

// ---------------------------------------------------------------- 沙箱池
let pool = null;
let initPromise = null;

async function initPool() {
  if (pool) return pool;
  if (!initPromise) {
    initPromise = (async () => {
      const src = await fetchDypck();
      const slots = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const s = createSandbox(src);
        slots.push({ sandbox: s.sandbox, captured: s.captured, loc: s.loc, busy: false });
      }
      pool = slots;
      return pool;
    })();
  }
  try {
    await initPromise;
  } catch (e) {
    initPromise = null;
    throw e;
  }
  return pool;
}

function acquireSlot() {
  // 轮询等待一个空闲沙箱
  return new Promise((resolve) => {
    const check = () => {
      if (!pool) return setTimeout(check, 20);
      const free = pool.find((s) => !s.busy);
      if (free) {
        free.busy = true;
        return resolve(free);
      }
      setTimeout(check, 15);
    };
    check();
  });
}

function releaseSlot(slot) {
  if (slot) slot.busy = false;
}

let consecutiveFails = 0;

/** 重建沙箱池 (站方脚本更新后使用) */
async function rebuild() {
  pool = null;
  initPromise = null;
  await initPool();
}

/**
 * 解析单个分集 -> { m3u8, player }
 */
async function resolveEpisode(vid, pid, epid) {
  await initPool();
  const slot = await acquireSlot();
  try {
    Object.keys(slot.captured).forEach((k) => delete slot.captured[k]);
    slot.loc.href = SITE + '/vp/' + vid + '-' + pid + '-' + epid + '.html';
    slot.loc.pathname = '/vp/' + vid + '-' + pid + '-' + epid + '.html';

    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const player = slot.captured['vp-iframe'] || slot.captured['attr:src'] || '';
        if (!player) {
          consecutiveFails++;
          return reject(new Error('解析失败: 未取到 iframe src (vid=' + vid + ',pid=' + pid + ',epid=' + epid + ')'));
        }
        const m = /[?&]url=([^&#]+)/.exec(player);
        if (!m) {
          consecutiveFails++;
          return reject(new Error('解析失败: src 中无 url 参数 -> ' + player));
        }
        consecutiveFails = 0;
        resolve({
          player: player,
          m3u8: decodeURIComponent(m[1]),
          vid: String(vid),
          pid: pid,
          epid: epid,
        });
      };

      slot.sandbox.__onGet = (u, cb) => {
        const full = u.startsWith('http') ? u : SITE + u;
        getBuffer(full, { headers: { Referer: slot.loc.href, Accept: '*/*' }, timeout: 20000 })
          .then((buf) => {
            try {
              if (typeof cb === 'function') cb(buf.toString('utf8'));
            } catch (e) {
              /* 解密回调内部报错时仍然尝试读取结果 */
            }
            finish();
          })
          .catch((err) => {
            if (!done) {
              done = true;
              consecutiveFails++;
              reject(err);
            }
          });
      };

      try {
        slot.sandbox.getPlay('vp-iframe', 'gpx');
      } catch (e) {
        if (!done) {
          done = true;
          consecutiveFails++;
          reject(e);
        }
      }
    });
  } finally {
    releaseSlot(slot);
    // 连续失败较多时, 可能是站方脚本改版, 触发重建
    if (consecutiveFails >= 5) {
      consecutiveFails = 0;
      rebuild().catch(() => {});
    }
  }
}

/**
 * 批量解析 (受沙箱池并发限制)
 */
async function resolveMany(items, concurrency = 4) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const it = items[i];
      try {
        results[i] = await resolveEpisode(it.vid, it.pid, it.epid);
      } catch (e) {
        results[i] = { error: e.message, vid: it.vid, pid: it.pid, epid: it.epid };
      }
    }
  }
  const n = Math.min(concurrency, items.length, POOL_SIZE);
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
  return results;
}

module.exports = { resolveEpisode, resolveMany, initPool, rebuild, SITE };
