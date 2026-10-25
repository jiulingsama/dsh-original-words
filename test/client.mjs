/**
 * 设置页（client.js）的结构测试。
 *
 * 不用浏览器，也不挂 DSH：造一个假的 window.__ModuleLoader__，把 client.js 真的执行一遍，
 * 看它有没有正确注册到 settings.section、组件能不能渲染出东西。
 *
 * 这能在重启之前就发现「设置页不出现」这一类问题（声明写错、factory 返回错、slots 用法错），
 * 唯一的盲区是浏览器运行时本身。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error && error.message ? error.message : error}`);
  }
}

// ── 1. 造一个假的模块加载器，把 client.js 跑一遍 ─────────────
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec;
    },
  },
};

await import('../lib/client.js');

test('client.js 调用了 __ModuleLoader__.load，id 是包名', () => {
  assert.ok(loaded, '应该调用 window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-original-words');
  assert.equal(typeof loaded.factory, 'function');
});

// ── 2. 假 React：够 client.js 的 hooks 用 ────────────────────
function makeMockReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(),
  });
  return {
    createElement,
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
  };
}

const mockReact = makeMockReact();
const mod = loaded.factory((name) => {
  if (name === 'react') return mockReact;
  throw new Error(`client.js 要求了一个没声明 external 的模块：${name}`);
});

test('factory 返回 apply 和 inject', () => {
  assert.equal(typeof mod.apply, 'function', '要导出 apply');
  assert.deepEqual(mod.inject, ['slots'], 'inject 只能是 slots');
});

// ── 3. 假 ctx：验 slots 注册的参数 ──────────────────────────
let registered = null;
const slots = {
  inject(slotName, fn) {
    assert.equal(slotName, 'settings.section');
    fn();
  },
  register(meta, component) {
    registered = { meta, component };
    return () => {};
  },
};
const ctx = {
  get(name) {
    return name === 'slots' ? slots : undefined;
  },
};

mod.apply(ctx);

test('注册到 settings.section，id 和按钮文字都对', () => {
  assert.ok(registered, '应该调用了 slots.register');
  assert.equal(registered.meta.name, 'settings.section');
  assert.equal(registered.meta.id, 'original-words');
  assert.equal(typeof registered.meta.order, 'number');
  assert.equal(registered.meta.label(), '原话存档');
  assert.equal(typeof registered.component, 'function');
});

test('slots 服务不在时不抛错（只是不注册）', () => {
  const throwaway = { get: () => undefined };
  mod.apply(throwaway); // 不抛就算过
});

// ── 4. 组件能渲染 ──────────────────────────────────────────
test('组件首次渲染不抛错，且返回一个元素', () => {
  const tree = registered.component();
  assert.ok(tree, '应该有返回值');
  assert.equal(typeof tree.type, 'string', '根节点应该是普通 DOM 标签');
  assert.ok(['div', 'section'].includes(tree.type));
});

test('首屏是"读取中"，不会在数据没到时崩', () => {
  const tree = registered.component();
  // 首屏结构：div > span(读取中…)
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes('读取中'), 'state 为空时应该显示读取中：' + flat.slice(0, 200));
});

// ── 5. 包里的声明要和 client.js 对得上 ─────────────────────
test('package.json 的 dsh.client 声明完整（platform / inject / external）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

  const client = pkg.dsh && pkg.dsh.client;
  assert.ok(client, 'package.json 里要有 dsh.client');
  assert.equal(client.platform, 'web');
  assert.deepEqual(client.inject, ['slots']);
  // 这一条是 2026-10-25 补的：漏了它客户端加载器找不到 react，设置页整个不出现
  assert.deepEqual(client.external, ['react'], '必须声明 external:["react"]');

  assert.ok(pkg.exports && pkg.exports['./client'], '要导出 ./client');
  assert.equal(pkg.exports['./client'], './lib/client.js');
});

test('所有 hook 都排在 if (!state) return 之前（否则设置页整块空白）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
  const lines = src.split('\n');

  // 首屏还没数据时会走这条早退；排在它后面的 hook 再也不会被调用
  // 只认真正的代码行：注释里提到 "if (!state)" 不算数（这个文件里恰好有一条在解释这个坑）
  const guardIdx = lines.findIndex((l) => /^\s*if\s*\(\s*!state\s*\)/.test(l));
  assert.ok(guardIdx >= 0, '应该能找到 if (!state) 这个早退守卫');

  const hookLines = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return; // 跳过注释
    if (/React\.use[A-Z]/.test(line)) hookLines.push(i);
  });
  assert.ok(hookLines.length >= 3, `至少要认出 3 个 hook，实际 ${hookLines.length} 个`);

  for (const i of hookLines) {
    assert.ok(
      i < guardIdx,
      `第 ${i + 1} 行的 hook 排在 if (!state) 之后（第 ${guardIdx + 1} 行）。` +
        '首屏只跑部分 hook、数据到了再跑全部，React 会整块崩掉——2026-10-25 就是这么白屏的。',
    );
  }
});

console.log('');
if (failed === 0) {
  console.log(`通过 ${passed} 项，失败 0 项`);
  console.log('ALL PASS');
} else {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exitCode = 1;
}
