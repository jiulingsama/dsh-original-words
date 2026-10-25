// 临时验证 lib/config.js 的核心逻辑。跑完可以删。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const M = await import('file:///C:/Users/hp/Documents/dsh/plugins/dsh-original-words/lib/config.js');

let n = 0;
const ok = (name, fn) => {
  try {
    fn();
    n += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    throw e;
  }
};

console.log('=== 洗名字 ===');
ok('斜杠冒号问号都换成 -', () => {
  assert.equal(M.sanitizeFolderName('a/b:c?d*e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
});
ok('连续空白压成一个', () => {
  assert.equal(M.sanitizeFolderName('阿   鲸'), '阿 鲸');
});
ok('首尾点去掉（Windows 不允许）', () => {
  assert.equal(M.sanitizeFolderName('...示例会话...'), '示例会话');
});
ok('超长截断到 60', () => {
  assert.equal(M.sanitizeFolderName('字'.repeat(100)).length, 60);
});
ok('非字符串给空串', () => {
  assert.equal(M.sanitizeFolderName(null), '');
  assert.equal(M.sanitizeFolderName(123), '');
});

console.log('=== 短号 ===');
ok('去掉 session- 前缀取 8 位', () => {
  assert.equal(M.shortIdOf('session-ef567890-6523-445c'), 'ef567890');
  assert.equal(M.shortIdOf('abc'), 'abc');
});

console.log('=== 文件夹分配 ===');
const cfg = M.mergeConfig({ sessions: {} });

ok('第一个会话用纯名字', () => {
  const f = M.folderForSession(cfg, 'session-aaa11111-x', '示例会话');
  assert.equal(f, '示例会话');
});

ok('第二个同名会话自动加短号', () => {
  cfg.sessions['session-aaa11111-x'] = { title: '示例会话', folder: '示例会话', enabled: true };
  const f = M.folderForSession(cfg, 'session-bbb22222-y', '示例会话');
  assert.equal(f, '示例会话（bbb22222）');
});

ok('不同名的照旧用纯名字', () => {
  const f = M.folderForSession(cfg, 'session-ccc33333-z', '项目讨论');
  assert.equal(f, '项目讨论');
});

ok('已分配的文件夹不跟着新标题变', () => {
  cfg.sessions['session-aaa11111-x'].title = '改了个名字';
  const f = M.folderForSession(cfg, 'session-aaa11111-x', '改了个名字');
  assert.equal(f, '示例会话');
});

ok('没标题就用短号', () => {
  const f = M.folderForSession(cfg, 'session-ddd44444-q', '');
  assert.equal(f, 'ddd44444');
});

ok('没勾选的会话不占名字', () => {
  cfg.sessions['session-eee55555-w'] = { title: '占位', folder: '占位', enabled: false };
  const f = M.folderForSession(cfg, 'session-fff66666-v', '占位');
  assert.equal(f, '占位');
});

console.log('=== 白名单 ===');
ok('没勾选 = 不记', () => {
  assert.equal(M.isSessionEnabled(cfg, 'session-fff66666-v'), false);
});
ok('勾选了 = 记', () => {
  assert.equal(M.isSessionEnabled(cfg, 'session-aaa11111-x'), true);
});
ok('总开关关了 = 全不记', () => {
  const off = { ...cfg, enabled: false };
  assert.equal(M.isSessionEnabled(off, 'session-aaa11111-x'), false);
});

console.log('=== 脏配置不污染 ===');
ok('类型不对的字段被丢弃', () => {
  const c = M.mergeConfig({
    enabled: 'yes',
    saveReasoning: 1,
    sessions: {
      'session-x1': { title: 42, enabled: 'true' },
      'session-x2': null,
    },
  });
  assert.equal(c.enabled, true);
  assert.equal(c.saveReasoning, true);
  assert.equal(c.sessions['session-x1'].enabled, false);
  assert.equal(c.sessions['session-x1'].folder, 'x1');
  assert.equal(c.sessions['session-x2'], undefined);
});
ok('数组当 sessions 会当成空对象', () => {
  const c = M.mergeConfig({ sessions: [1, 2, 3] });
  assert.deepEqual(c.sessions, {});
});

console.log('=== 落盘往返 ===');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-cfg-'));
const file = path.join(dir, 'cfg.json');
ok('写进去能读回来', () => {
  const c = M.mergeConfig({ sessions: {} });
  c.rootDir = 'D:\\随便一个地方';
  c.sessions['session-zzz'] = { title: '测试', folder: '测试', enabled: true };
  const w = M.saveConfig(c, file);
  assert.equal(w.ok, true);
  const { config, error } = M.loadConfig(file);
  assert.equal(error, '');
  assert.equal(config.rootDir, 'D:\\随便一个地方');
  assert.equal(config.sessions['session-zzz'].enabled, true);
});
ok('文件坏了回落默认值，且不抛错', () => {
  fs.writeFileSync(file, '{这不是 JSON', 'utf8');
  const { config, error } = M.loadConfig(file);
  assert.ok(error.length > 0);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.sessions, {});
});
ok('没有 .tmp 残留', () => {
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n全部通过：${n} 项`);
