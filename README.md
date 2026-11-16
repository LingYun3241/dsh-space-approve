# dsh-space-approve

按 **空格** 批准 DSH 的权限审批弹窗、按 **Esc** 拒绝——**不用先用鼠标点卡片**，且只允许一次。

A DSH client plugin: press **Space** to approve a pending permission prompt (**allow once**), press **Esc** to reject. No click required.

## 为什么需要它

DSH 自带的审批卡有两个限制：

1. 按键处理器绑在卡片元素上，并且要求 `currentTarget.contains(document.activeElement)` —— **焦点不在卡片里，`Enter`/`Esc` 完全无效**；
2. 卡片出现时**不会自动聚焦**。

结果是：从别的会话切换过来、或焦点停在侧栏，必须先用鼠标点一下卡片才能操作。Claude Code Desktop 和 Codex App 都是**窗口级**快捷键（切任务后直接按即可），DSH 这里是实现缺口，本插件补的就是这一层。

## 它做什么

| 按键 | 行为 |
|---|---|
| `Space` | 允许一次（`allowed-once`，与官方 Enter 同义） |
| `Esc` | 拒绝（`rejected`，与官方 Esc 同义） |

两条都**不要求焦点在卡片内**：焦点停在侧栏、对话区、页面任意位置都能直接按。

## 安全边界（刻意不做的事）

| 场景 | 行为 |
|---|---|
| 焦点 / 事件落在输入框、textarea、contenteditable、下拉框（`region === "editable"`） | 空格照常输入，插件不处理 |
| **审批卡接管 composer 后，你正在打字的那块编辑区已经不可见**（编辑器被 `display:none`/`inert` 藏起来、焦点回落到 `<body>`） | 空格**一律不应答**（`editor-hidden`），并吞掉这一记按键以免滚动页面；**点一下任意位置**（或重新点回编辑器）后恢复。Esc 不受影响，仍可拒绝 |
| 输入法组字中，以及组字刚结束的那一下（`isComposing` / keyCode 229 / `compositionstart` / `compositionend`） | 不处理（WebKit 上 `isComposing` 不可靠，官方卡片也为此维护状态）。组字中切窗口/页面隐藏会复位该状态 |
| 按住键自动重复（`repeat`） | 只认第一次，不连批 |
| Ctrl / Alt / Shift / Cmd + 键 | 不处理 |
| 有无关的弹层打开（`[role="dialog"][aria-modal="true"]`，以及**右键菜单 / 下拉菜单**这类 `[role="menu"]`） | 不处理（选择器与宿主 `modalSelector` 完全对齐；取最上层、忽略不可见的挂载节点） |
| **卡片刚出现后的冷却期**（默认**关闭**，`cooldownMs=0`） | 只有显式打开时才生效：`warming:<key>`，不响应也不吞键。它**不是**防打字误批的防线 |
| 焦点在**卡片内**的按钮 / 链接上，或卡片内警告徽标打开的悬浮卡里 | 交给原生激活（聚焦「拒绝」按空格仍是拒绝；悬浮卡里的 Space/Esc 也不会应答审批） |
| 没有待批请求 / 卡片已撤销但 DOM 残留 | 不处理（不吞键、不 preventDefault） |
| 屏幕上有多个可见审批卡 | 只回答**唯一能匹配到待批请求**的那一块；两块都匹配（真分屏）则不处理，避免批错会话 |
| 卡片被 `inert` / `display:none` / `visibility:hidden` / 零尺寸隐藏 | 不处理 |
| 卡片带「始终允许」 | 只应答 `allowed-once`，**绝不持久授权** |
| 宿主没有暴露 `answer()` | 拒绝应答（`answer-failed`），**绝不按位置点按钮** |
| 官方 `Enter` / `Esc` 已经处理过（`defaultPrevented`） | 不重复应答 |

除此之外：没有自动批准、没有超时默认值、没有网络请求、没有凭据访问；卸载或热更新时注销监听并清掉 `window.__dshSpaceApprove`。

### `editor-hidden` 判据（P0）

