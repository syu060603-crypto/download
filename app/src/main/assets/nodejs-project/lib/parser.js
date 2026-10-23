'use strict';
/**
 * 页面解析（搜索页 / 详情页）
 *
 * 修复要点：
 *  1. 封面错位：初版在详情页用「第一个 class=lazy 的 img」取封面，而详情页第一张图
 *     是主海报（没有 lazy 类），结果拿到的是下方「相关推荐」里另一部剧的封面 ——
 *     这正是「封面和剧名不匹配」的根因。现在优先取 div.pic 内的海报，并用
 *     alt 与剧名做交叉校验。
 *  2. 标题污染：详情页没有 h1，初版退化到 <title> 再按 - _ | 切分，得到的是
 *     《剧名》电视剧免费在线观看 这类脏标题。现在优先取 dt.name，并对
 *     <title> 做《》剥离 + 站点品牌词/噪声词清洗。
 *  3. 懒加载图：兼容 data-original / data-src / data-lazy-src，跳过占位图。
 *  4. 相对地址：封面统一转成绝对地址，避免手机端 404。
 */
const CFG = require('../config');

// ---------------------------------------------------------------- 文本工具
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}

function tidy(s) {
  return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
}

/** 去掉站点品牌词与标题噪声（只用于标题，不动正文） */
function cleanTitle(raw) {
  let t = tidy(raw);
  if (!t) return '';
  // 《剧名》 -> 剧名
  t = t.replace(/^[《「【\[]\s*/, '').replace(/\s*[》」】\]]$/, '');
  // 按分隔符切成若干段，逐段判定是否属于噪声/品牌
  const parts = t.split(/\s*[-_|｜]\s*/).filter(Boolean);
  const kept = parts.filter((p) => {
    const hasBrand = CFG.BRAND_WORDS.some((w) => p.indexOf(w) >= 0);
    const noiseOnly = CFG.TITLE_NOISE.some((n) => p === n) || /^[\d\s.]+$/.test(p);
    return !hasBrand && !noiseOnly;
  });
  t = (kept.length ? kept : parts).join(' ');
  // 去掉品牌词（例如「星辰影视」）
  for (const w of CFG.BRAND_WORDS) t = t.split(w).join('');
  // 去掉常见后缀短语
  for (const n of CFG.TITLE_NOISE) {
    t = t.replace(new RegExp('[\\s·—\\-]*' + n + '$'), '');
  }
  return t.replace(/\s+/g, ' ').replace(/^[《「【\[]\s*/, '').replace(/\s*[》」】\]]$/, '').trim();
}

function absUrl(u, base) {
  if (!u) return '';
  let s = decodeEntities(String(u).trim());
  if (!s || s === '#' || /^data:/i.test(s)) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  try {
    return new URL(s, base || CFG.SITE).toString();
  } catch (e) {
    return s;
  }
}

const PLACEHOLDER_RE = /(loading|load\.gif|lazy\.(gif|png|jpg)|placeholder|blank\.(gif|png)|noimage|nopic|default\.(gif|png|jpg)|1x1|spacer|grey\.gif)/i;

/** 从一段 HTML 里挑出最像封面的图片地址 */
function pickPic(html, base) {
  if (!html) return '';
  const cands = [];
  const re = /<img\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const order = ['data-original', 'data-src', 'data-lazy-src', 'data-echo', 'src'];
    for (const a of order) {
      const r = new RegExp('\\b' + a + '\\s*=\\s*["\']([^"\']+)["\']', 'i');
      const v = r.exec(attrs);
      if (v && v[1] && !PLACEHOLDER_RE.test(v[1])) {
        cands.push({ url: absUrl(v[1], base), order: order.indexOf(a) });
        break;
      }
    }
  }
  if (!cands.length) return '';
  // 优先取「非占位、非 svg」的第一张
  const good = cands.filter((c) => !/\.svg(\?|$)/i.test(c.url));
  return (good[0] || cands[0]).url;
}

