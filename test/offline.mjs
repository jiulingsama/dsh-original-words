/**
 * 离线自检：不挂载 DSH，直接喂假事件，验证过滤、去重、写盘。
 *
 *   node test/offline.mjs
 *
 * 全部通过则退出码 0，否则 1。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAssistantChunk,
  buildChunk,
  classifyAssistant,
  classifyEvent,
  extractText,
  handleEvent,
  loadIndexTitles,
  localDateKey,
  recordTitle,
  resolveTitle,
  sessionIdOf,
  sessionNote,
  shortSessionId,
  splitAssistant,
  titleOfEvent,
} from '../lib/index.js';

let passed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}: ${error && error.message}`);
  }
}

/** 造一条"用户本人发的消息"事件。 */
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

/** 造一条注入消息事件（这正是必须被挡掉的）。 */
function injectedEvent(kind, text) {
  return {
    type: 'user/message',
    seq: 2,
    time: Date.UTC(2026, 9, 21, 2, 51, 3),
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind },
    },
  };
}

console.log('--- extractText ---');
test('纯字符串原样返回', () => {
  assert.equal(extractText('你好'), '你好');
});
test('单个 text 块', () => {
  assert.equal(extractText([{ type: 'text', text: '你好' }]), '你好');
});
test('多块按行拼接，图片标 [图片]', () => {
  assert.equal(
    extractText([{ type: 'text', text: '看这个' }, { type: 'image' }, { type: 'text', text: '好看吗' }]),
    '看这个\n[图片]\n好看吗',
  );
});
test('非法输入返回空串', () => {
  assert.equal(extractText(null), '');
  assert.equal(extractText(42), '');
  assert.equal(extractText([]), '');
});

console.log('--- classifyEvent ---');
test('真消息通过', () => {
  const r = classifyEvent(userEvent('你好', 'aaaaaaaa-1111-2222-3333-444444444444'));
  assert.equal(r.ok, true);
  assert.equal(r.text, '你好');
  assert.equal(r.rpcId, 'aaaaaaaa-1111-2222-3333-444444444444');
});
test('记忆注入被挡', () => {
  assert.equal(classifyEvent(injectedEvent('plugin:meow-memory', '可能相关的记忆：xxx')).ok, false);
});
test('时钟注入被挡', () => {
  assert.equal(classifyEvent(injectedEvent('time-context', '现在：2026-10-21')).ok, false);
});
test('技能目录被挡', () => {
  assert.equal(classifyEvent(injectedEvent('skill-catalog', 'available skills')).ok, false);
});
test('运行时上下文被挡', () => {
  assert.equal(classifyEvent(injectedEvent('runtime-context', 'sandbox policy')).ok, false);
});
test('缺 source 被挡', () => {
  const ev = userEvent('你好', 'x');
  delete ev.data.source;
  assert.equal(classifyEvent(ev).ok, false);
});
test('非 user/message 被挡', () => {
  const ev = userEvent('你好', 'x');
  ev.type = 'assistant/message';
  assert.equal(classifyEvent(ev).ok, false);
});
test('role 不是 user 被挡', () => {
  const ev = userEvent('你好', 'x');
  ev.data.role = 'assistant';
  assert.equal(classifyEvent(ev).ok, false);
});
test('空白文本被挡', () => {
  assert.equal(classifyEvent(userEvent('   \n  ', 'x')).ok, false);
});

console.log('--- buildChunk ---');
test('首块带文件头，后续不带', () => {
  const withHeader = buildChunk({
    day: '2026-10-21',
    time: '02:51:03',
    rpcId: 'abc',
    text: '你好',
    needsHeader: true,
    header: '> 说明',
  });
  assert.ok(withHeader.startsWith('# 原话 · 2026-10-21'));
  assert.ok(withHeader.includes('> 说明'));
  assert.ok(withHeader.includes('## 02:51:03 · abc'));
  const noHeader = buildChunk({
    day: '2026-10-21',
    time: '02:51:04',
    rpcId: '',
    text: '再来',
    needsHeader: false,
    header: '> 说明',
  });
  assert.ok(!noHeader.startsWith('# 原话'));
  assert.ok(noHeader.includes('## 02:51:04'));
});

