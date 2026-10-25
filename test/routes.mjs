/**
 * HTTP 接口的离线测试。
 *
 * 用一个假的 ctx + 假的 req/res，把五个路由真的调一遍——
 * 不挂 DSH 也能验出「参数校验、配置落盘、转移全流程」对不对。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerRoutes } from '../lib/routes.js';

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error && error.message ? error.message : error}`);
  }
}

/** 一个假的 res，只留 writeHead / end。 */
function mockRes() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers || {};
    },
    end(chunk) {
      out.body = chunk === undefined ? '' : String(chunk);
    },
    get result() {
      let json = null;
      try {
        json = JSON.parse(out.body);
      } catch {
        json = null;
      }
      return { status: out.status, json, raw: out.body };
    },
  };
}

/** 一个假的 req：可选带 JSON 体。 */
function mockReq(body, url = '/') {
  const emitter = new EventEmitter();
  emitter.url = url;
  setImmediate(() => {
    if (body !== undefined) emitter.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    emitter.emit('end');
  });
  return emitter;
}

/**
 * 建一个假 ctx，注册好路由，返回 { call }。
 * call(path, body?, url?) 会找到对应 handler 并执行。
 */
function setup(config) {
  const table = new Map();
  const ctx = {
    get() {
      return undefined;
    },
    effect(fn) {
      const out = fn();
      return typeof out === 'function' ? out : () => {};
    },
    webServer: {
      register(spec) {
        table.set(spec.path, spec.handler);
        return () => {};
      },
    },
    agents: { list: () => [] },
    logger: { warn() {}, info() {} },
  };

  let live = config || null;
  registerRoutes(ctx, {
    getLiveConfig: () => live,
    onConfigSaved: (next) => {
      live = next;
    },
  });

  return {
    paths: [...table.keys()].sort(),
    async call(p, body, url) {
      const handler = table.get(p);
      assert.ok(typeof handler === 'function', `路由没注册：${p}`);
      const res = mockRes();
      await handler(mockReq(body, url || p), res);
      return res.result;
    },
  };
}

/** 在一个临时 DSH_HOME 里跑。 */
async function inTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-routes-'));
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('--- 路由注册 ---');

await test('五个接口都挂上了', async () => {
  await inTempEnv(async () => {
    const s = setup(null);
    assert.deepEqual(s.paths, [
      '/original-words/config',
      '/original-words/state',
      '/original-words/transfer',
      '/original-words/transfer/precheck',
      '/original-words/transfer/status',
    ]);
  });
});

console.log('--- GET /state ---');

await test('/state 在没有配置文件时，报告 configExists=false', async () => {
  await inTempEnv(async () => {
    const s = setup(null);
    const r = await s.call('/original-words/state');
    assert.equal(r.json.ok, true);
    assert.equal(r.json.configExists, false);
    assert.deepEqual(r.json.sessions, []);
    assert.ok(typeof r.json.rootDir === 'string' && r.json.rootDir.length > 0, '要有默认根目录');
  });
});

await test('/state 带着配置文件时，configExists=true 且回显设置', async () => {
  await inTempEnv(async (home) => {
    const cfg = { enabled: true, saveReasoning: false, rootDir: path.join(home, '原话'), sessions: {} };
    fs.writeFileSync(path.join(home, 'original-words-config.json'), JSON.stringify(cfg), 'utf8');
    const s = setup(cfg);
    const r = await s.call('/original-words/state');
    assert.equal(r.json.configExists, true);
    assert.equal(r.json.saveReasoning, false);
    assert.equal(r.json.rootDir, path.join(home, '原话'));
  });
});

console.log('--- POST /config ---');

await test('保存开关：落盘并能读回来', async () => {
  await inTempEnv(async (home) => {
    const s = setup({ enabled: true, saveReasoning: true, rootDir: '', sessions: {} });
    const r = await s.call('/original-words/config', { enabled: false, saveReasoning: false });
    assert.equal(r.json.ok, true, r.json.error);

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'original-words-config.json'), 'utf8'));
    assert.equal(onDisk.enabled, false);
    assert.equal(onDisk.saveReasoning, false);
  });
});

await test('勾选一个未知会话：会被记录并分配文件夹', async () => {
  await inTempEnv(async (home) => {
    const s = setup({ enabled: true, saveReasoning: true, rootDir: '', sessions: {} });
    const r = await s.call('/original-words/config', {
      sessions: [{ id: 'session-aaa11111-x', title: '示例会话', enabled: true }],
    });
    assert.equal(r.json.ok, true, r.json.error);

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'original-words-config.json'), 'utf8'));
    assert.ok(onDisk.sessions['session-aaa11111-x'], '应该记进 sessions');
    assert.equal(onDisk.sessions['session-aaa11111-x'].enabled, true);
    assert.equal(onDisk.sessions['session-aaa11111-x'].folder, '示例会话', '文件夹名应该用标题');
  });
});

