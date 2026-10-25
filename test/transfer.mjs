/**
 * 转移模块的离线测试。
 *
 * 全部在系统临时目录里跑，绝不碰真实原话目录。
 * 重点验证：**失败时源数据一根汗毛都不能少**。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { precheck, transferRoot } from '../lib/transfer.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error && error.message ? error.message : error}`);
  }
}

/** 造一棵有内容的源目录。 */
async function makeSource(root) {
  await fsp.mkdir(path.join(root, '示例会话'), { recursive: true });
  await fsp.mkdir(path.join(root, '项目讨论'), { recursive: true });
  await fsp.writeFile(path.join(root, '示例会话', '2026-10-25.md'), '# 示例会话\n第一句原话\n', 'utf8');
  await fsp.writeFile(path.join(root, '示例会话', '2026-10-26.md'), '# 示例会话\n第二句原话\n', 'utf8');
  await fsp.writeFile(path.join(root, '项目讨论', '2026-10-25.md'), '# 项目讨论\n随便一句话\n', 'utf8');
  await fsp.writeFile(path.join(root, '_会话索引.md'), 'ef567890=示例会话\n', 'utf8');
}

/** 递归读出目录下所有文件的内容（相对路径 → 内容）。 */
async function snapshot(dir) {
  const out = {};
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel.length > 0 ? path.join(dir, rel) : dir;
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel.length > 0 ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else out[childRel] = await fsp.readFile(path.join(dir, childRel), 'utf8');
    }
  }
  return out;
}

console.log('--- 预检 ---');

await test('目标非空时拒绝', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t1-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await makeSource(src);
  await fsp.mkdir(dst, { recursive: true });
  await fsp.writeFile(path.join(dst, '占了.txt'), 'x', 'utf8');
  const r = await precheck({ from: src, to: dst });
  assert.equal(r.ok, false);
  assert.match(r.error, /里有东西/);
  await fsp.rm(base, { recursive: true, force: true });
});

await test('目标是源目录本身时拒绝', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t2-'));
  const src = path.join(base, 'src');
  await makeSource(src);
  const r = await precheck({ from: src, to: src });
  assert.equal(r.ok, false);
  assert.match(r.error, /同一个目录/);
  await fsp.rm(base, { recursive: true, force: true });
});

await test('目标在源目录里面时拒绝（否则无限递归）', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t3-'));
  const src = path.join(base, 'src');
  await makeSource(src);
  const r = await precheck({ from: src, to: path.join(src, 'inner') });
  assert.equal(r.ok, false);
  assert.match(r.error, /不能放在源目录里面/);
  await fsp.rm(base, { recursive: true, force: true });
});

await test('源不存在时拒绝', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t4-'));
  const r = await precheck({ from: path.join(base, 'nope'), to: path.join(base, 'dst') });
  assert.equal(r.ok, false);
  assert.match(r.error, /源目录不存在/);
  await fsp.rm(base, { recursive: true, force: true });
});

await test('正常情况预检通过，报告文件数和字节数', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t5-'));
  const src = path.join(base, 'src');
  await makeSource(src);
  const r = await precheck({ from: src, to: path.join(base, 'dst') });
  assert.equal(r.ok, true);
  assert.equal(r.fileCount, 4);
  assert.ok(r.bytes > 0);
  await fsp.rm(base, { recursive: true, force: true });
});

console.log('--- 转移 ---');

await test('转移成功：新目录内容与旧目录逐字节一致', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t6-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await makeSource(src);
  const before = await snapshot(src);

  const r = await transferRoot({ from: src, to: dst });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.fileCount, 4);

  const after = await snapshot(dst);
  assert.deepEqual(after, before, '目标内容必须和源完全一致');

  await fsp.rm(base, { recursive: true, force: true });
});

await test('转移成功后旧目录还在（改名为 .old-*，没删）', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t7-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await makeSource(src);
  const before = await snapshot(src);

  const r = await transferRoot({ from: src, to: dst });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.backupPath.length > 0, '要报告旧目录改名后的路径');
  assert.equal(fs.existsSync(r.backupPath), true, '旧目录必须还在');
  assert.equal(fs.existsSync(src), false, '原路径应该已经腾出来');

  const kept = await snapshot(r.backupPath);
  assert.deepEqual(kept, before, '留底的旧目录内容必须完好');

  await fsp.rm(base, { recursive: true, force: true });
});

await test('转移时不会留下 .transfering- 临时目录', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t8-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await makeSource(src);
  const r = await transferRoot({ from: src, to: dst });
  assert.equal(r.ok, true, r.error);
  const leftovers = (await fsp.readdir(dst)).filter((n) => n.startsWith('.transfering-'));
  assert.deepEqual(leftovers, []);
  await fsp.rm(base, { recursive: true, force: true });
});

await test('转移会报告进度（copy → verify → backup → done）', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t9-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await makeSource(src);
  const phases = [];
  const r = await transferRoot({
    from: src,
    to: dst,
    onProgress: (p) => {
      if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
    },
  });
  assert.equal(r.ok, true, r.error);
  assert.ok(phases.includes('copy'), '要有 copy 阶段');
  assert.ok(phases.includes('verify'), '要有 verify 阶段');
  assert.ok(phases.includes('backup'), '要有 backup 阶段');
  assert.equal(phases[phases.length - 1], 'done');
  await fsp.rm(base, { recursive: true, force: true });
});

console.log('--- 失败时源数据必须完好 ---');

await test('目标被占：失败且源目录内容一字未变', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t10-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await makeSource(src);
  const before = await snapshot(src);
  await fsp.mkdir(dst, { recursive: true });
  await fsp.writeFile(path.join(dst, 'x.txt'), 'x', 'utf8');

  const r = await transferRoot({ from: src, to: dst });
  assert.equal(r.ok, false);
  const after = await snapshot(src);
  assert.deepEqual(after, before, '源目录不能有任何变化');
  await fsp.rm(base, { recursive: true, force: true });
});

await test('空目录也能转移（不报错）', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t11-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await fsp.mkdir(src, { recursive: true });
  const r = await transferRoot({ from: src, to: dst });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.fileCount, 0);
  assert.equal(fs.existsSync(dst), true);
  await fsp.rm(base, { recursive: true, force: true });
});

await test('多层嵌套目录结构完整保留', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-t12-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await fsp.mkdir(path.join(src, 'a', 'b', 'c'), { recursive: true });
  await fsp.writeFile(path.join(src, 'a', 'b', 'c', 'deep.md'), '深\n', 'utf8');
  const before = await snapshot(src);
  const r = await transferRoot({ from: src, to: dst });
  assert.equal(r.ok, true, r.error);
  const after = await snapshot(dst);
  assert.deepEqual(after, before);
  await fsp.rm(base, { recursive: true, force: true });
});

console.log('');
if (failed === 0) {
  console.log(`通过 ${passed} 项，失败 0 项`);
  console.log('ALL PASS');
} else {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exitCode = 1;
}