// ---------------------------------------------------------------- 搜索页
/**
 * 搜索结果
 * 结构：
 *   <li class="mb">
 *     <a class="li-hv" href="/vd/{vid}.html" title="{剧名}">
 *       <div class="img"><img class="lazy" alt="{剧名}" src="{封面}"><p class="bz">{状态}</p></div>
 *       <div class="text"><p class="name">{剧名}</p><p class="zy">{主演}</p></div>
 *     </a>
 *   </li>
 */
function parseSearch(html, base) {
  const results = [];
  const seen = new Set();
  const itemRe = /<li[^>]*class="[^"]*\bmb\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const linkM = /<a[^>]*class="[^"]*li-hv[^"]*"[^>]*href="([^"]+)"[^>]*>/i.exec(block);
    const href = linkM ? linkM[1] : (/<a[^>]*href="(\/vd\/\d+\.html)"/i.exec(block) || [])[1];
    if (!href) continue;
    const vidM = /\/vd\/(\d+)/.exec(href);
    if (!vidM) continue;
    const vid = vidM[1];
    if (seen.has(vid)) continue;
    seen.add(vid);

    // 只在这一条结果自己的 <a> 内部找封面，避免串到相邻条目
    let inner = block;
    const aStart = block.search(/<a[^>]*class="[^"]*li-hv/i);
    if (aStart >= 0) {
      const aEnd = block.indexOf('</a>', aStart);
      if (aEnd > aStart) inner = block.slice(aStart, aEnd);
    }

    const nameM = /<p[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const titleAttr = (/<a[^>]*class="[^"]*li-hv[^"]*"[^>]*title="([^"]*)"/i.exec(block) || [])[1];
    const altM = /<img[^>]*\balt="([^"]*)"/i.exec(inner);
    const title = cleanTitle((nameM && nameM[1]) || titleAttr || (altM && altM[1]) || '');

    const noteM = /<p[^>]*class="[^"]*\bbz\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const zyM = /<p[^>]*class="[^"]*\bzy\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);

    results.push({
      vid,
      title: title || '未命名',
      pic: pickPic(inner, base),
      note: noteM ? tidy(noteM[1]) : '',
      actors: zyM ? tidy(zyM[1]) : '',
    });
  }
  return results;
}

// ---------------------------------------------------------------- 详情页
function extractTitle(html) {
  // 1) 详情信息区的主标题（最干净）
  let m = /<dt[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/dt>/i.exec(html);
  if (m) {
    const t = cleanTitle(m[1].replace(/<span[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/span>/gi, ''));
    if (t) return t;
  }
  // 2) 面包屑最后一级
  const crumbs = [];
  const cr = /<a[^>]*href="\/vd\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = cr.exec(html)) !== null) crumbs.push(tidy(m[1]));
  if (crumbs.length) {
    const t = cleanTitle(crumbs[crumbs.length - 1]);
    if (t) return t;
  }
  // 3) h1
  m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (m) {
    const t = cleanTitle(m[1]);
    if (t) return t;
  }
  // 4) <title>：剥掉《》与站点后缀
  m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (m) return cleanTitle(m[1]);
  return '';
}

function extractPic(html, title, base) {
  // 1) 详情头部海报位（唯一正确的那张）
  let m = /<div[^>]*class="[^"]*\bpic\b[^"]*"[^>]*>([\s\S]{0,600}?)<\/div>/i.exec(html);
  if (m) {
    const p = pickPic(m[1], base);
    if (p) return p;
  }
  // 2) alt 与剧名一致的图
  if (title) {
    const re = /<img\b([^>]*)>/gi;
    let i;
    while ((i = re.exec(html)) !== null) {
      const alt = /\balt="([^"]*)"/i.exec(i[1]);
      if (alt && alt[1] && (alt[1].indexOf(title) >= 0 || title.indexOf(alt[1]) >= 0)) {
        const p = pickPic(i[0], base);
        if (p) return p;
      }
    }
  }
  // 3) og:image
  m = /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i.exec(html);
  if (m) return absUrl(m[1], base);
  // 4) 兜底：正文容器里的第一张图
  m = /<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]{0,3000}?)<\/div>/i.exec(html);
  if (m) {
    const p = pickPic(m[1], base);
    if (p) return p;
  }
  return '';
}