console.log('--- handleEvent 端到端 ---');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-test-'));
const config = { outDir: path.join(tmpRoot, '原话'), enabled: true, header: '> 说明' };

test('写入真实文件，内容正确', () => {
  const state = { currentFile: '', seen: new Set() };
  const wrote = handleEvent({
    session: {},
    event: userEvent('第一句话', 'aaaaaaaa-1111-2222-3333-444444444444'),
    state,
    config,
  });
  assert.equal(wrote, true);
  const day = localDateKey(new Date(Date.UTC(2026, 9, 21, 2, 51, 3)));
  const file = path.join(config.outDir, `${day}.md`);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('第一句话'));
  assert.ok(text.includes('aaaaaaaa-1111-2222-3333-444444444444'));
  assert.ok(text.startsWith(`# 原话 · ${day}`));
});

test('同 rpcId 第二次不写', () => {
  const state = { currentFile: '', seen: new Set() };
  const ev = userEvent('重复的话', 'bbbbbbbb-1111-2222-3333-444444444444');
  assert.equal(handleEvent({ session: {}, event: ev, state, config }), true);
  assert.equal(handleEvent({ session: {}, event: ev, state, config }), false);
});

test('注入事件一条都不写', () => {
  const state = { currentFile: '', seen: new Set() };
  for (const kind of ['time-context', 'plugin:meow-memory', 'skill-catalog', 'runtime-context']) {
    const wrote = handleEvent({ session: {}, event: injectedEvent(kind, '注入内容'), state, config });
    assert.equal(wrote, false, `${kind} 应该被挡`);
  }
});

test('跨重启去重：新 state 从文件读回 rpcId', () => {
  const rpcId = 'cccccccc-1111-2222-3333-444444444444';
  const ev = userEvent('重启前后同一句话', rpcId);
  const first = { currentFile: '', seen: new Set() };
  assert.equal(handleEvent({ session: {}, event: ev, state: first, config }), true);

  const afterRestart = { currentFile: '', seen: new Set() };
  assert.equal(handleEvent({ session: {}, event: ev, state: afterRestart, config }), false);

  const day = localDateKey(new Date(Date.UTC(2026, 9, 21, 2, 51, 3)));
  const text = fs.readFileSync(path.join(config.outDir, `${day}.md`), 'utf8');
  const occurrences = text.split('重启前后同一句话').length - 1;
  assert.equal(occurrences, 1, `同一句话应只出现一次，实际 ${occurrences} 次`);
});

test('outDir 未配置时从 session.cwd 推导', () => {
  const state = { currentFile: '', seen: new Set() };
  const wrote = handleEvent({
    session: { cwd: path.join(tmpRoot, 'fake-ws') },
    event: userEvent('推导路径', 'dddddddd-1111-2222-3333-444444444444'),
    state,
    config: { outDir: '', enabled: true, header: '' },
  });
  assert.equal(wrote, true);
  const day = localDateKey(new Date(Date.UTC(2026, 9, 21, 2, 51, 3)));
  assert.ok(fs.existsSync(path.join(tmpRoot, 'fake-ws', '原话', `${day}.md`)));
});

console.log('--- 会话标识（v0.2） ---');
const SID = 'session-aaaaaaaa-1111-2222-3333-444444444444';

