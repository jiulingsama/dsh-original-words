/**
 * dsh-original-words v0.1 — 原话存档器
 *
 * 只做一件事：**把用户本人发出的每一轮消息，逐字追加到一份纯文本里。**
 *
 * 不摘要、不判断重要性、不经过模型、不掺任何注入内容。
 * 它不解决"记住"，它解决"证据"——压缩之后还能对着原文核。
 *
 * ── 为什么不是简单地监听 user/message ──────────────────────────────
 * DSH 会话里 type === "user/message" 的事件**并不全是用户说的话**：
 * 时钟、记忆注入、技能目录、运行时上下文，全都以 user 角色、user/message
 * 类型落进同一个日志。实测某个会话 226 条 user/message 里只有 163 条是
 * 真的用户消息，其余 63 条是注入。
 *
 * 所以过滤条件必须是三条同时成立：
 *   1. event.type === "user/message"
 *   2. data.role === "user"
 *   3. data.source.kind === "user"        ← 这一条才是分水岭
 *
 * 真实消息的 source 长这样（还带 rpcId 和 clientTimeZone）：
 *   { kind: "user", rpcId: "21c927db-...", clientTimeZone: "..." }
 * 而注入的 kind 是 time-context / plugin:meow-memory / skill-catalog /
 * runtime-context 等。
 *
 * ── 去重 ────────────────────────────────────────────────────────
 * 用 source.rpcId 做键。进程内存一份 Set，切到新的一天时重新从当天文件
 * 里读回来，所以重启 DSH 也不会把同一句话写第二遍。
 *
 * ── 安全 ────────────────────────────────────────────────────────
 * 整个处理包在 try/catch 里，任何异常只 warn 一行，绝不影响会话本身。
 * 写盘用 appendFileSync：一句话一句话落盘，进程被强杀也不丢已经写下的部分。
 *
 * 零外部依赖：不 import 任何包，只用 node 内置模块。
 *
 * @module dsh-original-words
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// v1 新增：配置外置 + 白名单 + 按会话分目录。这个模块不 import 本文件，没有循环依赖。
import * as cfgMod from './config.js';
import { registerRoutes } from './routes.js';

/** Cordis 插件名。 */
export const name = 'dsh-original-words';

/**
 * 需要的能力：提示词注册表（用来每轮告诉模型自己在哪个会话）+ 设置页要用到的三个服务。
 *
 * ⚠ 只在确实会用到的服务上写 inject——多写一个当前版本不存在的服务名，
 *   插件会**永远等不到依赖、根本不启动**，而且看起来只是"没反应"。
 */
export const inject = ['systemPrompt', 'webServer', 'sessions', 'sessionTitle'];

/** 默认配置。 */
export const DEFAULTS = Object.freeze({
  /** 输出目录；空 = 自动推导（见 resolveOutDir）。 */
  outDir: '',
  /** 总开关。 */
  enabled: true,
  /** 文件头的一句话说明，写成空串可以关掉。 */
  header: '> 由 dsh-original-words 自动记录，只收你本人发出的消息，逐字不删改。',
  /** 是否在每条记录后面标注来自哪个会话。关掉就和 v0.1 一样。 */
  tagSession: true,
  /** 是否把我这边的思考过程也存进去（默认存）。 */
  saveReasoning: true,
  /** 是否每轮往系统提示里注入"你在哪个会话"。 */
  announceSession: true,
  /** 注入段的排序：dsh-clock 是 850、dsh-mood 是 860，夹在中间。 */
  sectionOrder: 855,
});

/**
 * 从 session 对象上取会话 id。
 * 不同版本可能挂在 id / sessionId / key 上，挨个试。
 *
 * @param {unknown} session
 * @returns {string}
 */