function extractMeta(html) {
  const meta = {};
  const re = /<dd[^>]*>\s*<b[^>]*>([^<：:]{1,8})[：:]\s*<\/b>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const k = tidy(m[1]);
    const v = tidy(m[2]).replace(/\s+/g, ' ').trim();
    if (k && v) meta[k] = v;
  }
  // 状态可能是 <dd><b>状态：6集全</b></dd>
  if (!meta['状态']) {
    const s = /<dd[^>]*>\s*<b[^>]*>状态[：:]\s*([^<]*)<\/b>/i.exec(html);
    if (s) meta['状态'] = tidy(s[1]);
  }
  let desc = '';
  m = /<div[^>]*class="[^"]*\bdes2\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (m) desc = tidy(m[1].replace(/<b[^>]*>剧情[：:]\s*<\/b>/i, ''));
  if (!desc) {
    m = /<div[^>]*class="[^"]*\bdes1\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
    if (m) desc = tidy(m[1].replace(/<b[^>]*>剧情[：:]\s*<\/b>/i, ''));
  }
  desc = desc.replace(/(展开|收起)$/, '').trim();
  // 站点常用占位文案，别当剧情展示
  if (/^(暂无|无简介|暂无简介|暂无剧情|暂无介绍|暂无剧情介绍|未知)/.test(desc) && desc.length < 12) desc = '';
  if (desc) meta['剧情'] = desc;
  return meta;
}

/**
 * 详情页 -> { title, pic, meta, groups:[{pid,name,episodes:[{epid,name}]}] }
 * 线路容器：<div id="stab1{N}">，分集链接：/vp/{vid}-{pid}-{epid}.html
 */
function parseDetail(html, base) {
  const title = extractTitle(html);
  const pic = extractPic(html, title, base);
  const meta = extractMeta(html);

  const positions = [];
  const idRe = /id="stab1(\d+)"/g;
  let m;
  while ((m = idRe.exec(html)) !== null) positions.push({ n: m[1], start: m.index });
  positions.sort((a, b) => parseInt(a.n, 10) - parseInt(b.n, 10));

  const groups = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : html.length;
    const seg = html.slice(p.start, Math.min(end, p.start + 400000));

    const episodes = [];
    const seen = new Set();
    const linkRe = /<a\b([^>]*href="\/vp\/(\d+)-(\d+)-(\d+)\.html"[^>]*)>([\s\S]*?)<\/a>/gi;
    let l;
    let pid = -1;
    while ((l = linkRe.exec(seg)) !== null) {
      const epid = parseInt(l[4], 10);
      if (pid < 0) pid = parseInt(l[3], 10);
      if (seen.has(epid)) continue;
      seen.add(epid);
      const tAttr = /\btitle="([^"]*)"/i.exec(l[1]);
      const name = tidy((tAttr && tAttr[1]) || l[5]) || '第' + (epid + 1) + '集';
      episodes.push({ epid, name });
    }
    episodes.sort((a, b) => a.epid - b.epid);

    const tabRe = new RegExp('<li[^>]*id="tab1' + p.n + '"[^>]*>([\\s\\S]*?)</li>', 'i');
    const tab = tabRe.exec(html);
    let gname = tab ? tidy(tab[1]) : '';
    gname = gname.replace(/^在线观看\s*[（(]?/, '').replace(/[）)]$/, '').trim() || '线路' + p.n;

    if (episodes.length) {
      groups.push({
        pid: pid >= 0 ? pid : parseInt(p.n, 10) - 1,
        name: gname,
        episodes,
      });
    }
  }

  return { title, pic, meta, groups };
}

module.exports = { parseSearch, parseDetail, cleanTitle, decodeEntities, tidy, absUrl };
