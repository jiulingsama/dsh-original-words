/**
 * 接线测试：真的调 apply()，真的触发 session/event，看文件落在哪。
 *
 * 这是唯一能证明「白名单 + 分目录 + 存在即切换」真的生效的测试——
 * 纯函数测试证明不了一套接线。
 *
 * 每个用例用独立的临时 DSH_HOME / DSH_WORKSPACE，绝不碰真实数据。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** 造一条"用户本人发的消息"。 */
function userEvent(text, rpcId, time = Date.UTC(2026, 9, 21, 2, 51, 3)) {
  return {
    type: 'user/message',
    seq: 1,
    time,
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId, clientTimeZone: 'Etc/GMT-8' },
    },
  };
}

/**
 * 造一个够用的假 ctx，返回 { ctx, fire }。
 * fire(session, event) 就是触发一次 session/event。
 */
function makeCtx() {
  const handlers = {};
  const ctx = {
    on(name, fn) {
      handlers[name] = fn;
    },
    get() {
      return undefined;
    },
    effect(fn) {
      // 真 ctx 会执行并登记清理函数；这里执行就够了
      try {
        return fn();
      } catch {
        return undefined;
      }
    },
    // 设置页路由用不到，给个空实现，避免 apply 里 if (ctx.webServer) 走进去
    webServer: undefined,
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    logger: { warn() {}, info() {} },
    agents: { list: () => [] },
  };
  return {
    ctx,
    fire(session, event) {
      const fn = handlers['session/event'];
      assert.ok(typeof fn === 'function', 'session/event 没有被注册');
      fn(session, event);
    },
  };
}

/**
 * 在一个全新的临时环境里跑一段。
 *
 * @param {(env: { home: string, ws: string, fire: Function, apply: Function }) => void} body
 */
function inFreshEnv(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-route-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });

  const oldHome = process.env.DSH_HOME;
  const oldWs = process.env.DSH_WORKSPACE;
  process.env.DSH_HOME = home;
  process.env.DSH_WORKSPACE = ws;

  try {
    body({ root, home, ws });
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    if (oldWs === undefined) delete process.env.DSH_WORKSPACE;
    else process.env.DSH_WORKSPACE = oldWs;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 动态 import，保证每次拿到的是同一个模块实例（ESM 缓存）。 */
const { apply } = await import('../lib/index.js');

/** 读某个文件，不存在返回空串。 */
function readIf(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** 写配置（模拟用户在设置页点了保存）。 */
function writeConfig(home, config) {
  fs.writeFileSync(path.join(home, 'original-words-config.json'), JSON.stringify(config, null, 2), 'utf8');
}

console.log('--- 没有配置文件时：保持旧行为 ---');

test('没有配置文件 → 写到工作区下的 原话/日期.md（扁平）', () => {
  inFreshEnv(({ home, ws }) => {
    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    fire({ id: 'session-aaa11111-x' }, userEvent('你好', 'r1'));

    const flat = path.join(ws, '原话', '2026-10-21.md');
    const text = readIf(flat);
    assert.ok(text.includes('你好'), '应该写进扁平目录：' + flat);
    // 确认没有任何会话文件夹被创建
    assert.equal(fs.existsSync(path.join(ws, '原话', 'aaa11111')), false);
  });
});

test('没有配置文件 → 多个会话写进同一个文件', () => {
  inFreshEnv(({ ws }) => {
    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    fire({ id: 'session-aaa11111-x' }, userEvent('会话 A 的话', 'r1'));
    fire({ id: 'session-bbb22222-y' }, userEvent('会话 B 的话', 'r2'));

    const text = readIf(path.join(ws, '原话', '2026-10-21.md'));
    assert.ok(text.includes('会话 A 的话'));
    assert.ok(text.includes('会话 B 的话'));
  });
});

console.log('--- 有配置文件时：白名单 + 分目录 ---');

test('勾选的会话 → 写进 根目录/会话名/日期.md', () => {
  inFreshEnv(({ root, home, ws }) => {
    const myRoot = path.join(root, '原话');
    writeConfig(home, {
      enabled: true,
      rootDir: myRoot,
      sessions: { 'session-aaa11111-x': { title: '示例会话', folder: '示例会话', enabled: true } },
    });

    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    fire({ id: 'session-aaa11111-x' }, userEvent('只记这句', 'r1'));

    const text = readIf(path.join(myRoot, '示例会话', '2026-10-21.md'));
    assert.ok(text.includes('只记这句'), '应该写进会话文件夹');

    // 扁平目录不该再被写
    const flat = path.join(ws, '原话', '2026-10-21.md');
    assert.equal(fs.existsSync(flat), false, '切换到白名单后不该再写扁平目录');
  });
});

test('没勾选的会话 → 一个字都不写', () => {
  inFreshEnv(({ root, home }) => {
    const myRoot = path.join(root, '原话');
    writeConfig(home, {
      enabled: true,
      rootDir: myRoot,
      sessions: { 'session-aaa11111-x': { title: '示例会话', folder: '示例会话', enabled: true } },
    });

    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    fire({ id: 'session-ccc33333-z' }, userEvent('不该被记下来', 'r9'));

    // 根目录下只应该有可能被建的会话文件夹，不该有 ccc 的
    const exists = fs.existsSync(myRoot);
    if (exists) {
      const dirs = fs.readdirSync(myRoot);
      for (const name of dirs) {
        const p = path.join(myRoot, name);
        if (fs.statSync(p).isDirectory()) {
          const files = fs.readdirSync(p);
          assert.equal(files.length, 0, `不该给没勾选的会话建文件夹：${name} 里有 ${files.join(',')}`);
        }
      }
    }
    // 全局断言：任何地方都搜不到那句话
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (readIf(full).includes('不该被记下来')) hits.push(full);
      }
    };
    if (fs.existsSync(myRoot)) walk(myRoot);
    assert.deepEqual(hits, [], '未勾选会话的内容不能出现在任何文件里');
  });
});