export function sessionIdOf(session) {
  if (session === null || typeof session !== 'object') return '';
  for (const key of ['id', 'sessionId', 'key', 'sid']) {
    const value = session[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/**
 * 会话 id → 8 位短号。去掉可能的 `session-` 前缀。
 *
 * @param {unknown} session
 * @returns {string}
 */
export function shortSessionId(session) {
  const raw = sessionIdOf(session);
  if (raw.length === 0) return '';
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
  return bare.slice(0, 8);
}

/**
 * `session/title` 事件里取出标题。
 *
 * @param {unknown} event
 * @returns {string}
 */
export function titleOfEvent(event) {
  if (event === null || typeof event !== 'object') return '';
  if (event.type !== 'session/title') return '';
  const data = event.data;
  if (data === null || typeof data !== 'object') return '';
  return typeof data.title === 'string' ? data.title.trim() : '';
}

/** rpcId 形如 8-4-4-4-12 的十六进制 uuid。 */
const RPC_ID_RE = /· ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*$/;

/** 两位补零。 */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日期键：YYYY-MM-DD。 */
export function localDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地时间键：HH:mm:ss。 */
export function localTimeKey(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * 从消息 content 里取出可读文本。
 * 纯字符串直接用；块数组里 text 块拼起来，图片标 [图片]，其它块标 [类型]。
 *
 * @param {unknown} content - message.content
 * @returns {string}
 */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const type = block.type;
    if (type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text);
    } else if (type === 'image') {
      parts.push('[图片]');
    } else if (typeof type === 'string') {
      parts.push(`[${type}]`);
    }
  }
  return parts.join('\n');
}

/**
 * 判断一个 session/event 是不是"用户本人说的话"。
 *
 * @param {unknown} event - session/event 的事件对象
 * @returns {{ ok: boolean, rpcId: string, text: string, time: number }}
 */
export function classifyEvent(event) {
  const none = { ok: false, rpcId: '', text: '', time: 0 };
  if (event === null || typeof event !== 'object') return none;
  if (event.type !== 'user/message') return none;

  const data = event.data;
  if (data === null || typeof data !== 'object') return none;
  if (data.role !== 'user') return none;

  const source = data.source;
  if (source === null || typeof source !== 'object') return none;
  // 分水岭：注入内容的 kind 不是 "user"。
  if (source.kind !== 'user') return none;

  const text = extractText(data.content);
  if (typeof text !== 'string' || text.trim().length === 0) return none;

  const rpcId = typeof source.rpcId === 'string' ? source.rpcId : '';
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now();
  return { ok: true, rpcId, text, time };
}

/**
 * 从 assistant 消息的 content 里拆出「思考」和「回复」两块。
 * 块类型有 reasoning / text / tool-call，这里只要前两种。
 *
 * @param {unknown} content
 * @returns {{ thinking: string, reply: string }}
 */
export function splitAssistant(content) {
  if (!Array.isArray(content)) return { thinking: '', reply: '' };
  const thinking = [];
  const reply = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) thinking.push(block.text);
    else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) reply.push(block.text);
  }
  return { thinking: thinking.join('\n\n'), reply: reply.join('\n\n') };
}

/**
 * 判断是不是「我这边说的话」，并拆成思考 + 回复。
 * 纯工具调用（既没思考也没文字）返回 ok:false，不给底稿添噪音。
 *
 * @param {unknown} event - session/event 的事件对象
 * @param {{ saveReasoning?: boolean }} [config]
 * @returns {{ ok: boolean, seq: number, text: string, time: number }}
 */
export function classifyAssistant(event, config = {}) {
  const none = { ok: false, seq: -1, text: '', time: 0 };
  if (event === null || typeof event !== 'object') return none;
  if (event.type !== 'assistant/message') return none;
  const data = event.data;
  if (data === null || typeof data !== 'object') return none;
  const message = data.message;
  if (message === null || typeof message !== 'object') return none;
  if (message.role !== 'assistant') return none;

  const { thinking, reply } = splitAssistant(message.content);
  const keptThinking = config.saveReasoning !== false ? thinking : '';
  if (keptThinking.length === 0 && reply.length === 0) return none;

  const parts = [];
  if (keptThinking.length > 0) parts.push(`（思考）\n${keptThinking}`);
  if (reply.length > 0) parts.push(`（回复）\n${reply}`);

  const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1;
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now();
  return { ok: true, seq, text: parts.join('\n\n'), time };
}

