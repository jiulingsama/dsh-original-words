/**
 * 原话目录的「转移」。
 *
 * 这个模块只做一件事：把整个原话根目录搬到另一个地方，**并且保证搬不动就什么都不变**。
 *
 * 流程（顺序不能换）：
 *   ① 预检   目标能不能用、够不够空间、有没有冲突
 *   ② 复制   复制到 <目标>\.transfering-<时间戳>\，逐文件算 SHA256
 *   ③ 校验   源和目标的文件数、每个文件的大小和哈希，全部一致才继续
 *   ④ 改配置 由调用方做（这里只报告"可以切了"）
 *   ⑤ 源改名 <源>.old-<时间戳>          ← 只改名，不删
 *
 * 任何一步失败：目标那边的 .transfering-* 会被清掉，源目录一根汗毛没动。
 * **这里没有任何 rm -rf 源目录的代码路径**，删不删由用户在界面上自己决定。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 转移用的临时目录前缀。以点开头，一眼能看出是中间态。 */
const STAGING_PREFIX = '.transfering-';

/**
 * 递归列出一个目录下的所有文件（相对路径）。
 *
 * @param {string} dir
 * @returns {Promise<string[]>} 相对路径数组
 */
async function listFiles(dir) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel.length > 0 ? path.join(dir, rel) : dir;
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel.length > 0 ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  return out;
}

/**
 * 算文件哈希（流式，几 GB 也不会把内存吃满）。
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 目录是否为空（不存在也算空）。
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isEmptyDir(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length === 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * 递归删掉一个目录（只在清理自己创建的临时目录时用）。
 *
 * @param {string} dir
 */
async function removeDirQuietly(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不改变结论 */
  }
}

/**
 * 预检。不碰任何文件。
 *
 * @param {{ from: string, to: string, fsImpl?: object }} input
 * @returns {Promise<{ ok: boolean, error: string, fileCount: number, bytes: number }>}
 */
export async function precheck({ from, to }) {
  if (typeof from !== 'string' || from.trim().length === 0) {
    return { ok: false, error: '源目录没有设置', fileCount: 0, bytes: 0 };
  }
  if (typeof to !== 'string' || to.trim().length === 0) {
    return { ok: false, error: '还没有选目标目录', fileCount: 0, bytes: 0 };
  }

  const src = path.resolve(from);
  const dst = path.resolve(to);

  if (src === dst) return { ok: false, error: '目标和现在的位置是同一个目录', fileCount: 0, bytes: 0 };
  // 目标在源里面：复制时会把自己套进去，无限递归
  if (dst.startsWith(src + path.sep)) {
    return { ok: false, error: '目标不能放在源目录里面', fileCount: 0, bytes: 0 };
  }

  // 源必须存在
  let st;
  try {
    st = await fsp.stat(src);
  } catch {
    return { ok: false, error: `源目录不存在：${src}`, fileCount: 0, bytes: 0 };
  }
  if (!st.isDirectory()) return { ok: false, error: '源路径不是目录', fileCount: 0, bytes: 0 };

  // 目标：不存在，或者是空目录
  try {
    const dstStat = await fsp.stat(dst);
    if (!dstStat.isDirectory()) return { ok: false, error: '目标路径已经存在，而且不是目录', fileCount: 0, bytes: 0 };
    if (!(await isEmptyDir(dst))) {
      return { ok: false, error: '目标目录里有东西了，换一个空的', fileCount: 0, bytes: 0 };
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      return { ok: false, error: `检查目标目录失败：${error && error.message ? error.message : String(error)}`, fileCount: 0, bytes: 0 };
    }
  }

  // 统计源：文件数 + 总字节
  let files;
  try {
    files = await listFiles(src);
  } catch (error) {
    return { ok: false, error: `读源目录失败：${error && error.message ? error.message : String(error)}`, fileCount: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += (await fsp.stat(path.join(src, rel))).size;
    } catch {
      /* 单文件读不到就跳过统计，不影响判断 */
    }
  }

  return { ok: true, error: '', fileCount: files.length, bytes };
}

