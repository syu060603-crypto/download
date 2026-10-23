'use strict';
/**
 * 下载任务管理
 *
 * 相比初版：
 *  1. 任务持久化到 data/jobs.json —— App 被系统杀掉/切后台重启后，任务列表和
 *     进度都还在，可以直接「继续」。
 *  2. 分集并行：初版严格一集一集下，10 集就是 10 倍时间；现在默认同时下 2 集
 *     （可调），配合分片并发，多文件整体速度提升明显。
 *  3. 解析与下载流水线：解析下一集的同时，当前集已经在下载，不再串行等待。
 *  4. 暂停/继续/重试/删除（含删文件）。
 *  5. 断点续传：取消或中断后再次下载从断点继续（依赖 hls 的 .part 状态文件）。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const CFG = require('../config');
const hls = require('./hls');
const resolver = require('./resolver');

const JOBS_FILE = path.join(CFG.DATA_DIR, 'jobs.json');
const MAX_JOBS = 40;

const bus = new EventEmitter();
bus.setMaxListeners(50);

// ---------------------------------------------------------------- 工具
function sanitizeName(s, max) {
  let t = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^\.+/, '').replace(/\.+$/, '');
  const limit = max || 70;
  if (t.length > limit) t = t.slice(0, limit).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = '_' + t;
  return t || 'untitled';
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function newId() {
  return 'J' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------- 状态
/** id -> 运行时控制块（不持久化） */
const controls = new Map();
const jobs = new Map();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 600);
}

function saveNow() {
  try {
    ensureDir(CFG.DATA_DIR);
    const list = [...jobs.values()].slice(-MAX_JOBS);
    const tmp = JOBS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, jobs: list }));
    fs.renameSync(tmp, JOBS_FILE);
  } catch (e) {
    /* 持久化失败不影响下载 */
  }
}

function load() {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const j of data.jobs || []) {
      if (!j || !j.id) continue;
      // 上次没跑完的，标成暂停（可续传）
      if (j.status === 'running' || j.status === 'queued') j.status = 'paused';
      for (const f of j.files || []) {
        if (f.status === 'downloading' || f.status === 'resolving' || f.status === 'pending') f.status = 'paused';
        f.speed = 0;
        f.eta = 0;
      }
      jobs.set(j.id, j);
    }
  } catch (e) {
    /* 首次运行没有文件 */
  }
}

function emit(kind, job) {
  bus.emit('update', { kind, id: job ? job.id : null });
}

// ---------------------------------------------------------------- 快照
function fileSnapshot(f, i) {
  return {
    idx: i,
    name: f.name,
    vid: f.vid,
    pid: f.pid,
    epid: f.epid,
    status: f.status,
    done: f.done || 0,
    total: f.total || 0,
    bytes: f.bytes || 0,
    speed: f.speed || 0,
    eta: f.eta || 0,
    error: f.error || null,
    hasFile: !!(f.file && f.status === 'done'),
  };
}

function snapshot(job) {
  if (!job) return null;
  let done = 0;
  let total = 0;
  let bytes = 0;
  let speed = 0;
  const files = job.files.map((f, i) => {
    done += f.done || 0;
    total += f.total || 0;
    bytes += f.bytes || 0;
    speed += f.speed || 0;
    return fileSnapshot(f, i);
  });
  const finished = files.filter((f) => f.status === 'done' || f.status === 'skipped').length;
  return {
    id: job.id,
    title: job.title,
    pic: job.pic || '',
    vid: job.vid || '',
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || 0,
    quality: job.quality || 'best',
    dir: job.dir,
    episodeConcurrency: job.episodeConcurrency,
    segmentConcurrency: job.segmentConcurrency,
    files,
    stats: {
      done,
      total,
      bytes,
      speed,
      percent: total ? Math.round((done / total) * 100) : finished === files.length && files.length ? 100 : 0,
      finished,
      count: files.length,
      eta: speed > 0 && total > done ? Math.round(((total - done) * (bytes / Math.max(1, done))) / speed) : 0,
    },
  };
}

function list() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot);
}

function get(id) {
  return jobs.get(id) || null;
}