/**
 * 取这个会话的标题：先看内存里的（session/title 事件写进去的），
 * 再看 _会话索引.md 里落盘的（跨重启保留）。
 * 后者就是「明明文件里写着标题，重启后却变回尚未命名」的解药。
 *
 * @param {{ titles?: Map<string, string>, indexTitles?: Map<string, string> }} state
 * @param {unknown} session
 * @returns {string}
 */
export function resolveTitle(state, session) {
  const full = sessionIdOf(session);
  const short = shortSessionId(session);
  if (state !== null && typeof state === 'object' && state.titles instanceof Map && full.length > 0) {
    const fromMemory = state.titles.get(full);
    if (typeof fromMemory === 'string' && fromMemory.length > 0) return fromMemory;
  }
  if (state !== null && typeof state === 'object' && state.indexTitles instanceof Map && short.length > 0) {
    const fromIndex = state.indexTitles.get(short);
    if (typeof fromIndex === 'string' && fromIndex.length > 0) return fromIndex;
  }
  return '';
}

/**
 * 推导输出目录。
 * 优先 config.outDir，其次 session 上能拿到的 cwd，其次 $DSH_WORKSPACE，
 * 最后退到 ~/Documents/dsh。任何一步失败都不抛错。
 *
 * @param {unknown} session - 会话对象（可能带 cwd / header.cwd）
 * @param {string} configured - 配置里的 outDir
 * @returns {string}
 */
export function resolveOutDir(session, configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();

  const candidates = [];
  if (session !== null && typeof session === 'object') {
    candidates.push(session.cwd, session.workspace);
    if (session.header !== null && typeof session.header === 'object') candidates.push(session.header.cwd);
  }
  candidates.push(process.env.DSH_WORKSPACE);
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return path.join(c.trim(), '原话');
    }
  }
  return path.join(os.homedir(), 'Documents', 'dsh', '原话');
}

/**
 * 从已有文件里把写过的 rpcId 读回来（跨重启去重）。
 *
 * @param {string} file - 当天文件路径
 * @param {Set<string>} into - 收集用的 Set
 */
export function loadExistingIds(file, into) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('## ')) continue;
    const m = RPC_ID_RE.exec(line);
    if (m !== null) into.add(m[1]);
  }
}

/**
 * 读 `_会话索引.md`，得到「短号 → 标题」。
 *
 * 这是标题能跨重启存活的来源：内存里的 titles 会在进程重启时清空，
 * 而落盘的索引不会。没有这一层，重启后老会话就会一直显示「尚未命名」。
 *
 * @param {string} file - 索引文件路径
 * @returns {Map<string, string>}
 */
export function loadIndexTitles(file) {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return map;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    const m = /^-\s*([0-9a-fA-F]{8})\s*=\s*(.+)$/.exec(line);
    if (m !== null) map.set(m[1].toLowerCase(), m[2].trim());
  }
  return map;
}

/**
 * 组装要追加的文本块。
 *
 * 标题行的形状：`## 02:57:22 · abcd1234 · 「优化打开等待时间」 · <rpcId>`
 * 会话短号和标题用来区分"这句话是哪个对话里说的"；rpcId 用来去重。
 *
 * @param {{ day: string, time: string, rpcId?: string, sessionShort?: string, sessionTitle?: string, text: string, needsHeader: boolean, header: string }} parts
 * @returns {string}
 */