审批卡接管 `conversation.composer` 时，官方渲染器把原 composer（含正在聚焦的编辑器）包进 `display:none`；
浏览器让编辑器失焦、`document.activeElement` 回落到 `<body>`。此时"打字中的空格"会绕过输入框守卫变成一次批准。

1.1.5 用 300ms 冷却期只挡住了第一记空格（实测 `+300ms` 就批准），1.1.6 换成**确定性判据**，
每次按键现算、无计时器：

```
!engaged && lastEditable && document.activeElement !== lastEditable && !isVisible(lastEditable)
```

- `lastEditable` 是最近获得焦点的**可编辑根节点**（contenteditable 的按键来自内部节点，会规范到根）；
- `!isVisible(lastEditable)`：这块编辑区**真的不可见了**（`checkVisibility` / computed style / rects / `inert`）。
  刻意不用"焦点丢了"当判据：Alt-Tab、点空白也会让焦点离开，但编辑器还可见，那时按空格应当照常可用；
- `!engaged`：用户已经用鼠标/焦点重新接管 UI（点任意位置、聚焦卡片外控件）。**点进 composer 内部**
  （挪光标、选中文字）**不算接管**，编辑器里的任何按键也会复位该状态；
- 恢复：点任意位置、聚焦卡片外控件、或重新点回编辑器打字；待批请求消失后状态清零。

三个版本的实跑对照（`node scripts/proof-composer-takeover.mjs`，连打 8 记空格 120ms~2100ms）：

```
v1.1.4  +120ms:answered        第一记就批准
v1.1.5  +120ms:warming  +300ms:answered   第二记批准（冷却期只是延缓）
1.1.6   +120ms…+2100ms 全部 editor-hidden，0 批准
对照   1.1.6 无编辑器焦点 +80ms 首按 → 立即 allowed-once
```

> **未验证的前提**：本机没有可用的浏览器自动化，`focusout` 在 `display:none` 时的派发时序**未验证**，
> 所以实现不依赖 `focusout`，改为按键时动态复查。真机请先确认两个值：
> 卡片出现后 `document.activeElement.tagName === "BODY"`；卡片出现前用 DevTools `$0` 选中 composer
> 编辑器、卡片出现后 `$0.checkVisibility() === false`。若任一不成立，守卫会走"焦点仍在编辑器"分支
> （`editor-focused`，同样不误批），但本版的 P0 判据就不是在实际生效的那一条，需上报。

## 输入路径

两条路径同时工作，**捕获阶段优先**：

1. **主路径**：`document` 的 **capture** 阶段 `keydown` 监听。它比"当前焦点控件自己的处理器"更早执行，因此即使你刚点过的侧栏按钮对空格调用了 `preventDefault()`，也不会把批准吞掉。应答后立即 `preventDefault()` + `stopPropagation()`；`editor-hidden` 拒绝时只 `preventDefault()`（防滚动），不阻断传播。
2. **兜底路径**：DSH 官方快捷键服务 `shortcuts.observeFixedInput()`（通过 `ctx.inject(["shortcuts"], …)` 等待服务就绪，不再与启动竞态；老宿主没有 `ctx.inject` 时退回 `ctx.get` 并打一条一次性 warning）。宿主返回归一化的 `{ gesture: { code, repeat, composing, defaultPrevented }, context: { region, modal, target }, consume() }`，覆盖 IME、死键、AltGraph、重复键与 modal 追踪。

宿主在 **window 冒泡阶段**分发兜底输入；主路径在 `document` 捕获阶段应答后 `stopPropagation()`，事件根本到不了 window，因此同一物理按键只会应答一次（这一点由测试用真实传播模型验证，不再靠 `answerable=false` 的同义反复）。`editor-hidden` 的 `preventDefault()` 会让兜底路径读到 `defaultPrevented` 并静默跳过——既不应答，也不写第二条诊断。

业务判断只有一套：找到可见的 `[data-approval-key]` 卡片 → 匹配 `uiSession.sessionStatus` 中 `kind === "approval"`、`answerable !== false` 的 pending 请求 → `answer("allowed-once" | "rejected")`。

## 工作方式

