// DSH「原话存档」· 网页半边
//
// 在 **设置** 左侧栏加一项「原话存档」，管三件事：
//   ① 总开关 / 存不存思考
//   ② 勾选要记录的会话（勾一个 = 那个会话有自己的文件夹）
//   ③ 把整个原话目录搬到别处
//
// ⚠ 这里不碰文件、不写盘，只往宿主那几条 /original-words/* 路由上读写。
//   真正的判断和写盘都在 lib/index.js 和 lib/transfer.js，只有一份逻辑。
//
// ⚠ 槽位名 'settings.section' 跟 dsh-speak-up 用的是同一个，是在这个环境里
//   已经跑通的路子。

window.__ModuleLoader__.load({
  id: 'dsh-original-words',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const inject = ['slots'];

    const h = React.createElement;
    const B = '/original-words';

    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null);

    // ── 样式 ────────────────────────────────────────────────
    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.7 },
      h1: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' },
      dim: { color: '#888', fontSize: 12 },
      card: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, padding: '12px 14px', margin: '14px 0' },
      row: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' },
      label: { minWidth: 96, color: '#666' },
      code: { fontFamily: 'Consolas, monospace', fontSize: 12, background: 'rgba(128,128,128,.12)', padding: '2px 6px', borderRadius: 4, wordBreak: 'break-all' },
      btn: { padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', cursor: 'pointer', fontSize: 13 },
      btnMain: { padding: '6px 16px', borderRadius: 6, border: '1px solid #2d6cdf', background: '#2d6cdf', color: '#fff', cursor: 'pointer', fontSize: 13 },
      input: { flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', fontSize: 12, fontFamily: 'Consolas, monospace' },
      list: { maxHeight: 320, overflow: 'auto', border: '1px solid rgba(128,128,128,.2)', borderRadius: 6 },
      item: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderBottom: '1px solid rgba(128,128,128,.12)' },
      warn: { background: 'rgba(240,180,60,.14)', border: '1px solid rgba(240,180,60,.4)', borderRadius: 6, padding: '8px 10px', margin: '10px 0', fontSize: 12 },
      err: { background: 'rgba(220,70,70,.12)', border: '1px solid rgba(220,70,70,.4)', borderRadius: 6, padding: '8px 10px', margin: '10px 0', fontSize: 12, color: '#c0392b' },
      ok: { background: 'rgba(60,180,110,.12)', border: '1px solid rgba(60,180,110,.4)', borderRadius: 6, padding: '8px 10px', margin: '10px 0', fontSize: 12 },
      bar: { height: 6, background: 'rgba(128,128,128,.2)', borderRadius: 3, overflow: 'hidden', margin: '8px 0' },
      barIn: { height: '100%', background: '#2d6cdf', transition: 'width .2s' },
      // 「有改动没保存」的提示条：粘在顶部，颜色够醒但不像是报错
      dirtyBar: {
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '9px 12px',
        margin: '0 0 10px',
        borderRadius: 6,
        border: '1px solid #e0a000',
        background: 'rgba(255,190,60,.22)',
        fontSize: 12,
      },
    };

    function 按钮(text, onClick, main, disabled) {
      return h(
        'button',
        { style: main ? S.btnMain : S.btn, onClick, disabled: !!disabled },
        text,
      );
    }

    // ── 主组件 ──────────────────────────────────────────────
    function Section() {
      const [state, setState] = React.useState(null);
      const [picks, setPicks] = React.useState({});
      // 上一次「读到的 / 保存成功的」状态。拿它跟当前值一比，就知道有没有脏改动。
      const [saved, setSaved] = React.useState(null);
      const [enabled, setEnabled] = React.useState(true);
      const [saveReasoning, setSaveReasoning] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState({ kind: '', text: '' });

      const [toDir, setToDir] = React.useState('');
      const [pre, setPre] = React.useState(null);
      const [job, setJob] = React.useState(null);

      const 说 = (kind, text) => setMsg({ kind, text });

      const 刷新 = async () => {
        const s = await get('/state');
        if (!s || !s.ok) {
          说('err', (s && s.error) || '读不到状态');
          return;
        }
        setState(s);
        setEnabled(s.enabled);
        setSaveReasoning(s.saveReasoning);
        const next = {};
        for (const item of s.sessions) next[item.id] = item.enabled;
        setPicks(next);
        // 读到的这份就是"已保存"的基准，之后任何改动都跟它比
        setSaved({ enabled: s.enabled, saveReasoning: s.saveReasoning, picks: { ...next } });
      };

      React.useEffect(() => {
        刷新();
      }, []);

      // ⚠ 所有 hook 都必须排在上面那句 if (!state) return **之前**。
      //   2026-10-25 我把 useEffect 写在了它后面：首屏只跑 2 个 hook、数据到了跑 3 个，
      //   React 判定"渲染期间 hook 数量变了"直接整块崩掉 —— 表现是设置页右半边一片空白。
      // 脏标记：state 还没来的时候一律按"不脏"算。
      const 脏了 =
        saved !== null &&
        state !== null &&
        (enabled !== saved.enabled ||
          saveReasoning !== saved.saveReasoning ||
          state.sessions.some((s) => (picks[s.id] === true) !== (saved.picks[s.id] === true)));

      // 有脏改动时，关标签页 / 刷新页面前拦一下，别让改动悄悄没了
      React.useEffect(() => {
        if (!脏了) return undefined;
        const guard = (e) => {
          e.preventDefault();
          e.returnValue = '';
        };
        window.addEventListener('beforeunload', guard);
        return () => window.removeEventListener('beforeunload', guard);
      }, [脏了]);

      if (!state) {
        return h('div', { style: S.wrap }, h('div', { style: S.dim }, '读取中…'));
      }

      const 已勾数 = Object.values(picks).filter(Boolean).length;

      const 保存 = async () => {
        setBusy(true);
        说('', '');
        const sessions = state.sessions.map((s) => ({ id: s.id, title: s.title, enabled: picks[s.id] === true }));
        const r = await post('/config', { enabled, saveReasoning, sessions });
        setBusy(false);
        if (r && r.ok) {
          说('ok', '已保存。下一轮对话开始按新设置记录。');
          await 刷新();
        } else {
          说('err', (r && r.error) || '保存失败');
        }
      };

      const 预检 = async () => {
        setBusy(true);
        setPre(null);
        说('', '');
        const r = await post('/transfer/precheck', { to: toDir });
        setBusy(false);
        if (!r) return 说('err', '预检请求失败');
        setPre(r);
        if (!r.ok) 说('err', r.error);
        else 说('', '');
      };

      const 开始转移 = async () => {
        setBusy(true);
        说('', '');
        const r = await post('/transfer', { to: toDir });
        if (!r || !r.ok) {
          setBusy(false);
          return 说('err', (r && r.error) || '转移没能启动');
        }
        setJob({ phase: 'queued', done: 0, total: r.total, text: '排队中', finished: false });
        // 轮询进度
        const 轮 = async () => {
          const p = await get('/transfer/status?jobId=' + encodeURIComponent(r.jobId));
          if (!p || !p.ok) {
            setBusy(false);
            return 说('err', (p && p.error) || '查不到任务进度');
          }
          setJob(p.job);
          if (!p.job.finished) {
            setTimeout(轮, 400);
            return;
          }
          setBusy(false);
          if (p.job.ok) {
            说('ok', '转移完成。' + (p.job.result && p.job.result.backupPath ? '旧目录已改名为：' + p.job.result.backupPath + '（确认没问题后你可以自己删掉）' : ''));
            await 刷新();
          } else {
            说('err', '转移没有完成：' + (p.job.error || '未知原因') + '。源目录没有被动过。');
          }
        };
        setTimeout(轮, 400);
      };

      // ── 视图 ──
      const 状态卡 = h(
        'div',
        { style: S.card },
        h('div', { style: S.h1 }, '原话存档'),
        h('div', { style: S.dim }, '把你自己发出的每一轮消息逐字记下来。不摘要、不筛选、不经过模型。'),
        !state.configExists
          ? h(
              'div',
              { style: S.warn },
              '现在还是旧模式：所有会话全都记，全部混在同一个目录里。你在这里勾选任意一个会话并保存之后，才会切换到「只记勾选的会话、各自一个文件夹」。',
            )
          : null,
        h('div', { style: S.row }, h('span', { style: S.label }, '存放位置'), h('span', { style: S.code }, state.rootDir)),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, '配置文件'),
          h('span', { style: S.code }, state.configPath),
          h('span', { style: S.dim }, state.configExists ? '（已启用新行为）' : '（还没有，等于旧模式）'),
        ),
      );

      const 开关卡 = h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: (e) => setEnabled(e.target.checked),
          }),
          h('span', null, '总开关'),
          h('span', { style: S.dim }, '关掉就一行都不写'),
        ),
        h(
          'div',
          { style: S.row },
          h('input', {
            type: 'checkbox',
            checked: saveReasoning,
            onChange: (e) => setSaveReasoning(e.target.checked),
          }),
          h('span', null, '连思考过程一起存'),
          h('span', { style: S.dim }, '关掉只留我说出口的话'),
        ),
      );

      const 会话卡 = h(
        'div',
        { style: S.card },
        h('div', { style: { ...S.h1, fontSize: 14 } }, '记录哪些会话'),
        h(
          'div',
          { style: S.dim },
          state.configExists
            ? '只勾你想要的。勾一个会话，它就会有自己独立的文件夹。'
            : '勾选之后保存，才会切换到下面这个结构。',
        ),
        h(
          'div',
          { style: { ...S.code, margin: '8px 0', display: 'block' } },
          state.rootDir + '\\<会话名称>\\YYYY-MM-DD.md',
        ),
        h(
          'div',
          { style: S.list },
          state.sessions.length === 0
            ? h('div', { style: { ...S.item, color: '#888' } }, '还没有可选的会话。先打开一个对话，再回来。')
            : state.sessions.map((s) =>
                h(
                  'div',
                  { style: S.item, key: s.id },
                  h('input', {
                    type: 'checkbox',
                    checked: picks[s.id] === true,
                    onChange: (e) => setPicks({ ...picks, [s.id]: e.target.checked }),
                  }),
                  h('span', { style: { flex: 1 } }, s.title || '（还没起名）'),
                  s.archived ? h('span', { style: { ...S.dim, color: '#c0392b' } }, '已归档') : null,
                  h('span', { style: S.dim }, s.short),
                  picks[s.id] === true && s.folder ? h('span', { style: S.code }, s.folder) : null,
                ),
              ),
        ),
        h('div', { style: { ...S.dim, marginTop: 8 } }, '已勾选 ' + 已勾数 + ' 个会话'),
      );

      const 转移卡 = h(
        'div',
        { style: S.card },
        h('div', { style: { ...S.h1, fontSize: 14 } }, '换个地方存'),
        h('div', { style: S.dim }, '先复制、逐个文件比对哈希，全部通过才把旧目录改名留底。任何一步失败都不会动原数据。'),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, '新位置'),
          h('input', {
            style: S.input,
            value: toDir,
            placeholder: '例如 D:\\原话',
            onChange: (e) => {
              setToDir(e.target.value);
              setPre(null);
            },
          }),
        ),
        h(
          'div',
          { style: S.row },
          按钮('先检查一下', 预检, false, busy || toDir.trim().length === 0),
          按钮('开始转移', 开始转移, true, busy || !pre || !pre.ok),
        ),
        pre && pre.ok
          ? h('div', { style: S.ok }, '可以转移：' + pre.fileCount + ' 个文件，共 ' + (pre.bytes / 1024 / 1024).toFixed(2) + ' MB。点「开始转移」。')
          : null,
        job
          ? h(
              'div',
              null,
              h('div', { style: S.bar }, h('div', { style: { ...S.barIn, width: (job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0) + '%' } })),
              h('div', { style: S.dim }, (job.text || '') + (job.total > 0 ? '（' + job.done + '/' + job.total + '）' : '')),
            )
          : null,
      );

      const 消息 = msg.text
        ? h('div', { style: msg.kind === 'err' ? S.err : msg.kind === 'ok' ? S.ok : S.warn }, msg.text)
        : null;

      return h(
        'div',
        { style: S.wrap },
        // 脏改动时一直挂在顶上，翻到哪一段都看得见
        脏了
          ? h(
              'div',
              { style: S.dirtyBar },
              h('span', { style: { fontWeight: 600 } }, '⚠ 有改动还没保存'),
              h('span', { style: { color: '#8a6d00' } }, '现在这些只在这一页上，点一下才真的生效'),
              按钮('立即保存', 保存, true, busy),
            )
          : null,
        状态卡,
        开关卡,
        会话卡,
        转移卡,
        消息,
        h('div', { style: { marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' } },
          按钮('保存设置', 保存, true, busy),
          busy ? h('span', { style: S.dim }, '处理中…') : null,
        ),
        h('div', { style: { ...S.dim, marginTop: 16 } },
          '提示：改完设置下一轮就生效，但插件本身的代码改动要重启 DSH 才会加载。',
        ),
      );
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'original-words', order: 54, label: () => '原话存档' },
          Section,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
