'use strict';
/**
 * 星辰影视 (xckcdy.com) 页面解析
 *
 * 逆向结论:
 *  - 搜索页 /search?kw=<URL编码>  为服务端渲染 HTML
 *    结果项: <li class="mb"> ... <a class="li-hv" href="/vd/{vid}.html" title="{标题}">
 *            <img ... src="{封面}"> <p class="bz">{备注, 如 "6集全"}</p>
 *  - 详情页 /vd/{vid}.html
 *    线路标签: <li id="tab1{N}" ...>{线路名}</li>       N = 1..9
 *    分集容器: <div id="stab1{N}" ...>  内含
 *             <a title="{第x集}" href="/vp/{vid}-{pid}-{epid}.html">{第x集}</a>
 *    其中 pid = 线路序号(0基), epid = 分集序号(0基)
 */

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return (s || '').replace(/<[^>]*>/g, '');
}

/** 解析搜索结果 */
function parseSearch(html) {
  const results = [];
  const seen = new Set();
  // 结果项块
  const liRe = /<li class="mb">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const blk = m[1];
    const link = /<a class="li-hv"\s+href="\/vd\/(\d+)\.html"\s+title="([^"]*)"/.exec(blk);
    if (!link) continue;
    const vid = link[1];
    if (seen.has(vid)) continue;
    seen.add(vid);
    const pic = /<img[^>]*\ssrc="([^"]+)"/.exec(blk);
    const note = /<p class="bz">([^<]*)<\/p>/.exec(blk);
    const hint = /<p class="ic[^"]*">([^<]*)<\/p>/.exec(blk);
    results.push({
      vid: vid,
      title: decodeEntities(link[2]).trim(),
      pic: pic ? pic[1] : '',
      note: note ? note[1].trim() : '',
      hint: hint ? hint[1].trim() : '',
    });
  }
  return results;
}

function extractTitle(html) {
  let m = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (m) {
    const t = decodeEntities(stripTags(m[1])).trim();
    if (t) return t;
  }
  // 面包屑: <a href="/vd/xxx.html">标题</a>
  m = /<a href="\/vd\/\d+\.html">([^<]+)<\/a>/.exec(html);
  if (m) {
    const t = decodeEntities(m[1]).trim();
    if (t) return t;
  }
  m = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (m) {
    const t = decodeEntities(m[1]).split(/[-_|]/)[0].trim();
    if (t) return t;
  }
  return '';
}

function extractPic(html) {
  let m = /<div class="ct mb clearfix">[\s\S]*?<img[^>]*\ssrc="([^"]+)"/.exec(html);
  if (m) return m[1];
  m = /<img[^>]*class="lazy"[^>]*\ssrc="(https:\/\/img\.xckcdy\.com\/[^"]+)"/.exec(html);
  if (m) return m[1];
  m = /<img[^>]*\ssrc="(https:\/\/img\.xckcdy\.com\/[^"]+)"/.exec(html);
  return m ? m[1] : '';
}

/** 解析详情页 -> 线路 + 分集 */
function parseDetail(html) {
  const title = extractTitle(html);
  const pic = extractPic(html);

  // 定位所有 stab1N 容器
  const positions = [];
  const idRe = /id="stab1(\d+)"/g;
  let m;
  while ((m = idRe.exec(html)) !== null) {
    positions.push({ n: m[1], start: m.index });
  }
  positions.sort((a, b) => parseInt(a.n, 10) - parseInt(b.n, 10));

  const groups = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : html.length;
    // 限制切片长度，避免把后续无关内容卷进来
    let seg = html.slice(p.start, Math.min(end, p.start + 200000));

    const episodes = [];
    const linkRe = /<a title="([^"]*)" href="\/vp\/(\d+)-(\d+)-(\d+)\.html"/g;
    let l;
    while ((l = linkRe.exec(seg)) !== null) {
      episodes.push({ name: decodeEntities(l[1]).trim(), vid: l[2], pid: parseInt(l[3], 10), epid: parseInt(l[4], 10) });
    }

    // 线路名称
    const tabRe = new RegExp('<li id="tab1' + p.n + '"[^>]*>([^<]*)<');
    const tab = tabRe.exec(html);
    let gname = tab ? decodeEntities(tab[1]).trim() : '';
    gname = gname.replace(/^在线观看\(?/, '').replace(/\)$/, '').trim() || '线路' + p.n;

    if (episodes.length > 0) {
      groups.push({
        pid: episodes[0].pid,
        name: gname,
        episodes: episodes.map((e) => ({ epid: e.epid, name: e.name })),
      });
    }
  }

  return { title: title, pic: pic, groups: groups };
}

module.exports = { parseSearch, parseDetail, decodeEntities };