1. 取所有 `[data-approval-key]` 卡片，按可见性过滤（`checkVisibility()` / computed style / `getClientRects` / `[inert]`）；
2. 对每块可见卡片，用它的 key 在 `uiSession.sessionStatus` 里找 `kind === "approval"`、`answerable !== false` 的待批请求；
3. 恰好一块匹配 → 若焦点在卡片内控件（或卡片内警告徽标打开的悬浮卡里）→ 交还原生；再检查是否被无关弹层压住；两块以上匹配 → 放弃（`multi-panel:<n>`）；
4. 空格还要过 `editor-hidden` 判据（见上）：编辑区不可见且焦点已离开 → 拒绝；
5. 若显式打开了冷却期（`cooldownMs > 0`），卡片 key 首次可见距今 `< cooldownMs` 时返回 `warming:<key>`（默认不启用）；
6. 调用该请求的 `answer(...)` —— 语义级应答，不点按钮；
7. 应答成功后 `preventDefault()`（主路径再加 `stopPropagation()`）或 `consume()`（兜底路径），阻止按键继续触发别的动作（包括焦点所在的侧栏按钮）。

依赖 DSH Web 的运行态语义（`uiSession.sessionStatus` / pending interaction），对应 DSH `0.2.x`（当前安装的 `0.2.2-rc.3` 上核对过宿主实现，`0.2.2-rc.1` 上真机验证过）。

## 配置

**client 半身读不到 profile 的 `config`**：宿主创建 bundle entry 时只传 `{ name }`（见 `dsh-client-modules`），`apply(ctx, config)` 收到的 `config` 是 `undefined`；`cordis.patch.yml` 里的 `config` 只作用于 host 半身（本插件的 host 半身没有行为）。因此开关放在页面可读的 `localStorage` 里：

```js
// 关掉 Esc（只保留空格 = 允许一次）
localStorage.setItem("dsh-space-approve:escape", "false");

// 打开 1.1.5 那种冷却期（默认 0 = 关闭；它不是防打字误批的防线，只影响"卡片刚出现"的那一下）
localStorage.setItem("dsh-space-approve:cooldownMs", "300");

// 调试日志
localStorage.setItem("dsh-space-approve:debug", "1");
```

删除对应键即恢复默认。若宿主将来真的把 `config` 传给 client 半身，`config.escape` / `config.cooldownMs` 也会被读取，但 `localStorage` 优先。

## 安装

```bash
# 从 GitHub（<profile> 换成 desktop / web）
dsh plugin --profile <profile> add github:LingYun3241/dsh-space-approve

# 固定版本（推荐）
dsh plugin --profile <profile> add github:LingYun3241/dsh-space-approve#v1.1.6

# 本地开发：link 到本仓库（路径不能含空格）
dsh plugin --profile <profile> add "link:<本仓库绝对路径>"
```

安装后刷新页面（client bundle 生效）或重启 DSH。本包没有 `prepare`/`postinstall` 构建脚本，GitHub 安装不会触发 pnpm 的 `allowBuilds` 拦截。

## 调试

启动时打印一条 warn 级日志（DevTools 默认可见）：

```
[space-approve] ready { version: "1.1.6", mode: "dom+shortcuts", escape: true, cooldownMs: 0, at: … }
```

- `mode`：`dom` 表示只有主路径（兜底服务未就绪或不存在），`dom+shortcuts` 表示两条都在；
- 只有**真正应答**时才打 warn，其余决策（`no-panel` 等）需要 `dsh-space-approve:debug=1` 才打 info，避免每次空格都刷日志；
- **`editor-hidden` / `warming:<key>` 每个 key 只 warn 一次**（不刷屏），之后只进决策记录；这条 warn 就是"我按了为什么没反应"的可见线索；
- 决策记录在 `window.__dshSpaceApprove`（每次 apply 新建一个对象，卸载时只删自己的）：

```js
window.__dshSpaceApprove.boot        // { version, mode, escape, cooldownMs, at }
window.__dshSpaceApprove.inputs      // 最近 30 个 Space/Esc 按键事实（被守卫挡下的带 skip 原因）
window.__dshSpaceApprove.decisions   // 最近 30 次决策
```

