'use strict';
/**
 * 多源注册与聚合
 *
 * 职责：
 *  1. 管理所有来源适配器（开关、路由）
 *  2. 聚合搜索：并发查询所有启用的来源，单源失败不影响整体，结果合并去重
 *  3. 统一入口：detail(source, id) / resolve(source, id, pid, epid)
 *
 * 适配器接口：
 *   { id, name, enabled, search(kw), detail(id), resolve(id, pid, epid) }
 */
const CFG = require('../../config');
const xckcdy = require('./xckcdy');
const zip0 = require('./zip0');

// 顺序即优先级：合并去重时保留高优先级来源的结果
const ALL = [xckcdy, zip0];

function listSources() {
  return ALL.map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled !== false,
  }));
}

function get(source) {
  const s = ALL.find((x) => x.id === source);
  return s && s.enabled !== false ? s : null;
}

function withTimeout(p, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg || '超时')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s:：·・'’"“”（）()【】\[\]《》]+/g, '');
}

/**
 * 聚合搜索
 * @returns { results: [{source,id,title,...}], sources: [{source,name,ok,count,error,ms}] }
 */
async function searchAll(kw) {
  const enabled = ALL.filter((s) => s.enabled !== false);
  const timeout = CFG.SOURCE_SEARCH_TIMEOUT;

  const settled = await Promise.all(
    enabled.map(async (s) => {
      const t0 = Date.now();
      try {
        const list = await withTimeout(Promise.resolve(s.search(kw)), timeout, s.name + ' 搜索超时');
        return { source: s.id, name: s.name, ok: true, ms: Date.now() - t0, results: list || [] };
      } catch (e) {
        return {
          source: s.id,
          name: s.name,
          ok: false,
          ms: Date.now() - t0,
          error: (e && e.message) || '失败',
          results: [],
        };
      }
    })
  );

  // 合并 + 按标题去重（保留高优先级来源）
  const seen = new Set();
  const results = [];
  for (const r of settled) {
    for (const it of r.results) {
      const key = normTitle(it.title);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      results.push(it);
    }
  }

  return {
    results,
    sources: settled.map((r) => ({
      source: r.source,
      name: r.name,
      ok: r.ok,
      count: r.results.length,
      ms: r.ms,
      error: r.error || null,
    })),
  };
}

async function detail(source, id) {
  const s = get(source);
  if (!s) throw new Error('未知的来源: ' + source);
  const data = await s.detail(id);
  if (data) data.source = data.source || s.id;
  return data;
}

async function resolve(source, id, pid, epid) {
  const s = get(source);
  if (!s) throw new Error('未知的来源: ' + source);
  return s.resolve(id, pid, epid);
}

module.exports = { ALL, listSources, get, searchAll, detail, resolve, normTitle };