test('两个勾选的会话 → 两个独立文件夹，内容互不相混', () => {
  inFreshEnv(({ root, home }) => {
    const myRoot = path.join(root, '原话');
    writeConfig(home, {
      enabled: true,
      rootDir: myRoot,
      sessions: {
        'session-aaa11111-x': { title: '示例会话', folder: '示例会话', enabled: true },
        'session-bbb22222-y': { title: '项目讨论', folder: '项目讨论', enabled: true },
      },
    });

    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    fire({ id: 'session-aaa11111-x' }, userEvent('示例会话说的', 'r1'));
    fire({ id: 'session-bbb22222-y' }, userEvent('项目说的', 'r2'));

    const a = readIf(path.join(myRoot, '示例会话', '2026-10-21.md'));
    const b = readIf(path.join(myRoot, '项目讨论', '2026-10-21.md'));
    assert.ok(a.includes('示例会话说的'), '示例会话文件夹里要有自己的话');
    assert.equal(a.includes('项目说的'), false, '示例会话文件夹里不能有别人的话');
    assert.ok(b.includes('项目说的'));
    assert.equal(b.includes('示例会话说的'), false);
  });
});

test('来回切会话时，去重不会互相顶掉（同一条不会写两遍）', () => {
  inFreshEnv(({ root, home }) => {
    const myRoot = path.join(root, '原话');
    writeConfig(home, {
      enabled: true,
      rootDir: myRoot,
      sessions: {
        'session-aaa11111-x': { title: 'A', folder: 'A', enabled: true },
        'session-bbb22222-y': { title: 'B', folder: 'B', enabled: true },
      },
    });

    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    const evA = userEvent('A 的第一句', 'ra1');
    const evB = userEvent('B 的第一句', 'rb1');

    fire({ id: 'session-aaa11111-x' }, evA);
    fire({ id: 'session-bbb22222-y' }, evB);
    // 再来一遍同样的两条（rpcId 相同）
    fire({ id: 'session-aaa11111-x' }, evA);
    fire({ id: 'session-bbb22222-y' }, evB);

    const a = readIf(path.join(myRoot, 'A', '2026-10-21.md'));
    const b = readIf(path.join(myRoot, 'B', '2026-10-21.md'));
    const count = (s, needle) => s.split(needle).length - 1;
    assert.equal(count(a, 'A 的第一句'), 1, 'A 的话只应该出现一次');
    assert.equal(count(b, 'B 的第一句'), 1, 'B 的话只应该出现一次');
  });
});

test('总开关关掉时，即使勾选了也不写', () => {
  inFreshEnv(({ root, home }) => {
    const myRoot = path.join(root, '原话');
    writeConfig(home, {
      enabled: false,
      rootDir: myRoot,
      sessions: { 'session-aaa11111-x': { title: '示例会话', folder: '示例会话', enabled: true } },
    });

    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    fire({ id: 'session-aaa11111-x' }, userEvent('不该出现', 'r1'));

    const p = path.join(myRoot, '示例会话', '2026-10-21.md');
    assert.equal(fs.existsSync(p), false, '总开关关着不该产生文件');
  });
});

console.log('--- 事后改配置：存在即切换 ---');

test('一开始没配置（扁平写），后来写了配置 → 后续走分目录', () => {
  inFreshEnv(({ root, home, ws }) => {
    const { ctx, fire } = makeCtx();
    apply(ctx, {});

    // 阶段一：没有配置，扁平
    fire({ id: 'session-aaa11111-x' }, userEvent('配置前的话', 'r1'));
    assert.ok(readIf(path.join(ws, '原话', '2026-10-21.md')).includes('配置前的话'));

    // 阶段二：用户去设置页勾了，配置文件出现
    const myRoot = path.join(root, '原话');
    writeConfig(home, {
      enabled: true,
      rootDir: myRoot,
      sessions: { 'session-aaa11111-x': { title: '示例会话', folder: '示例会话', enabled: true } },
    });
    // 把 mtime 往前拨一点，模拟真实的时间流逝（避免同毫秒被缓存挡住）
    const cf = path.join(home, 'original-words-config.json');
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(cf, later, later);

    fire({ id: 'session-aaa11111-x' }, userEvent('配置后的话', 'r2'));

    assert.ok(
      readIf(path.join(myRoot, '示例会话', '2026-10-21.md')).includes('配置后的话'),
      '配置文件出现后应该立刻切到分目录',
    );
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