`inputs` 的 `skip` 取值（与被挡下的原因一一对应）：

| `skip` | 含义 |
|---|---|
| `editable-target` | 按键落在输入框/contenteditable 里（你正在打字） |
| `editor-focused` | 焦点仍在编辑器里（事件目标不是编辑器） |
| `editor-hidden` | 编辑区已不可见且焦点已离开（卡片接管 composer） |
| `composing` / `composition-ended` | 输入法组字中 / 组字刚结束的那一下 |
| `ime` | `isComposing` 或 keyCode 229 |
| `repeat` | 按住键自动重复 |
| `modifier` | 带 Ctrl/Alt/Shift/Cmd |
| `not-page` / `modal` / `no-target` | 兜底路径的 region / 弹层 / 无目标 |

已被其它处理器 `preventDefault` 的按键**静默忽略、不记录**（避免把插件自己的 `preventDefault` 记成"被挡下"）。

原因码：

| 原因码 | 含义 |
|---|---|
| `answered` | 已语义应答 |
| `editor-hidden` | 你打字的那块编辑区已不可见且焦点已离开，Space 被拒绝（不批准，已 preventDefault 防滚动） |
| `warming:<key>` | 仅在 `cooldownMs > 0` 时：卡片刚出现，处于冷却期，按键未被消费 |
| `no-panel` / `no-panel:hidden` | 没有卡片 / 卡片存在但不可见（inert、display:none、零尺寸…） |
| `multi-panel:<n>` | 有 n 块卡片都匹配到待批请求（真分屏），放弃 |
| `no-pending:<key[,key]>` | 卡片可见但没有匹配的待批请求（残留 DOM / 已结算） |
| `other-modal` | 最上层弹层（dialog 或 menu）与该卡片无关 |
| `focus-in-card-control` | 焦点在卡片内按钮/链接、或卡片内警告徽标打开的悬浮卡里，交还原生 |
| `answer-failed` | 宿主没有 `answer()` 或应答抛错，拒绝回退点击 |
| `query-failed` | 卡片查询本身抛错（`querySelectorAll` 被拦截等），已降级为不应答 |

## 测试

```bash
node test/space-approve.test.mjs           # 207 项断言
node test/mutation.mjs                     # 选定 59 个变异，要求得分 ≥ 80%
node scripts/proof-composer-takeover.mjs   # v1.1.4 / v1.1.5 / 1.1.6 三段对照
```

全套共 **207 项断言**，全部通过。

测试 harness 加载真实的 `client.js`，并具备：**真实传播模型**（window→document→target 捕获/冒泡、`stopPropagation` 生效、记录 capture 标志）、把宿主 `shortcuts` 的 window 冒泡监听接进同一条派发链、可控时钟、`MutationObserver`（记录 `observe()` 的 options，并投递属性变更记录）、可延迟的 `ctx.inject`、`checkVisibility()` 的祖先语义、以及 `isConnected` 的增删维护。覆盖：两条输入路径、捕获优先级、双路径不重复应答、**打字惯性 2 秒 0 批准**（含"不派发 `focusout` 也拦住"）、点 composer 内部不算接管、点空白后回编辑器继续打字、Alt-Tab 视图不锁、编辑器被卸载仍锁、卡片内 autofocus 不解锁、`editor-hidden` 的消费与诊断、组字 `blur`/`visibilitychange` 复位、冷却期（可选时的 warming 语义 / 默认关闭时首按直通）、`[role="menu"]` 与 aria-modal 弹层、取最上层弹层、三种不可见形态、IME 组字状态机、`kind`/`answerable`/key 匹配、多面板按 pending 匹配、缺少 `answer()`、诊断 `inputs` 的 skip 原因与上限、属性后置与重挂载的时间戳、重复 apply 单实例与诊断归属、悬浮卡交还原生、版本一致性（`boot.version === package.json`）、engines 的 `includePrerelease` 语义与边界、README 断言数自校验。

`test/mutation.mjs` 会把项目复制到 `test/.mutants/`，逐个改坏一处安全机制再跑整套测试；判定要求
"失败数 > 0 且套件断言数不少于基线"，崩溃型运行单列为 `SUSPECT`（不计杀）；每个替换片段必须
**恰好命中一处**。当前**选定的 59 个变异全部被杀死（59/59）**。

