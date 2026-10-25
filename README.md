# dsh-original-words · 原话存档器

> 一个 DSH 插件。零依赖，只收你本人发出的消息。

## 它是干什么的

把**你本人**和 **AI** 在这个工作区说过的每一句话，逐字追加到纯文本里。
不摘要、不判断重要性、不经过模型。上下文压缩之后还能对着原文核。

它不解决"记住"，它解决"**证据**"。

## 安装

```bash
dsh plugin --profile desktop add link:<本仓库路径>
```

装完在 profile 的 `package.json` 里把 `dsh-original-words` 加进 `dsh.profile.bundles`，然后重启 DSH。
（插件代码不热重载，改 `.js` 之后也要重启才生效。）

## 数据在哪（v1 起按会话分文件夹）

```
<根目录>\
├── <会话名称>\YYYY-MM-DD.md     勾选过的会话，各自一个文件夹
├── _会话索引.md                 短号 = 标题，跨会话共用，永远在根目录
└── _会话目录.md                 上次扫描出来的会话清单（可选）
```

根目录默认是 `~\Documents\dsh\原话`，**可以在设置里改**。

文件夹命名规则（`lib/config.js` 的 `folderForSession`）：

- 第一次给某个会话建档时，直接用它的标题
- 标题里有 `\ / : * ? " < > |` 之类的字符会被替换成 `_`
- **一旦建了档，文件名称不再跟着标题变**——你后来改了会话名，老文件夹不会跟着跑（否则历史记录会被劈成两半）
- 两个会话同名时，后来的那个变成 `名称（短号）`，只有真的撞了才加后缀

文件格式：

```markdown
## 18:02:28 · abcd1234 · 「示例对话」 · 450b1cbe-...
（用户说的话）

### 18:02:51 · abcd1234 · 「示例对话」 · 我
（思考）
我想想……
（回复）
说清楚了
```

- `##` = 用户，`###` = 我
- 会话短号是 `session.id` 去掉 `session-` 前缀取前 8 位，**唯一且稳定**
- 用户的去重键是 `rpcId`；我的去重键是会话内递增的 `seq`（存成 `a:seq`）

## ⚠ 两种模式：「存在即切换」

这是最容易搞混的地方，先说清楚。

| 配置文件 | 行为 |
|---|---|
| **不存在** | **旧行为**：所有会话全都记，全部混在根目录的扁平 `YYYY-MM-DD.md` 里 |
| **存在** | **新行为**：只记勾选的会话，各自一个文件夹 |

配置文件路径：`<DSH_HOME>\original-words-config.json`（`DSH_HOME` 默认 `~\.dsh`）。

为什么要这样设计：界面上线之前，存档一秒都不能断。所以**没有配置文件时，插件的行为和升级前一模一样**；
用户在设置页勾了任意一个会话并保存，配置文件出现，**从下一条消息起**自动切到新行为。

`lib/index.js` 里每次事件都会 `stat` 一次配置文件、mtime 变了才重读，所以保存后**不用重启**就生效。
（但**插件代码本身**的改动必须重启，见下面「排查路径」。）

## 设置页

设置 → 左侧栏「**原话存档**」（`slots` 槽位 `settings.section`，order 54）。四块：

1. **状态**：当前根目录、配置文件在不在
2. **开关**：总开关、连思考一起存
3. **记录哪些会话**：复选框列表，勾了就有独立文件夹
4. **换个地方存**：填新路径 → 先检查 → 开始转移