await test('取消勾选：从 sessions 里删掉', async () => {
  await inTempEnv(async (home) => {
    const s = setup({
      enabled: true,
      saveReasoning: true,
      rootDir: '',
      sessions: { 'session-aaa11111-x': { title: '示例会话', folder: '示例会话', enabled: true } },
    });
    const r = await s.call('/original-words/config', {
      sessions: [{ id: 'session-aaa11111-x', title: '示例会话', enabled: false }],
    });
    assert.equal(r.json.ok, true, r.json.error);
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'original-words-config.json'), 'utf8'));
    assert.equal(onDisk.sessions['session-aaa11111-x'], undefined, '取消勾选应该删掉这条');
  });
});

console.log('--- POST /transfer/precheck ---');

await test('没填目标：拒绝，说清楚原因', async () => {
  await inTempEnv(async () => {
    const s = setup(null);
    const r = await s.call('/original-words/transfer/precheck', { to: '' });
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /目标目录/);
  });
});

await test('目标是源目录本身：拒绝', async () => {
  await inTempEnv(async (home) => {
    const src = path.join(home, '原话');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.md'), 'x', 'utf8');
    const s = setup({ enabled: true, saveReasoning: true, rootDir: src, sessions: {} });
    const r = await s.call('/original-words/transfer/precheck', { to: src });
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /同一个目录/);
  });
});

await test('合法目标：报告文件数和字节数', async () => {
  await inTempEnv(async (home) => {
    const src = path.join(home, '原话');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.md'), 'hello', 'utf8');
    fs.writeFileSync(path.join(src, 'b.md'), 'world', 'utf8');
    const s = setup({ enabled: true, saveReasoning: true, rootDir: src, sessions: {} });
    const r = await s.call('/original-words/transfer/precheck', { to: path.join(home, '新地方') });
    assert.equal(r.json.ok, true, r.json.error);
    assert.equal(r.json.fileCount, 2);
    assert.equal(r.json.bytes, 10);
  });
});

console.log('--- POST /transfer + 轮询 ---');

await test('转移全流程：起任务 → 轮询到完成 → 配置指向新位置', async () => {
  await inTempEnv(async (home) => {
    const src = path.join(home, '原话');
    const dst = path.join(home, '新地方');
    fs.mkdirSync(path.join(src, '示例会话'), { recursive: true });
    fs.writeFileSync(path.join(src, '示例会话', '2026-10-25.md'), '原话内容', 'utf8');

    const s = setup({ enabled: true, saveReasoning: true, rootDir: src, sessions: {} });

    const start = await s.call('/original-words/transfer', { to: dst });
    assert.equal(start.json.ok, true, start.json.error);
    assert.ok(start.json.jobId, '要返回 jobId');

    // 轮询直到 finished（最多等 5 秒）
    let job = null;
    for (let i = 0; i < 50; i += 1) {
      const p = await s.call(
        '/original-words/transfer/status',
        undefined,
        '/original-words/transfer/status?jobId=' + encodeURIComponent(start.json.jobId),
      );
      assert.equal(p.json.ok, true, p.json.error);
      job = p.json.job;
      if (job.finished) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(job && job.finished, '任务应该在 5 秒内完成');
    assert.equal(job.ok, true, job.error);

    // 数据真的到了新位置
    assert.equal(fs.readFileSync(path.join(dst, '示例会话', '2026-10-25.md'), 'utf8'), '原话内容');
    // 旧目录改名留底，没被删
    assert.equal(fs.existsSync(src), false, '原路径应该腾出来');
    const olds = fs.readdirSync(home).filter((n) => n.startsWith('原话.old-'));
    assert.equal(olds.length, 1, '应该有一个 .old- 留底目录');

    // 配置里的 rootDir 已经切到新位置
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'original-words-config.json'), 'utf8'));
    assert.equal(onDisk.rootDir, dst);
  });
});

await test('查一个不存在的 jobId：返回 ok=false，不抛错', async () => {
  await inTempEnv(async () => {
    const s = setup(null);
    const r = await s.call('/original-words/transfer/status', undefined, '/original-words/transfer/status?jobId=nope');
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /找不到/);
  });
});

console.log('');
if (failed === 0) {
  console.log(`通过 ${passed} 项，失败 0 项`);
  console.log('ALL PASS');
} else {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exitCode = 1;
}
