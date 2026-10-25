/**
 * 设置页和宿主之间的 HTTP 接口。
 *
 * 四个路由，全部挂在 /original-words/ 下面：
 *
 *   GET  /original-words/state              读：配置 + 会话清单（带勾选状态）
 *   POST /original-words/config             写：保存配置
 *   POST /original-words/transfer/precheck  转移前预检（不动文件）
 *   POST /original-words/transfer           执行转移，返回 jobId
 *   GET  /original-words/transfer?jobId=xx  轮询转移进度
 *
 * 转移是唯一会动数据的接口，所以它的进度要能被轮询到——好让前端显示"复制到第几个文件了"，
 * 而不是干等一个白屏。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as cfgMod from './config.js';
import { precheck, transferRoot } from './transfer.js';

/** 转移任务在内存里的进度表。只保留最近 20 条，防止无限增长。 */
const JOBS = new Map();
const MAX_JOBS = 20;

/** 生成一个够用的任务 id。 */
function newJobId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 把任务塞进表里，顺手淘汰旧的。 */
function rememberJob(id, job) {
  JOBS.set(id, job);
  while (JOBS.size > MAX_JOBS) {
    const oldest = JOBS.keys().next().value;
    if (oldest === undefined) break;
    JOBS.delete(oldest);
  }
}

/**
 * 读请求体（最多 1 MB，配置不可能这么大）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('请求体太大了'));
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      if (raw.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
  });
}

/**
 * 注册全部路由。
 *
 * @param {object} ctx - cordis 上下文（需要有 webServer）
 * @param {{
 *   getLiveConfig: () => object,
 *   onConfigSaved?: (cfg: object) => void,
 *   logger?: object,
 * }} deps
 */