test('sessionIdOf 从 id 取', () => {
  assert.equal(sessionIdOf({ id: SID }), SID);
});
test('shortSessionId 去掉 session- 前缀取 8 位', () => {
  assert.equal(shortSessionId({ id: SID }), 'aaaaaaaa');
  assert.equal(shortSessionId({}), '');
});
test('titleOfEvent 只认 session/title', () => {
  assert.equal(titleOfEvent({ type: 'session/title', data: { title: '优化打开等待时间' } }), '优化打开等待时间');
  assert.equal(titleOfEvent({ type: 'user/message', data: { title: 'x' } }), '');
});
test('buildChunk 把会话短号和标题拼进标题行', () => {
  const chunk = buildChunk({
    day: '2026-10-21',
    time: '02:57:22',
    rpcId: 'f39e6ebe-0000-0000-0000-000000000000',
    sessionShort: 'abcd1234',
    sessionTitle: '优化打开等待时间',
    text: '原话',
    needsHeader: false,
    header: '',
  });
  assert.ok(chunk.includes('## 02:57:22 · abcd1234 · 「优化打开等待时间」 · f39e6ebe'));
});
test('handleEvent 写出的记录带会话短号', () => {
  const state = { currentFile: '', seen: new Set(), titles: new Map() };
  const ev = userEvent('带会话号的话', 'eeeeeeee-1111-2222-3333-444444444444');
  const wrote = handleEvent({
    session: { id: SID },
    event: ev,
    state,
    config,
  });
  assert.equal(wrote, true);
  const day = localDateKey(new Date(Date.UTC(2026, 9, 21, 2, 51, 3)));
  const text = fs.readFileSync(path.join(config.outDir, `${day}.md`), 'utf8');
  assert.ok(text.includes('· aaaaaaaa'), '应带短号 aaaaaaaa');
  assert.ok(text.includes('带会话号的话'));
});
test('title 事件写进 _会话索引.md 且不重复', () => {
  const state = { currentFile: '', seen: new Set(), titles: new Map() };
  const titleEv = { type: 'session/title', seq: 1, time: 0, data: { title: '优化打开等待时间' } };
  const cfg2 = { ...config, outDir: path.join(tmpRoot, '索引测试') };
  const first = recordTitle({
    dir: cfg2.outDir,
    fullId: SID,
    short: 'aaaaaaaa',
    title: titleEv.data.title,
    state,
  });
  const second = recordTitle({
    dir: cfg2.outDir,
    fullId: SID,
    short: 'aaaaaaaa',
    title: titleEv.data.title,
    state,
  });
  assert.equal(first, true);
  assert.equal(second, false, '同一标题不该写第二遍');
  const idx = fs.readFileSync(path.join(cfg2.outDir, '_会话索引.md'), 'utf8');
  assert.ok(idx.includes('- aaaaaaaa = 优化打开等待时间'));
});
test('标题后到时，后续记录自动带上标题', () => {
  const state = { currentFile: '', seen: new Set(), titles: new Map() };
  const cfg3 = { ...config, outDir: path.join(tmpRoot, '标题回填') };
  recordTitle({ dir: cfg3.outDir, fullId: SID, short: 'aaaaaaaa', title: '优化打开等待时间', state });
  handleEvent({
    session: { id: SID },
    event: userEvent('标题已经到了', 'ffffffff-1111-2222-3333-444444444444'),
    state,
    config: cfg3,
  });
  const day = localDateKey(new Date(Date.UTC(2026, 9, 21, 2, 51, 3)));
  const text = fs.readFileSync(path.join(cfg3.outDir, `${day}.md`), 'utf8');
  assert.ok(text.includes('「优化打开等待时间」'));
});

console.log('--- 会话提示词（v0.3） ---');
test('sessionNote 带标题和短号，并明确要求别复述', () => {
  const note = sessionNote({ session: { id: SID }, titles: new Map([[SID, '优化打开等待时间']]) });
  assert.ok(note.includes('「优化打开等待时间」'), '应含标题');
  assert.ok(note.includes('aaaaaaaa'), '应含短号');
  assert.ok(note.includes('不要在回复里复述'), '应禁止主动复述');
});
test('标题还没到时用（尚未命名）', () => {
  const note = sessionNote({ session: { id: SID }, titles: new Map() });
  assert.ok(note.includes('尚未命名'));
  assert.ok(note.includes('aaaaaaaa'));
});
test('没有会话时返回空串，不污染提示词', () => {
  assert.equal(sessionNote({ session: null, titles: new Map() }), '');
  assert.equal(sessionNote({}), '');
  assert.equal(sessionNote(null), '');
});

console.log('--- 我的原文（v0.4） ---');
function assistantEvent(content, seq = 42, ms = Date.UTC(2026, 9, 21, 10, 2, 0)) {
  return { type: 'assistant/message', seq, time: ms, data: { message: { role: 'assistant', content } } };
}