export function buildChunk(parts) {
  let chunk = '';
  if (parts.needsHeader) {
    chunk += `# 原话 · ${parts.day}\n\n`;
    if (typeof parts.header === 'string' && parts.header.length > 0) chunk += `${parts.header}\n\n`;
  }
  const marks = [parts.time];
  if (typeof parts.sessionShort === 'string' && parts.sessionShort.length > 0) marks.push(parts.sessionShort);
  if (typeof parts.sessionTitle === 'string' && parts.sessionTitle.length > 0) marks.push(`「${parts.sessionTitle}」`);
  if (typeof parts.rpcId === 'string' && parts.rpcId.length > 0) marks.push(parts.rpcId);
  chunk += `## ${marks.join(' · ')}\n\n${parts.text.trim()}\n\n`;
  return chunk;
}

/**
 * 组装「我这边说的话」的文本块。用三级标题，和用户消息的二级标题区分开。
 *
 * 形状：`### 18:02:31 · abcd1234 · 「示例对话」 · 我`
 *
 * @param {{ day: string, time: string, sessionShort?: string, sessionTitle?: string, text: string, needsHeader: boolean, header: string }} parts
 * @returns {string}
 */
export function buildAssistantChunk(parts) {
  let chunk = '';
  if (parts.needsHeader) {
    chunk += `# 原话 · ${parts.day}\n\n`;
    if (typeof parts.header === 'string' && parts.header.length > 0) chunk += `${parts.header}\n\n`;
  }
  const marks = [parts.time];
  if (typeof parts.sessionShort === 'string' && parts.sessionShort.length > 0) marks.push(parts.sessionShort);
  if (typeof parts.sessionTitle === 'string' && parts.sessionTitle.length > 0) marks.push(`「${parts.sessionTitle}」`);
  marks.push('我');
  chunk += `### ${marks.join(' · ')}\n\n${parts.text.trim()}\n\n`;
  return chunk;
}

/**
 * 核心处理：一个事件进，必要时一次写盘出。
 * 抽出来是为了能在不挂载插件的情况下离线测试。
 *
 * @param {{ session: unknown, event: unknown, state: { currentFile: string, seen: Set<string> }, config: object, fsImpl?: typeof fs }} input
 * @returns {boolean} 是否真的写了一行
 */
export function handleEvent(input) {
  const { session, event, state, config } = input;
  const fsImpl = input.fsImpl ?? fs;

  const userHit = classifyEvent(event);
  const asstHit = userHit.ok ? { ok: false, seq: -1, text: '', time: 0 } : classifyAssistant(event, config);
  if (!userHit.ok && !asstHit.ok) return false;

  // v1：调用方可以显式指定目录（白名单模式下按会话分文件夹）。
  // 不指定就回退旧逻辑——离线测试、以及「还没有配置文件」的情况都走这条。
  const dir =
    typeof input.dir === 'string' && input.dir.length > 0
      ? input.dir
      : resolveOutDir(session, config.outDir);
  const when = new Date(userHit.ok ? userHit.time : asstHit.time);
  const day = localDateKey(when);
  const file = path.join(dir, `${day}.md`);

  // 去重集按**文件**分桶。
  //
  // 以前只有一个 currentFile：单会话时够用，但分目录之后多个会话并行，
  // 每写一条就要在几个文件之间来回切——每次切都重读整份文件重建去重集，
  // 文件一大就会把主线程拖死。分桶之后每个文件只读一次。
  // 单文件场景下行为跟原来完全一样（byFile 里只有一个桶）。
  if (!(state.byFile instanceof Map)) state.byFile = new Map();
  let seen = state.byFile.get(file);
  if (!seen) {
    seen = new Set();
    loadExistingIds(file, seen);
    state.byFile.set(file, seen);
  }
  state.currentFile = file;
  state.seen = seen;

  // 用户消息用 rpcId 去重；我的消息没有 rpcId，用会话内递增的 seq
  const dedupeKeys = [];
  if (userHit.ok && userHit.rpcId.length > 0) dedupeKeys.push(userHit.rpcId);
  if (!userHit.ok && asstHit.seq >= 0) dedupeKeys.push(`a:${asstHit.seq}`);
  if (dedupeKeys.some((k) => state.seen.has(k))) return false;

  // 会话标识：短号一定有；标题先查内存，再查 _会话索引.md（跨重启保留）
  let sessionShort = '';
  let sessionTitle = '';
  if (config.tagSession !== false) {
    sessionShort = shortSessionId(session);
    sessionTitle = resolveTitle(state, session);
  }

  const exists = fsImpl.existsSync(file);
  const chunk = userHit.ok
    ? buildChunk({
        day,
        time: localTimeKey(when),
        rpcId: userHit.rpcId,
        sessionShort,
        sessionTitle,
        text: userHit.text,
        needsHeader: !exists,
        header: config.header,
      })
    : buildAssistantChunk({
        day,
        time: localTimeKey(when),
        sessionShort,
        sessionTitle,
        text: asstHit.text,
        needsHeader: !exists,
        header: config.header,
      });

  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.appendFileSync(file, chunk, 'utf8');
  for (const key of dedupeKeys) state.seen.add(key);
  return true;
}