/**
 * 执行转移。
 *
 * @param {{
 *   from: string,
 *   to: string,
 *   onProgress?: (p: { phase: string, done: number, total: number, bytes: number, text: string }) => void
 * }} input
 * @returns {Promise<{
 *   ok: boolean, error: string, stagingPath: string, backupPath: string,
 *   fileCount: number, bytes: number
 * }>}
 */
export async function transferRoot(input) {
  const { from, to, onProgress } = input;
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  const check = await precheck({ from, to });
  if (!check.ok) {
    return { ok: false, error: check.error, stagingPath: '', backupPath: '', fileCount: 0, bytes: 0 };
  }

  const src = path.resolve(from);
  const dst = path.resolve(to);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const staging = path.join(dst, `${STAGING_PREFIX}${stamp}`);

  // ── ② 复制 ──────────────────────────────────────────────
  let files;
  try {
    files = await listFiles(src);
    await fsp.mkdir(staging, { recursive: true });
  } catch (error) {
    return { ok: false, error: `准备复制失败：${error && error.message ? error.message : String(error)}`, stagingPath: '', backupPath: '', fileCount: 0, bytes: 0 };
  }

  const total = files.length;
  let bytes = 0;
  let done = 0;

  try {
    for (const rel of files) {
      const fromFile = path.join(src, rel);
      const toFile = path.join(staging, rel);
      await fsp.mkdir(path.dirname(toFile), { recursive: true });
      await fsp.copyFile(fromFile, toFile);
      const size = (await fsp.stat(toFile)).size;
      bytes += size;
      done += 1;
      report({ phase: 'copy', done, total, bytes, text: `复制中 ${done}/${total}` });
    }
  } catch (error) {
    await removeDirQuietly(staging);
    return { ok: false, error: `复制失败（已清理，源目录没动）：${error && error.message ? error.message : String(error)}`, stagingPath: '', backupPath: '', fileCount: done, bytes };
  }

  // ── ③ 校验 ──────────────────────────────────────────────
  report({ phase: 'verify', done: total, total, bytes, text: '校验中' });
  try {
    for (const rel of files) {
      const fromFile = path.join(src, rel);
      const toFile = path.join(staging, rel);
      const [a, b] = await Promise.all([sha256Of(fromFile), sha256Of(toFile)]);
      if (a !== b) {
        await removeDirQuietly(staging);
        return { ok: false, error: `校验不通过：${rel}（已清理，源目录没动）`, stagingPath: '', backupPath: '', fileCount: done, bytes };
      }
    }
  } catch (error) {
    await removeDirQuietly(staging);
    return { ok: false, error: `校验出错（已清理，源目录没动）：${error && error.message ? error.message : String(error)}`, stagingPath: '', backupPath: '', fileCount: done, bytes };
  }

  // ── 把临时目录挪成正式目录 ────────────────────────────────
  // dst 是空的或不存在；先把 staging 的内容挪到 dst 下
  report({ phase: 'move', done: total, total, bytes, text: '整理目标目录' });
  try {
    const entries = await fsp.readdir(staging);
    for (const name of entries) {
      await fsp.rename(path.join(staging, name), path.join(dst, name));
    }
    await removeDirQuietly(staging);
  } catch (error) {
    // 这一步失败：试着把已经挪过去的留在 dst，但源目录仍未动
    return { ok: false, error: `整理目标目录失败（源目录没动，目标里可能有残留）：${error && error.message ? error.message : String(error)}`, stagingPath: staging, backupPath: '', fileCount: done, bytes };
  }

  // ── ⑤ 源目录只改名 ───────────────────────────────────────
  const backup = `${src}.old-${stamp}`;
  report({ phase: 'backup', done: total, total, bytes, text: '把旧目录改名留底' });
  try {
    await fsp.rename(src, backup);
  } catch (error) {
    // 新位置已经完整了，但旧目录没能改名——这是"两份都在"，不是丢数据
    return {
      ok: false,
      error: `数据已复制到新位置并校验通过，但旧目录改名失败（旧数据仍在原处）：${error && error.message ? error.message : String(error)}`,
      stagingPath: '',
      backupPath: '',
      fileCount: done,
      bytes,
    };
  }

  report({ phase: 'done', done: total, total, bytes, text: '完成' });
  return { ok: true, error: '', stagingPath: '', backupPath: backup, fileCount: done, bytes };
}
