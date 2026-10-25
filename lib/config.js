/**
 * 配置读写：把原本写死在代码/patch 里的参数挪到一个 JSON 文件。
 *
 * 设计上的几个硬要求：
 * 1. **读坏了不能崩**。JSON 解析失败、字段类型不对，一律回落默认值，插件照常工作。
 * 2. **写不能写一半**。先写 .tmp 再 rename，断电/崩溃都不会留下半个配置。
 * 3. **文件夹名一旦定了就不跟着标题变**。会话改名是常事，一改文件夹就等于数据搬家。
 *
 * 目录结构：<rootDir>\<会话文件夹>\YYYY-MM-DD.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置结构版本。将来改结构时用来做迁移。 */
export const CONFIG_VERSION = 1;

/** 默认配置。 */
export const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  /** 总开关。关掉就什么都不写。 */
  enabled: true,
  /** 根目录；空串 = 自动推导（见 defaultRootDir）。 */
  rootDir: '',
  /**
   * 勾选的会话白名单。
   * 键是完整 session id，值是 { title, folder, enabled }。
   * 不在这个表里的会话 = 不记录。
   */
  sessions: {},
  /** 文件头那句话，写成空串可以关掉。 */
  header: '> 由 dsh-original-words 自动记录，只收你本人发出的消息，逐字不删改。',
  /** 是否把我这边的思考过程也存进去。 */
  saveReasoning: true,
  /** 是否每轮往系统提示里注入"你在哪个会话"。 */
  announceSession: true,
  /** 注入段的排序：dsh-clock 是 850、dsh-mood 是 860，夹在中间。 */
  sectionOrder: 855,
});

/** Windows 文件名里不允许出现的字符。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 文件夹名的最大长度（给路径总长留余量）。 */
const MAX_FOLDER_LEN = 60;

/**
 * 配置文件的默认位置。
 *
 * @returns {string}
 */
export function configPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'original-words-config.json');
}

/**
 * 推导根目录（配置里 rootDir 为空时用）。
 *
 * @returns {string}
 */
export function defaultRootDir() {
  // ⚠ 必须和 index.js 的 resolveOutDir 算出**同一个**目录。
  // 切到分目录之后，新文件要落在历史数据旁边，而不是另起一个「原话」文件夹、
  // 让用户以为历史丢了——2026-10-25 第一次重启时就是这么错的（少写了一层目录）。
  const ws = process.env.DSH_WORKSPACE;
  if (typeof ws === 'string' && ws.trim().length > 0) return path.join(ws.trim(), '原话');
  return path.join(os.homedir(), 'Documents', 'dsh', '原话');
}

/**
 * 把会话标题洗成能当文件夹名的样子。
 *
 * 做的处理：替换非法字符、压掉连续空白、去掉首尾的点和空格、截断长度。
 * 洗完是空串的话返回空串，调用方自己决定怎么兜底。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeFolderName(raw) {
  if (typeof raw !== 'string') return '';
  let name = raw.replace(ILLEGAL_CHARS, '-').replace(/\s+/g, ' ').trim();
  // Windows 不允许文件夹名以点结尾
  name = name.replace(/^\.+/, '').replace(/\.+$/, '').trim();
  if (name.length > MAX_FOLDER_LEN) name = name.slice(0, MAX_FOLDER_LEN).trim();
  return name;
}

/**
 * 从完整 session id 里取短号（跟 index.js 里的 shortSessionId 保持同一口径）。
 *
 * @param {string} fullId
 * @returns {string}
 */
export function shortIdOf(fullId) {
  if (typeof fullId !== 'string') return '';
  return fullId.replace(/^session-/, '').slice(0, 8);
}

/**
 * 给某个会话分配文件夹名。
 *
 * 规则：
 * - 已经分配过 → 原样返回（不跟着标题变，避免数据搬家）
 * - 没分配过 → 用清洗后的标题；如果这个名字已经被别的**已勾选**会话占了，就加短号区分
 * - 标题为空 → 用短号
 *
 * @param {object} cfg - 已加载的配置
 * @param {string} fullId - 完整 session id
 * @param {string} title - 会话标题
 * @returns {string} 文件夹名（保证非空）
 */