test('splitAssistant 拆出思考和回复，忽略工具块', () => {
  const r = splitAssistant([
    { type: 'reasoning', text: '我想想' },
    { type: 'tool-call', name: 'x' },
    { type: 'text', text: '结论是' },
  ]);
  assert.equal(r.thinking, '我想想');
  assert.equal(r.reply, '结论是');
});
test('classifyAssistant 认 assistant/message，拒绝用户消息', () => {
  const hit = classifyAssistant(assistantEvent([{ type: 'text', text: '我说了' }]), { saveReasoning: true });
  assert.equal(hit.ok, true);
  assert.equal(hit.seq, 42);
  assert.ok(hit.text.includes('我说了'));
  assert.equal(classifyAssistant(userEvent('x', 'y')).ok, false);
});
test('saveReasoning=false 时丢掉思考', () => {
  const hit = classifyAssistant(
    assistantEvent([
      { type: 'reasoning', text: '秘密' },
      { type: 'text', text: '公开' },
    ]),
    { saveReasoning: false },
  );
  assert.ok(!hit.text.includes('秘密'));
  assert.ok(hit.text.includes('公开'));
});
test('纯工具调用不产生记录', () => {
  assert.equal(classifyAssistant(assistantEvent([{ type: 'tool-call', name: 'x' }]), {}).ok, false);
});
test('handleEvent 把我的消息写成三级标题，带思考与回复', () => {
  const state = { currentFile: '', seen: new Set(), titles: new Map(), indexTitles: new Map() };
  const cfg = { ...config, outDir: path.join(tmpRoot, '我的原文') };
  const wrote = handleEvent({
    session: { id: SID },
    event: assistantEvent(
      [
        { type: 'reasoning', text: '先想想' },
        { type: 'text', text: '然后说' },
      ],
      7,
    ),
    state,
    config: cfg,
  });
  assert.equal(wrote, true);
  const day = localDateKey(new Date(Date.UTC(2026, 9, 21, 10, 2, 0)));
  const text = fs.readFileSync(path.join(cfg.outDir, `${day}.md`), 'utf8');
  assert.ok(text.includes('### '), '应是三级标题');
  assert.ok(text.includes('· 我'), '应标我为作者');
  assert.ok(text.includes('（思考）'));
  assert.ok(text.includes('（回复）'));
  assert.ok(text.includes('先想想'));
  assert.ok(text.includes('然后说'));
});
test('同一 seq 不重复写', () => {
  const state = { currentFile: '', seen: new Set(), titles: new Map(), indexTitles: new Map() };
  const cfg = { ...config, outDir: path.join(tmpRoot, '我的去重') };
  const ev = assistantEvent([{ type: 'text', text: '只写一次' }], 9);
  assert.equal(handleEvent({ session: { id: SID }, event: ev, state, config: cfg }), true);
  assert.equal(handleEvent({ session: { id: SID }, event: ev, state, config: cfg }), false);
});

console.log('--- 标题跨重启回填（这次修的那个 bug） ---');
test('内存里没有标题时，从索引文件回填', () => {
  const note = sessionNote({
    session: { id: SID },
    titles: new Map(),
    indexTitles: new Map([['aaaaaaaa', '示例对话']]),
  });
  assert.ok(note.includes('「示例对话」'), '应从索引回填，而不是尚未命名');
  assert.ok(!note.includes('尚未命名'));
});
test('内存优先于索引', () => {
  assert.equal(
    resolveTitle(
      { titles: new Map([[SID, '内存里的']]), indexTitles: new Map([['aaaaaaaa', '索引里的']]) },
      { id: SID },
    ),
    '内存里的',
  );
});
test('loadIndexTitles 解析索引文件', () => {
  const dir = path.join(tmpRoot, '索引导入');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '_会话索引.md');
  fs.writeFileSync(file, '# 会话索引\n\n> 说明\n\n- abcd1234 = 示例对话\n- ef567890 = 另一个对话\n', 'utf8');
  const map = loadIndexTitles(file);
  assert.equal(map.get('abcd1234'), '示例对话');
  assert.equal(map.get('ef567890'), '另一个对话');
  assert.equal(map.size, 2);
});
test('索引文件不存在时返回空 Map，不抛错', () => {
  assert.equal(loadIndexTitles(path.join(tmpRoot, '不存在.md')).size, 0);
});

// 清理临时目录
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log('');
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.log(`\n--- ${f.label} ---\n${f.error && f.error.stack}`);
  process.exit(1);
}
console.log('ALL PASS');
