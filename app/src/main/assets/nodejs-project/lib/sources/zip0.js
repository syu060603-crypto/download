'use strict';
/**
 * 来源适配器：ZIP0（https://zip0.com）
 *
 * 这是一个聚合搜索站，本身聚合了 10 个采集源（mdzy/bfzy/lzi 等），并且
 * 对外暴露了公开 API（见 https://zip0.com/.well-known/openapi.json）：
 *
 *   搜索：GET /api/videos/search?query=<词>&page=1&limit=40
 *         -> { success, data:[{title,year,category,area,score,remarks,url,...}] }
 *         其中 url 形如 https://zip0.com/watch?source=mdzy&id=16302&episode=1
 *
 *   详情：GET /watch?source=<src>&id=<vid>&episode=1
 *         页面是 SSR 的，数据直接内嵌在传输流里，可正则提取：
 *           title:"庆余年"  year:"2019"  category:"国产剧"  remarks:"全46集"
 *           poster:"https://...jpg"
 *           episodes:[{name:"第01集",url:"https://.../index.m3u8"}, ...]
 *
 * 所以本源不需要沙箱解析脚本——搜索走 JSON API，详情/播放地址直接从
 * watch 页面流里抠出来，m3u8 在详情阶段就已经拿全，resolve 只是查缓存。
 *
 * 内部 id 约定："<采集源别名>:<视频id>"，如 "mdzy:16302"。
 */
const CFG = require('../../config');
const { getText } = require('../http');

const BASE = CFG.ZIP0_BASE;

// 详情缓存：id -> { title, pic, meta, episodes:[{epid,name,url}] }
const detailCache = new Map();
const DETAIL_CACHE_MAX = 120;
const DETAIL_CACHE_TTL = 30 * 60 * 1000;

function parseId(id) {
  const m = /^([A-Za-z0-9_-]+):(\d+)$/.exec(String(id || ''));
  if (!m) throw new Error('zip0 id 格式非法（应为 源:视频id）');
  return { src: m[1], vid: m[2] };
}

/** 从 watch 页 SSR 传输流里抠出结构化字段 */
function extractFromWatch(html) {
  function str(key) {
    const m = new RegExp('\\b' + key + ':"([^"]{0,300})"').exec(html);
    return m ? m[1] : '';
  }
  const episodes = [];
  const re = /\{name:"([^"]{1,60})",url:"(https?:\/\/[^"]+?\.(?:m3u8|mp4)[^"]*)"\}/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    episodes.push({ name: m[1], url: m[2] });
  }
  return {
    title: str('title'),
    year: str('year'),
    category: str('category'),
    area: str('area'),
    language: str('language'),
    director: str('director'),
    actors: str('actors') || str('cast'),
    remarks: str('remarks'),
    score: str('score'),
    poster: str('poster'),
    episodes,
  };
}

async function search(kw) {
  const url =
    BASE + '/api/videos/search?query=' + encodeURIComponent(kw) + '&page=1&limit=40';
  const txt = await getText(url, {
    headers: { Referer: BASE + '/', Accept: 'application/json' },
    timeout: 15000,
    retry: 2,
    accept: 'application/json',
  });
  let d;
  try {
    d = JSON.parse(txt);
  } catch (e) {
    throw new Error('zip0 返回的不是 JSON');
  }
  if (!d || d.success !== true) throw new Error('zip0 接口返回异常');
  const out = [];
  for (const v of d.data || []) {
    let src = '';
    let vid = '';
    try {
      const u = new URL(v.url);
      src = u.searchParams.get('source') || '';
      vid = u.searchParams.get('id') || '';
    } catch (e) {
      /* url 字段缺失或非法，跳过 */
    }
    if (!src || !vid) continue;
    const note = [v.remarks, v.score && v.score !== '0.0' ? v.score + '分' : '', v.category]
      .filter(Boolean)
      .join(' · ');
    out.push({
      source: 'zip0',
      id: src + ':' + vid,
      title: v.title || '未命名',
      pic: '', // 搜索 API 不带海报；进详情后有
      note,
      actors: v.actors || '',
      year: v.year || '',
      episodeCount: v.episodeCount || 0,
    });
  }
  return out;
}

async function detail(id) {
  const { src, vid } = parseId(id);
  const key = src + ':' + vid;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.ts < DETAIL_CACHE_TTL) return hit.data;

  const url = BASE + '/watch?source=' + encodeURIComponent(src) + '&id=' + vid + '&episode=1';
  const html = await getText(url, {
    headers: { Referer: BASE + '/', Accept: 'text/html' },
    timeout: 20000,
    retry: 2,
  });
  const d = extractFromWatch(html);
  if (!d.episodes.length) throw new Error('没有解析到分集，可能已下架');

  const meta = {};
  if (d.remarks) meta['状态'] = d.remarks;
  if (d.year) meta['年代'] = d.year;
  if (d.area) meta['地区'] = d.area;
  if (d.category) meta['类型'] = d.category;
  if (d.language) meta['语言'] = d.language;
  if (d.actors) meta['主演'] = d.actors;
  if (d.director) meta['导演'] = d.director;
  if (d.score && d.score !== '0.0') meta['评分'] = d.score;

  const data = {
    source: 'zip0',
    id: key,
    title: d.title || '未命名',
    pic: d.poster,
    meta,
    groups: [
      {
        pid: 0,
        name: 'ZIP0 · ' + src,
        episodes: d.episodes.map((e, i) => ({ epid: i, name: e.name, m3u8: e.url })),
      },
    ],
    url,
  };
  detailCache.set(key, { ts: Date.now(), data });
  if (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = [...detailCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) detailCache.delete(oldest[0]);
  }
  return data;
}

/** m3u8 在详情阶段已拿全：查缓存，缓存没有就现拉一次详情 */
async function resolve(id, pid, epid) {
  const { src, vid } = parseId(id);
  const key = src + ':' + vid;
  let data = null;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.ts < DETAIL_CACHE_TTL) data = hit.data;
  if (!data) data = await detail(id);
  const ep = data.groups[0] && data.groups[0].episodes[epid];
  if (!ep || !ep.m3u8) throw new Error('没有这一集的播放地址');
  return { m3u8: ep.m3u8, player: '' };
}

module.exports = {
  id: 'zip0',
  name: 'ZIP0',
  enabled: CFG.SRC_ZIP0_ENABLED,
  search,
  detail,
  resolve,
};