// ---------------------------------------------------------------- 创建
function create(body) {
  const id = newId();
  const title = sanitizeName(body.title || '未命名');
  const items = Array.isArray(body.items) ? body.items : [];
  const quality = ['best', 'saver'].includes(body.quality) ? body.quality : 'best';
  const episodeConcurrency = Math.max(1, Math.min(parseInt(body.episodeConcurrency, 10) || CFG.EPISODE_CONCURRENCY, 4));
  const segmentConcurrency = Math.max(
    2,
    Math.min(parseInt(body.segmentConcurrency, 10) || CFG.SEGMENT_CONCURRENCY, CFG.SEGMENT_CONCURRENCY_MAX)
  );

  const dir = path.join(CFG.DOWNLOAD_DIR, title);
  const used = new Set();
  const files = items.map((it, i) => {
    const base = sanitizeName(title + '_' + (it.name || 'E' + (Number(it.epid) + 1)));
    let name = base;
    let n = 2;
    while (used.has(name)) name = base + '(' + n++ + ')';
    used.add(name);
    return {
      name: it.name || 'E' + (Number(it.epid) + 1),
      vid: String(it.vid),
      pid: parseInt(it.pid, 10) || 0,
      epid: parseInt(it.epid, 10) || 0,
      m3u8: it.m3u8 || null,
      status: 'pending',
      done: 0,
      total: 0,
      bytes: 0,
      speed: 0,
      eta: 0,
      error: null,
      file: path.join(dir, name + '.ts'),
      attempts: 0,
    };
  });

  const job = {
    id,
    title,
    pic: body.pic || '',
    vid: String(body.vid || ''),
    quality,
    episodeConcurrency,
    segmentConcurrency,
    dir,
    createdAt: Date.now(),
    status: 'queued',
    files,
  };
  jobs.set(id, job);
  scheduleSave();
  emit('created', job);
  return job;
}

// ---------------------------------------------------------------- 执行
function ctlOf(job) {
  let c = controls.get(job.id);
  if (!c) {
    c = { paused: false, cancelled: false, running: false, acs: new Set() };
    controls.set(job.id, c);
  }
  return c;
}

function newAbort(ctl) {
  const ac = new AbortController();
  ctl.acs.add(ac);
  ac.signal.addEventListener(
    'abort',
    () => {
      ctl.acs.delete(ac);
    },
    { once: true }
  );
  return ac.signal;
}

function abortAll(ctl) {
  for (const ac of [...ctl.acs]) {
    try {
      ac.abort();
    } catch (e) {
      /* noop */
    }
  }
  ctl.acs.clear();
}

async function runFile(job, f, ctl) {
  if (f.status === 'done' || f.status === 'skipped') return;
  f.status = 'resolving';
  f.error = null;
  emit('file', job);

  // 文件已存在则跳过
  try {
    if (f.file && fs.existsSync(f.file) && fs.statSync(f.file).size > 0) {
      f.status = 'skipped';
      f.bytes = fs.statSync(f.file).size;
      emit('file', job);
      return;
    }
  } catch (e) {
    /* noop */
  }

  // 解析
  if (!f.m3u8) {
    const r = await resolver.resolveEpisode(f.vid, f.pid, f.epid);
    f.m3u8 = r.m3u8;
  }

  f.status = 'downloading';
  f.attempts = (f.attempts || 0) + 1;
  emit('file', job);

  const signal = newAbort(ctl);
  const info = await hls.downloadEpisode(f.m3u8, f.file, {
    concurrency: job.segmentConcurrency,
    quality: job.quality,
    signal,
    onProgress: (p) => {
      f.done = p.done;
      f.total = p.total;
      f.bytes = p.bytes;
      f.speed = p.speed;
      f.eta = p.eta;
      emit('file', job);
    },
  });
  f.done = info.total;
  f.total = info.total;
  f.bytes = info.bytes;
  f.speed = 0;
  f.eta = 0;
  f.status = 'done';
  emit('file', job);
}

async function runJob(job) {
  const ctl = ctlOf(job);
  if (ctl.running) return;
  ctl.running = true;
  ctl.paused = false;
  ctl.cancelled = false;
  job.status = 'running';
  job.finishedAt = 0;
  emit('job', job);

  try {
    ensureDir(job.dir);
  } catch (e) {
    job.status = 'error';
    job.error = '无法创建目录: ' + e.message;
    ctl.running = false;
    emit('job', job);
    return;
  }

  const worker = async (queue) => {
    for (;;) {
      if (ctl.cancelled) return;
      while (ctl.paused && !ctl.cancelled) await sleep(200);
      if (ctl.cancelled) return;
      const i = cursor++;
      if (i >= queue.length) return;
      const f = queue[i];
      try {
        await runFile(job, f, ctl);
      } catch (e) {
        const aborted = (e && e.aborted) || /取消/.test(e.message || '');
        if (ctl.cancelled) {
          f.status = 'cancelled';
          f.speed = f.eta = 0;
        } else if (ctl.paused || aborted) {
          // 保留 paused 状态与 .part 断点，等用户「继续」
          f.status = 'paused';
          f.speed = f.eta = 0;
        } else {
          // 播放地址可能已过期：重新解析一次再试
          if ((f.attempts || 0) < 2) {
            f.m3u8 = null;
            try {
              const r = await resolver.resolveEpisode(f.vid, f.pid, f.epid, { ttl: 0 });
              f.m3u8 = r.m3u8;
              await runFile(job, f, ctl);
              emit('file', job);
              continue;
            } catch (e2) {
              f.error = e2.message;
            }
          }
          f.status = 'error';
          f.error = f.error || e.message;
          f.speed = f.eta = 0;
        }
        emit('file', job);
      }
    }
  };

  // 多轮：暂停后继续时，被打断的那一集会回到 pending/paused，需要重新入队
  let cursor = 0;
  let rounds = 0;
  while (!ctl.cancelled && !ctl.paused && rounds++ < 6) {
    const queue = job.files.filter((f) => f.status === 'pending' || f.status === 'paused');
    if (!queue.length) break;
    cursor = 0;
    const n = Math.max(1, Math.min(job.episodeConcurrency || CFG.EPISODE_CONCURRENCY, queue.length));
    await Promise.all(Array.from({ length: n }, () => worker(queue)));
    if (ctl.cancelled || ctl.paused) break;
  }

  const hasErr = job.files.some((f) => f.status === 'error');
  const allDone = job.files.every((f) => f.status === 'done' || f.status === 'skipped');
  if (ctl.cancelled) job.status = 'cancelled';
  else if (ctl.paused) job.status = 'paused';
  else if (allDone) job.status = 'done';
  else if (hasErr) job.status = 'error';
  else job.status = 'paused';
  job.finishedAt = Date.now();
  ctl.running = false;
  for (const f of job.files) {
    if (f.status === 'downloading' || f.status === 'resolving' || f.status === 'pending') f.status = job.status === 'cancelled' ? 'cancelled' : 'paused';
    f.speed = 0;
    f.eta = 0;
  }
  scheduleSave();
  emit('job', job);
}