export function folderForSession(cfg, fullId, title) {
  const sessions = cfg && typeof cfg.sessions === 'object' && cfg.sessions !== null ? cfg.sessions : {};
  const existing = sessions[fullId];
  if (existing && typeof existing.folder === 'string' && existing.folder.length > 0) return existing.folder;

  const short = shortIdOf(fullId);
  const base = sanitizeFolderName(title) || short || 'unnamed';

  // 已被别的已勾选会话占用的名字
  const taken = new Set();
  for (const [id, entry] of Object.entries(sessions)) {
    if (id === fullId) continue;
    if (!entry || entry.enabled !== true) continue;
    if (typeof entry.folder === 'string' && entry.folder.length > 0) taken.add(entry.folder);
  }

  if (!taken.has(base)) return base;

  // 撞名了：加短号；短号也撞（理论上不可能）就再后缀一个数字
  let candidate = short ? `${base}（${short}）` : `${base}（2）`;
  if (taken.has(candidate) && short) candidate = `${base}（${short}-2）`;
  let n = 3;
  while (taken.has(candidate)) {
    candidate = short ? `${base}（${short}-${n}）` : `${base}（${n}）`;
    n += 1;
    if (n > 99) break;
  }
  return candidate;
}

/**
 * 把用户传入的配置合并到默认值上。
 *
 * 只认自己认识的字段，只接受类型对的值——一个写错的字段不该污染整份配置。
 *
 * @param {unknown} raw
 * @returns {object}
 */
export function mergeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cfg = { ...DEFAULTS, sessions: {} };

  if (typeof source.enabled === 'boolean') cfg.enabled = source.enabled;
  if (typeof source.rootDir === 'string') cfg.rootDir = source.rootDir.trim();
  if (typeof source.header === 'string') cfg.header = source.header;
  if (typeof source.saveReasoning === 'boolean') cfg.saveReasoning = source.saveReasoning;
  if (typeof source.announceSession === 'boolean') cfg.announceSession = source.announceSession;
  if (Number.isFinite(source.sectionOrder)) cfg.sectionOrder = source.sectionOrder;

  if (source.sessions !== null && typeof source.sessions === 'object' && !Array.isArray(source.sessions)) {
    for (const [id, entry] of Object.entries(source.sessions)) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (entry === null || typeof entry !== 'object') continue;
      const out = {
        title: typeof entry.title === 'string' ? entry.title : '',
        folder: typeof entry.folder === 'string' ? sanitizeFolderName(entry.folder) : '',
        enabled: entry.enabled === true,
      };
      if (out.folder.length === 0) out.folder = sanitizeFolderName(out.title) || shortIdOf(id) || 'unnamed';
      cfg.sessions[id] = out;
    }
  }

  if (Number.isFinite(source.version)) cfg.version = source.version;
  return cfg;
}

/**
 * 读配置。文件不存在返回默认值；文件坏了也返回默认值（并留下错误信息）。
 *
 * @param {string} [file] - 配置文件路径，默认 configPath()
 * @returns {{ config: object, error: string }}
 */
export function loadConfig(file = configPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // 不存在是正常的（第一次用）
    return { config: mergeConfig({}), error: '' };
  }
  try {
    return { config: mergeConfig(JSON.parse(text)), error: '' };
  } catch (error) {
    return {
      config: mergeConfig({}),
      error: `配置文件不是合法 JSON，已按默认值启动：${error && error.message ? error.message : String(error)}`,
    };
  }
}

/**
 * 写配置。先写 .tmp 再 rename，保证不会留下半个文件。
 *
 * @param {object} cfg
 * @param {string} [file]
 * @returns {{ ok: boolean, error: string }}
 */
export function saveConfig(cfg, file = configPath()) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, error: '' };
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败就算了 */
    }
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * 算某个会话该写到哪个目录。
 *
 * @param {object} cfg
 * @param {string} fullId
 * @param {string} title
 * @returns {string} 绝对路径
 */
export function dirForSession(cfg, fullId, title) {
  const root = typeof cfg.rootDir === 'string' && cfg.rootDir.length > 0 ? cfg.rootDir : defaultRootDir();
  return path.join(root, folderForSession(cfg, fullId, title));
}

/**
 * 这个会话要不要记。
 *
 * @param {object} cfg
 * @param {string} fullId
 * @returns {boolean}
 */
export function isSessionEnabled(cfg, fullId) {
  if (!cfg || cfg.enabled === false) return false;
  const entry = cfg.sessions && cfg.sessions[fullId];
  return !!(entry && entry.enabled === true);
}
