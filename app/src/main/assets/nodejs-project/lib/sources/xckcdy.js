'use strict';
/**
 * 来源适配器：主站（xckcdy）
 *
 * 把原先散在 server.js 里的搜索/详情逻辑，与 resolver.js 的解析能力
 * 统一收进标准适配器接口：
 *   search(kw)               -> [{ source, id, title, pic, note, actors }]
 *   detail(id)               -> { title, pic, meta, groups:[{pid,name,episodes:[{epid,name}]}] }
 *   resolve(id, pid, epid)   -> { m3u8, player }
 */
const CFG = require('../../config');
const { getText } = require('../http');
const parser = require('../parser');
const resolver = require('../resolver');

function looksBlocked(html) {
  return /(访问过于频繁|请输入验证码|安全验证|人机验证|Just a moment|cf-browser-verification)/i.test(html);
}

async function search(kw) {
  let lastErr = null;
  for (const base of CFG.SITE_CANDIDATES) {
    const url = base + '/search?kw=' + encodeURIComponent(kw);
    try {
      const html = await getText(url, { headers: { Referer: base + '/' }, timeout: 20000, retry: 2 });
      if (looksBlocked(html)) {
        lastErr = new Error('站点要求验证，请稍后重试');
        continue;
      }
      const results = parser.parseSearch(html, base);
      if (results.length || /没有找到|暂无/i.test(html)) {
        return results.map((r) => ({
          source: 'xckcdy',
          id: r.vid,
          title: r.title,
          pic: r.pic,
          note: r.note,
          actors: r.actors,
        }));
      }
      lastErr = new Error('站点返回内容异常');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('搜索失败');
}

async function detail(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('vid 非法');
  let lastErr = null;
  for (const base of CFG.SITE_CANDIDATES) {
    try {
      const html = await getText(base + '/vd/' + id + '.html', {
        headers: { Referer: base + '/' },
        timeout: 20000,
        retry: 2,
      });
      const data = parser.parseDetail(html, base);
      if (!data.groups.length) {
        lastErr = new Error('没有解析到分集，可能已下架');
        continue;
      }
      return {
        source: 'xckcdy',
        id: String(id),
        title: data.title,
        pic: data.pic,
        meta: data.meta,
        groups: data.groups,
        url: base + '/vd/' + id + '.html',
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('详情加载失败');
}

async function resolve(id, pid, epid) {
  return resolver.resolveEpisode(id, pid, epid);
}

module.exports = {
  id: 'xckcdy',
  name: '星辰',
  enabled: CFG.SRC_XCKCDY_ENABLED,
  search,
  detail,
  resolve,
};