/**
 * 把"会话短号 → 标题"写进一份索引文件，方便回头查某个短号是哪个对话。
 * 只在该会话标题真的变了的时候追加，重复的不写。
 *
 * @param {{ dir: string, fullId: string, short: string, title: string, state: object, fsImpl?: typeof fs }} input
 * @returns {boolean} 是否写了一条新索引
 */
export function recordTitle(input) {
  const { dir, fullId, short, title, state } = input;
  const fsImpl = input.fsImpl ?? fs;
  if (fullId.length === 0 || title.length === 0) return false;
  if (!(state.titles instanceof Map)) state.titles = new Map();
  if (state.titles.get(fullId) === title) return false;

  state.titles.set(fullId, title);
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '_会话索引.md');
    const needsHeader = !fsImpl.existsSync(file);
    let chunk = '';
    if (needsHeader) chunk += '# 会话索引\n\n> 会话短号 = 标题，用来认「这句话是哪个对话里说的」。\n\n';
    chunk += `- ${short} = ${title}\n`;
    fsImpl.appendFileSync(file, chunk, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成「你在哪个会话」那一段提示词。抽成纯函数是为了能离线测试。
 *
 * @param {{ session: unknown, titles: Map<string, string> }} input
 * @returns {string} 空串 = 还没有可用的会话信息
 */
export function sessionNote(input) {
  const base = input !== null && typeof input === 'object' ? input : {};
  const session = base.session ?? null;
  const short = shortSessionId(session);
  if (short.length === 0) return '';
  const title = resolveTitle({ titles: base.titles, indexTitles: base.indexTitles }, session);
  const named = title.length > 0 ? `「${title}」` : '（尚未命名）';
  return [
    `【当前会话】你在会话${named}（短号 ${short}）里。这是你此刻所属的唯一一个对话，别处的话不属于这里。`,
    '这条只给你自己对齐上下文用：除非对方明确问起，不要在回复里复述它。',
    '如果这条和你眼前的对话对不上（比如你明明记得刚才在聊别的事），以上下文为准，不要照它改口。',
  ].join('\n');
}

/**
 * Cordis 入口。
 *
 * @param {object} ctx - cordis 上下文
 * @param {object} [config] - 插件配置
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) };
  if (cfg.enabled === false) {
    ctx.logger?.info?.('[original-words] disabled by config, not recording');
    return;
  }

  // ── v1：外置配置 ──────────────────────────────────────────────
  // 文件存在 → 白名单 + 按会话分目录；不存在 → 完全保持旧行为（全记、扁平）。
  // 「存在即切换」是刻意的：界面还没上线时，存档一秒都不能断。
  const cfgFile = cfgMod.configPath();
  const live = { on: false, mtimeMs: -1, config: null };
  const refreshLive = () => {
    try {
      const st = fs.statSync(cfgFile);
      if (live.on && st.mtimeMs === live.mtimeMs) return live;
      const loaded = cfgMod.loadConfig(cfgFile);
      live.on = true;
      live.mtimeMs = st.mtimeMs;
      live.config = loaded.config;
      if (loaded.error) ctx.logger?.warn?.(`[original-words] ${loaded.error}`);
      return live;
    } catch {
      // 文件不在 / 读不到 = 回到旧行为，不报错
      live.on = false;
      live.config = null;
      return live;
    }
  };
  refreshLive();

  // 设置页 + 转移的所有接口。webServer 由 inject 保证在场；万一没有就跳过，
  // 存档本身不依赖它，不能因为界面挂了就不记录。
  if (ctx.webServer) {
    registerRoutes(ctx, {
      getLiveConfig: () => (live.on && live.config ? live.config : cfgMod.mergeConfig({})),
      // 保存后强制重读：mtime 在粗粒度文件系统上可能没变，缓存会骗人
      onConfigSaved: () => {
        live.mtimeMs = -1;
        refreshLive();
      },
      logger: ctx.logger,
    });
  }

  const state = { currentFile: '', seen: new Set(), titles: new Map(), indexTitles: new Map() };
  // 会话身份不用闭包变量存：每轮装配时从 AssembleContext.agent.session 现取。
  // （旧实现用「最近一次用户发言的会话」，多会话并行时会串，2026-10-23 修掉。）

  // _会话索引.md 的缓存：标题能跨重启活下来，全靠这一层。
  const indexCache = { mtimeMs: -1 };
  const refreshIndex = (dir) => {
    try {
      const file = path.join(dir, '_会话索引.md');
      const stat = fs.statSync(file);
      if (stat.mtimeMs === indexCache.mtimeMs) return;
      indexCache.mtimeMs = stat.mtimeMs;
      state.indexTitles = loadIndexTitles(file);
    } catch {
      /* 索引还没建，忽略 */
    }
  };

  ctx.on('session/event', (session, event) => {
    try {
      const L = refreshLive();
      const fullId = sessionIdOf(session);

      // 白名单模式：没勾选的会话一个字都不写（连标题索引也不记）
      if (L.on && !cfgMod.isSessionEnabled(L.config, fullId)) return;

      // 索引始终写在「根目录」——它是跨会话的对照表，不跟着会话走
      const rootDir = L.on
        ? L.config.rootDir.length > 0
          ? L.config.rootDir
          : cfgMod.defaultRootDir()
        : resolveOutDir(session, cfg.outDir);
      refreshIndex(rootDir);

      // 会话标题：由 LLM 在首轮之后生成，可能来两次（fallback + provider），后来的覆盖
      const title = titleOfEvent(event);
      if (title.length > 0) {
        recordTitle({
          dir: rootDir,
          fullId,
          short: shortSessionId(session),
          title,
          state,
        });
        refreshIndex(rootDir);
        return;
      }

      // 正文目录：白名单模式按会话分文件夹；否则空串 → handleEvent 走旧的 resolveOutDir
      const bodyDir = L.on ? cfgMod.dirForSession(L.config, fullId, resolveTitle(state, session)) : '';
      handleEvent({ session, event, state, config: cfg, dir: bodyDir });
    } catch (error) {
      // 绝不把会话拖崩：只记一行 warn。
      try {
        ctx.logger?.warn?.(`[original-words] skipped one event: ${error && error.message ? error.message : String(error)}`);
      } catch {
        /* 连日志都失败就彻底放弃，静默 */
      }
    }
  });

  // 每轮把「你在哪个会话」注入系统提示。
  // 会话取自本轮装配的 AssembleContext.agent（assembleContextFor 把 agent 塞进 context，
  // 且 scope === agent），多会话并行也不会串；拿不到时降级为空串，不注入错信息。
  if (cfg.announceSession !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'original-words:session',
          order: cfg.sectionOrder,
          text: (context) => {
            try {
              return sessionNote({
                session: context?.agent?.session ?? context?.scope ?? null,
                titles: state.titles,
                indexTitles: state.indexTitles,
              });
            } catch {
              return '';
            }
          },
        }),
      'dsh-original-words.session()',
    );
  }
}