接口都在 `/original-words/*` 下，实现在 `lib/routes.js`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/original-words/state` | 配置 + 会话清单（含勾选态） |
| POST | `/original-words/config` | 保存配置 |
| POST | `/original-words/transfer/precheck` | 转移前预检，不动文件 |
| POST | `/original-words/transfer` | 开始转移，返回 jobId |
| GET | `/original-words/transfer/status?jobId=` | 轮询进度 |

## 转移（唯一会动数据的操作）

`lib/transfer.js`，流程写死成这个顺序：

```
① 预检   目标必须不存在或为空；不能在源目录里面；不是同一个目录
② 复制   复制到 <目标>\.transfering-<时间戳>\，逐文件算 SHA256
③ 校验   源与目标的每个文件哈希必须一致，不一致就整个撤掉
④ 切配置 rootDir 指向新位置
⑤ 源改名 <源>.old-<时间戳>          ← 只改名，不删
```

**代码里没有任何删除源目录的路径。** 旧目录改完名还在，确认没问题之后由用户自己删。

任何一步失败：临时目录会被清掉，**源目录一字未动**。
测试 `test/transfer.mjs` 专门验了这条（目标被占时源目录内容不变）。

## 三个已知问题（都别再当成 bug 查一遍）

### 1. 注入的会话号会滞后一轮

**症状**：刚切换对话后的第一句话，注入里报的是**上一个**会话的短号。第二轮起才正确。

**根因**：`ctx.systemPrompt.section` 的 `text` 当前拿不到 agent/session 时，只能用
`session/event` 里"最近一次用户本人发言"来猜，而 section 的渲染时机可能早于该事件到达。

**如果某轮注入的短号和你从存档里读到的不一致，以存档为准**（存档的短号直接取自 session 对象）。

### 2. 分目录之后，跨会话不再自动可见

v1 之前所有会话写同一个日期文件，读到别的会话的话是常态。
v1 之后每个会话一个文件夹，只会读到当前会话文件夹里的内容。

`_会话索引.md` 仍然在根目录、全工作区共用——但它只记「短号 → 标题」的对照，
不含任何消息正文。

**自己写读取逻辑时注意**：默认只读当前会话文件夹；要跨会话对比，得显式指定目录。

### 3. 标题只在两个时机刷新

`session/title` 事件只在**新会话首轮之后**和**用户手动改名**时触发。
重启不会重发旧标题，所以标题靠 `_会话索引.md` 落盘兜底（`loadTitle` → `resolveTitle` 三级回退）。

如果某会话一直显示"（尚未命名）"：检查 `_会话索引.md` 里有没有这个短号，没有就让用户改一次名。

## 过滤器（改代码时最容易被破坏的地方）

**只收用户本人发的消息**，条件必须三条同时成立：

```js
event.type === 'user/message'
event.data.role === 'user'
event.data.source.kind === 'user'   // ← 这条才是分水岭
```

`user/message` 事件里**混杂着注入内容**，它们的 `source.kind` 分别是
`time-context` / `plugin:meow-memory` / `skill-catalog` / `runtime-context`。
实测某会话 226 条 `user/message` 里只有 163 条是真的用户消息——**只按 type 过滤会有 28% 脏数据**。

**我的话**走 `assistant/message`，从 `data.message.content` 里拆 `reasoning`（思考）和 `text`（回复）。
纯工具调用（两块都空）不记录，避免噪音。开关：`saveReasoning`（默认 true）。

## 排查路径

| 症状 | 先查 |
|---|---|
| 一个字都没写 | 插件是否加载：`.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 有没有它 |
| 勾了会话还是不记 | 配置文件里 `sessions[id].enabled` 是不是 `true`；`enabled` 总开关是不是被关了 |
| 写进了注入内容 | `classifyEvent` 的三条过滤条件，尤其 `source.kind` |
| 同一句话写了两遍 | 去重键：用户看 `rpcId`，我看 `a:seq`；去重集按文件分桶（`state.byFile`） |
| 标题是"（尚未命名）" | `_会话索引.md` 里有没有该短号；见上面问题 3 |
| 改了代码没生效 | **`.js` 改动不会热重载**，`patchReload: live` 只管 `cordis.patch.yml`，必须重启 DSH |
| 设置页不出现 | `package.json` 的 `exports["./client"]` 和 `dsh.client` 有没有；槽位是否被别的插件占了 |

## 代码结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 主体：过滤、去重、组装、写盘、会话路由、提示词注入 |
| `lib/config.js` | 配置文件读写、文件夹命名、白名单判断（无副作用，好测） |
| `lib/transfer.js` | 转移：预检 / 复制 / 校验 / 改名，失败即回滚 |
| `lib/routes.js` | HTTP 接口（`/original-words/*`） |
| `lib/client.js` | 设置页 React 组件（`window.__ModuleLoader__` 挂载） |

`lib/index.js` 的导出：

| 导出 | 作用 |
|---|---|
| `classifyEvent` | 判断是不是用户本人发言，取 rpcId + 文本 |
| `classifyAssistant` / `splitAssistant` | 判断是不是我的话，拆思考与回复 |
| `handleEvent` | 核心：分流、去重、组装、写盘（纯函数，可离线测） |
| `resolveOutDir` | 旧模式的目录解析（配置文件不存在时用） |
| `apply` | Cordis 入口 |

## 测试

```bash
node test/offline.mjs    # 39 项：过滤、去重、格式、标题回退
node test/config.mjs     # 20 项：文件夹命名、白名单、脏配置
node test/transfer.mjs   # 12 项：转移的全部成功/失败路径
node test/routing.mjs    #  8 项：真的调 apply()，验白名单和分目录
node test/routes.mjs     # 11 项：五个 HTTP 接口，含转移全流程
```

合计 90 项。**全部在临时目录里跑，不碰真实原话数据。**

## 一条原则

这份存档存在的意义是**对抗失真**。

摘要会吃掉措辞、语气、说错又改口的过程。原话不会。
你看到的那份原文，随时可以对。

**建议：不要为了好看去改存档内容，也不要拿它当素材去编故事——那样它就不再是证据了。**