// ---------------------------------------------------------------- 操作
function pause(id) {
  const job = jobs.get(id);
  if (!job) return false;
  const ctl = ctlOf(job);
  if (!ctl.running) return false;
  ctl.paused = true;
  abortAll(ctl);
  job.status = 'paused';
  emit('job', job);
  return true;
}

function resume(id) {
  const job = jobs.get(id);
  if (!job) return false;
  const ctl = ctlOf(job);
  if (ctl.running) {
    // 暂停只是挂起工作协程，这里直接放行即可；状态必须同步回 running，
    // 否则界面会一直显示「已暂停」（初版 bug）。
    ctl.paused = false;
    job.status = 'running';
    job.finishedAt = 0;
    scheduleSave();
    emit('job', job);
    return true;
  }
  for (const f of job.files) {
    if (f.status === 'paused' || f.status === 'cancelled' || f.status === 'pending') f.status = 'pending';
  }
  runJob(job);
  return true;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  const ctl = ctlOf(job);
  ctl.cancelled = true;
  ctl.paused = false;
  abortAll(ctl);
  job.status = 'cancelled';
  for (const f of job.files) {
    if (f.status === 'downloading' || f.status === 'resolving' || f.status === 'pending') f.status = 'cancelled';
    f.speed = f.eta = 0;
  }
  scheduleSave();
  emit('job', job);
  return true;
}

/** 重试失败的集（可选指定下标） */
function retry(id, idxList) {
  const job = jobs.get(id);
  if (!job) return false;
  const ctl = ctlOf(job);
  if (ctl.running) return false;
  const targets = Array.isArray(idxList) && idxList.length ? idxList : job.files.map((_, i) => i);
  for (const i of targets) {
    const f = job.files[i];
    if (!f) continue;
    if (f.status === 'error' || f.status === 'cancelled' || f.status === 'paused') {
      f.status = 'pending';
      f.error = null;
      f.attempts = 0;
    }
  }
  runJob(job);
  return true;
}

function remove(id, deleteFiles) {
  const job = jobs.get(id);
  if (!job) return false;
  const ctl = controls.get(id);
  if (ctl) {
    ctl.cancelled = true;
    abortAll(ctl);
  }
  controls.delete(id);
  jobs.delete(id);
  if (deleteFiles) {
    for (const f of job.files) {
      for (const p of [f.file, f.file + '.part', f.file + '.part.json']) {
        try {
          if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
          /* noop */
        }
      }
    }
    try {
      if (fs.existsSync(job.dir) && fs.readdirSync(job.dir).length === 0) fs.rmdirSync(job.dir);
    } catch (e) {
      /* noop */
    }
  }
  saveNow();
  emit('removed', job);
  return true;
}

/** 已完成文件列表（重启后也能取回） */
function listFiles() {
  const out = [];
  for (const job of jobs.values()) {
    job.files.forEach((f, i) => {
      if (f.status !== 'done' && f.status !== 'skipped') return;
      try {
        const st = fs.statSync(f.file);
        out.push({
          jobId: job.id,
          idx: i,
          title: job.title,
          name: f.name,
          size: st.size,
          mtime: st.mtimeMs,
          path: f.file,
        });
      } catch (e) {
        /* 文件已被删除 */
      }
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function activeCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'running') n++;
  return n;
}

load();

module.exports = {
  bus,
  list,
  get,
  create,
  runJob,
  pause,
  resume,
  cancel,
  retry,
  remove,
  snapshot,
  listFiles,
  activeCount,
  saveNow,
  sanitizeName,
};