> 这个数字的口径：变异集是**手工挑选**的，它只能说明"这些被钉住的行为确实有回归保护"，
> **不代表覆盖率，也不代表每条守卫都有回归保护**。已知没有回归保护的机制：`MAX_SEEN_KEYS` 剪枝、
> `isVisible` 在真实动画/离屏布局下的语义（`opacity` / `transform` / `content-visibility`）、真实中文
> IME 与死键、React 真实卸载/重挂载时序、`answer()` 落定前连按的时序。

`scripts/proof-composer-takeover.mjs` 只从 `git tag` 读 v1.1.4 / v1.1.5 的真实源码（找不到 tag 就报错，
不重建），跑同一场景做三段对照，并额外跑"无编辑器焦点 + 80ms 首按"的对照组。

## 已知限制

- 应用窗口本身未聚焦（切到别的 App）时，任何按键都送不进来——与 Claude Code / Codex 桌面版一致；
- **`editor-hidden` 的代价**：审批卡接管 composer 时（也就是你正在打字时弹出审批的那种情形），
  第一记空格会被故意忽略且不再滚页；轻点任意位置即可恢复，之后空格照常立即批准。这是防误批的
  确定性代价，不是 bug；`Esc` 在此期间仍然可用；
- `focusout` 在 `display:none` 时的浏览器行为**未在真机验证**（见上文"未验证的前提"），所以判据
  不依赖它；请在真机先确认那两个判据值；
- 分屏同时显示**两块都在待批**的卡片时不响应（宁可不动，也不批错会话）；只有一块匹配待批请求时会正常回答；
- 审批等待期间，`Esc` 不再触发"双击停止 agent"（agent 此时本就阻塞）；
- 焦点在卡片的详情滚动区（`[data-approval-scroll]`）时空格 = 允许一次（设计取舍，想滚动请用方向键/滚轮）；
- 卡片的警告徽标（rc.3 新增的 `ApprovalWarning`）打开后，其悬浮卡是 portal 到 `body` 的 `role="dialog"`
  （无 `aria-modal`），不在 `modalSelector` 内；本版通过卡片内 `aria-controls` 关联把它识别为
  "卡片内控件"，Space/Esc 交还原生。若宿主改了关联方式，会退化为"悬浮卡内按 Space/Esc 应答审批"，
  届时需要真机确认；
- `topModal()` 取"文档序最后一个可见弹层"，而宿主用**打开顺序栈**；两者在"DOM 顺序 ≠ 打开顺序"时不
  一致。本插件用它做保守判定（多判=不响应、少判=照常应答），已知是近似实现；
- 右键菜单的 Esc 关闭在宿主里是**死码**（`dsh-client-ui-context-menu` 的守卫写反），所以本版不会出现
  "一次 Esc 既关菜单又拒绝审批"。若将来宿主修好它并在 window 捕获阶段 `stopImmediatePropagation`，
  插件就收不到那个 Esc——安全方向；若有别的实现**不**阻断传播地关菜单，本插件仍会拒绝审批。
  该窗口未做额外防抖，属已知行为；
- `engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"` 对 `0.2.2-rc.3` **只在宿主传 `includePrerelease: true` 时成立**
  （`dsh-app-boot/src/plugin-compatibility.ts:52`）；普通 semver 规则下不匹配。宿主若去掉该选项，
  bundle 会被判不兼容并整条跳过；
- Shadow DOM 内的编辑器不会被识别（`event.target`/`activeElement` 被重定向到宿主元素），当前 DSH
  正常界面不使用 shadow 输入框；
- 不检查 `event.isTrusted`：页面内脚本本来就能直接调 `answer()`，所以这不是新增的安全边界；
- iframe 内的按键到不了主文档（不响应，符合预期）；
- 仅支持 DSH `0.2.x`，`0.3` 会因 `engines` 被跳过并提示。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-space-approve
```

或从 profile 的 `package.json`（`dependencies` 与 `dsh.profile.bundles`）移除后重启。

## License

MIT