export function registerRoutes(ctx, deps) {
  const { getLiveConfig, onConfigSaved } = deps || {};
  const logger = deps && deps.logger;

  /** 统一的 JSON 响应。 */
  const reply = (res, payload) => {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };

  /** 包一层：任何抛错都变成 { ok:false, error }，绝不 500 到前端。 */
  const route = (requestPath, handler) => {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: requestPath,
        handler: async (req, res) => {
          try {
            await handler(req, res);
          } catch (error) {
            reply(res, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    );
  };

  /**
   * 当前会话清单。
   *
   * 清单来源按 speak-up 的实测经验：`ctx.get('sessions').list()` 拿 id，
   * `ctx.get('sessions').get(id)` 拿会话对象，`ctx.get('sessionTitle').get(会话)` 拿标题。
   * 归档会话用 `workspaceRegistry.archivedSessionIds` 排除，但**已经勾选的归档会话仍然列出**，
   * 否则用户看不见它、也就没法取消勾选。
   */
  const listSessions = () => {
    const sessionService = ctx.get('sessions');
    const titleService = ctx.get('sessionTitle');
    const live = typeof getLiveConfig === 'function' ? getLiveConfig() : cfgMod.mergeConfig({});
    const picked = live && live.sessions ? live.sessions : {};

    /** 收集 id。 */
    const ids = new Set();
    try {
      if (sessionService && typeof sessionService.list === 'function') {
        for (const s of sessionService.list()) {
          const id = String((s && s.id) || '');
          if (id.length > 0) ids.add(id);
        }
      }
    } catch {
      /* 服务不可用就退到下面的兜底 */
    }
    try {
      for (const a of ctx.agents.list()) {
        const id = String((a && a.id) || '');
        if (id.length > 0) ids.add(id);
      }
    } catch {
      /* 没有 agents 服务也不影响读配置 */
    }

    /** 归档名单。 */
    const archived = new Set();
    try {
      const registry = ctx.workspaceRegistry || ctx.get('workspaceRegistry');
      for (const x of (registry && registry.archivedSessionIds) || []) archived.add(String(x));
    } catch {
      /* 拿不到就当没有归档 */
    }

    const out = [];
    for (const id of ids) {
      const isArchived = archived.has(id);
      const isPicked = !!(picked[id] && picked[id].enabled === true);
      if (isArchived && !isPicked) continue;

      let session;
      try {
        session = sessionService && typeof sessionService.get === 'function' ? sessionService.get(id) : undefined;
      } catch {
        session = undefined;
      }

      let title = '';
      try {
        const snapshot = titleService && typeof titleService.get === 'function' ? titleService.get(session) : undefined;
        title = String((snapshot && snapshot.title) || '');
      } catch {
        title = '';
      }
      // 服务拿不到标题时，退到配置文件里存过的那份
      if (title.length === 0 && picked[id] && typeof picked[id].title === 'string') title = picked[id].title;

      out.push({
        id,
        short: cfgMod.shortIdOf(id),
        title,
        folder: picked[id] && typeof picked[id].folder === 'string' ? picked[id].folder : '',
        enabled: isPicked,
        archived: isArchived,
      });
    }

    // 勾选了的排前面，其余按标题排
    out.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.title || a.short).localeCompare(b.title || b.short, 'zh');
    });
    return out;
  };

  // ── GET /original-words/state ────────────────────────────────
  route('/original-words/state', async (req, res) => {
    const live = getLiveConfig ? getLiveConfig() : cfgMod.mergeConfig({});
    const configFile = cfgMod.configPath();
    const configExists = fs.existsSync(configFile);
    const rootDir =
      live && typeof live.rootDir === 'string' && live.rootDir.length > 0 ? live.rootDir : cfgMod.defaultRootDir();

    reply(res, {
      ok: true,
      // 配置文件不存在 = 还在旧行为（全记、扁平目录），界面要把这件事说清楚
      configExists,
      configPath: configFile,
      rootDir,
      defaultRootDir: cfgMod.defaultRootDir(),
      enabled: !(live && live.enabled === false),
      saveReasoning: !(live && live.saveReasoning === false),
      header: live && typeof live.header === 'string' ? live.header : '',
      sessions: listSessions(),
    });
  });

  // ── POST /original-words/config ─────────────────────────────
  route('/original-words/config', async (req, res) => {
    const body = await readJsonBody(req);
    const current = getLiveConfig ? getLiveConfig() : cfgMod.mergeConfig({});

    const next = { ...current, sessions: { ...(current.sessions || {}) } };

    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.saveReasoning === 'boolean') next.saveReasoning = body.saveReasoning;
    if (typeof body.rootDir === 'string' && body.rootDir.trim().length > 0) next.rootDir = body.rootDir.trim();

    // sessions：只接受数组，每项 { id, enabled, title }
    if (Array.isArray(body.sessions)) {
      const known = listSessions();
      const byId = new Map(known.map((s) => [s.id, s]));
      for (const item of body.sessions) {
        if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
        const meta = byId.get(item.id);
        const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : (meta && meta.title) || '';
        const enabled = item.enabled === true;
        if (!enabled) {
          // 取消勾选 = 从白名单里拿掉（连同它的文件夹记录）
          delete next.sessions[item.id];
          continue;
        }
        const folder = cfgMod.folderForSession(next, item.id, title);
        next.sessions[item.id] = { title, folder, enabled: true };
      }
    }

    const saved = cfgMod.saveConfig(next);
    if (!saved.ok) return reply(res, { ok: false, error: `保存失败：${saved.error}` });

    try {
      if (typeof onConfigSaved === 'function') onConfigSaved(next);
    } catch (error) {
      logger?.warn?.(`[original-words] 保存后刷新内存配置失败：${error && error.message ? error.message : error}`);
    }

    reply(res, { ok: true, configPath: cfgMod.configPath(), sessions: listSessions() });
  });

  // ── POST /original-words/transfer/precheck ──────────────────
  route('/original-words/transfer/precheck', async (req, res) => {
    const body = await readJsonBody(req);
    const live = getLiveConfig ? getLiveConfig() : cfgMod.mergeConfig({});
    const from =
      typeof body.from === 'string' && body.from.trim().length > 0
        ? body.from.trim()
        : live && live.rootDir
          ? live.rootDir
          : cfgMod.defaultRootDir();
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const result = await precheck({ from, to });
    reply(res, { ok: result.ok, error: result.error, fileCount: result.fileCount, bytes: result.bytes, from, to });
  });

  // ── POST /original-words/transfer ───────────────────────────
  route('/original-words/transfer', async (req, res) => {
    const body = await readJsonBody(req);
    const live = getLiveConfig ? getLiveConfig() : cfgMod.mergeConfig({});
    const from =
      typeof body.from === 'string' && body.from.trim().length > 0
        ? body.from.trim()
        : live && live.rootDir
          ? live.rootDir
          : cfgMod.defaultRootDir();
    const to = typeof body.to === 'string' ? body.to.trim() : '';

    const pre = await precheck({ from, to });
    if (!pre.ok) return reply(res, { ok: false, error: pre.error });

    const jobId = newJobId();
    const job = { phase: 'queued', done: 0, total: pre.fileCount, bytes: 0, text: '排队中', finished: false, ok: false, error: '', result: null };
    rememberJob(jobId, job);

    // 后台跑，立刻把 jobId 还给前端
    (async () => {
      try {
        const result = await transferRoot({
          from,
          to,
          onProgress: (p) => {
            job.phase = p.phase;
            job.done = p.done;
            job.total = p.total;
            job.bytes = p.bytes;
            job.text = p.text;
          },
        });
        job.finished = true;
        job.ok = result.ok;
        job.error = result.error;
        job.result = result;
        if (result.ok) {
          // 转移成功：把配置里的 rootDir 指到新位置
          const next = { ...(getLiveConfig ? getLiveConfig() : cfgMod.mergeConfig({})), rootDir: path.resolve(to) };
          const saved = cfgMod.saveConfig(next);
          job.text = saved.ok ? '完成，配置已指向新位置' : `数据已转移，但配置保存失败：${saved.error}`;
          job.ok = saved.ok;
          job.error = saved.ok ? '' : saved.error;
        }
      } catch (error) {
        job.finished = true;
        job.ok = false;
        job.error = String((error && error.message) || error);
        job.text = '出错';
      }
    })();

    reply(res, { ok: true, jobId, total: pre.fileCount, bytes: pre.bytes, from, to });
  });

  // ── GET /original-words/transfer/status?jobId=xxx ──────────
  route('/original-words/transfer/status', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const jobId = url.searchParams.get('jobId') || '';
    const job = JOBS.get(jobId);
    if (!job) return reply(res, { ok: false, error: '找不到这个转移任务（可能已经过期）' });
    reply(res, { ok: true, job });
  });
}
