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
| 输入法组字中，以及组字刚结束的那一下（`isComposing` / keyCode 229 / `compositionstart` / `compositionend`） | 不处理（WebKit 上 `isComposing` 不可靠，官方卡片也为此维护状态） |
| 按住键自动重复（`repeat`） | 只认第一次，不连批 |
| Ctrl / Alt / Shift / Cmd + 键 | 不处理 |
| 有无关的弹层打开（`[role="dialog"][aria-modal="true"]`，以及**右键菜单 / 下拉菜单**这类 `[role="menu"]`） | 不处理（选择器与宿主 `modalSelector` 完全对齐；取最上层、忽略不可见的挂载节点） |
| **审批卡刚出现后的 300ms 内（冷却期）** | 空格**不响应、也不吞键**；等过了冷却期再按即可。Esc 不受冷却期影响 |
| 焦点在**卡片内**的按钮 / 链接上 | 交给原生激活（聚焦「拒绝」按空格仍是拒绝） |
| 没有待批请求 / 卡片已撤销但 DOM 残留 | 不处理（不吞键、不 preventDefault） |
| 屏幕上有多个可见审批卡 | 只回答**唯一能匹配到待批请求**的那一块；两块都匹配（真分屏）则不处理，避免批错会话 |
| 卡片被 `inert` / `display:none` / `visibility:hidden` / 零尺寸隐藏 | 不处理 |
| 卡片带「始终允许」 | 只应答 `allowed-once`，**绝不持久授权** |
| 宿主没有暴露 `answer()` | 拒绝应答（`answer-failed`），**绝不按位置点按钮** |
| 官方 `Enter` / `Esc` 已经处理过（`defaultPrevented`） | 不重复应答 |

除此之外：没有自动批准、没有超时默认值、没有网络请求、没有凭据访问；卸载或热更新时注销监听并清掉 `window.__dshSpaceApprove`。

> 冷却期是为一个真实缺陷加的：审批卡接管 `conversation.composer` 时，官方渲染器会把原 composer（含正在聚焦的编辑器）包进 `display:none`，浏览器让编辑器失焦、`document.activeElement` 回落到 `<body>`，于是“打字中的空格”会绕过输入框守卫变成一次批准。现在卡片出现后 300ms 内的空格按“冷却中（`warming:<key>`）”处理。

## 输入路径

两条路径同时工作，**捕获阶段优先**：

1. **主路径**：`document` 的 **capture** 阶段 `keydown` 监听。它比“当前焦点控件自己的处理器”更早执行，因此即使你刚点过的侧栏按钮对空格调用了 `preventDefault()`，也不会把批准吞掉。应答后立即 `preventDefault()` + `stopPropagation()`。
2. **兜底路径**：DSH 官方快捷键服务 `shortcuts.observeFixedInput()`（通过 `ctx.inject(["shortcuts"], …)` 等待服务就绪，不再与启动竞态；老宿主没有 `ctx.inject` 时退回 `ctx.get` 并打一条一次性 warning）。宿主返回归一化的 `{ gesture: { code, repeat, composing, defaultPrevented }, context: { region, modal, target }, consume() }`，覆盖 IME、死键、AltGraph、重复键与 modal 追踪。

宿主在 **window 冒泡阶段**分发兜底输入；主路径在 `document` 捕获阶段应答后 `stopPropagation()`，事件根本到不了 window，因此同一物理按键只会应答一次（这一点由测试用真实传播模型验证，不再靠 `answerable=false` 的同义反复）。

业务判断只有一套：找到可见的 `[data-approval-key]` 卡片 → 匹配 `uiSession.sessionStatus` 中 `kind === "approval"`、`answerable !== false` 的 pending 请求 → `answer("allowed-once" | "rejected")`。

## 工作方式

1. 取所有 `[data-approval-key]` 卡片，按可见性过滤（`checkVisibility()` / computed style / `getClientRects` / `[inert]`）；
2. 对每块可见卡片，用它的 key 在 `uiSession.sessionStatus` 里找 `kind === "approval"`、`answerable !== false` 的待批请求；
3. 恰好一块匹配 → 检查它是否被无关弹层压住；两块以上匹配 → 放弃（`multi-panel:<n>`）；
4. 空格还要过冷却期：卡片 key 首次可见的时间来自 `MutationObserver`，距今 `< 300ms` 时返回 `warming:<key>`，**不消费按键**；
5. 调用该请求的 `answer(...)` —— 语义级应答，不点按钮；
6. 应答成功后 `preventDefault()`（主路径再加 `stopPropagation()`）或 `consume()`（兜底路径），阻止按键继续触发别的动作（包括焦点所在的侧栏按钮）。

依赖 DSH Web 的运行态语义（`uiSession.sessionStatus` / pending interaction），对应 DSH `0.2.x`（当前安装的 `0.2.2-rc.3` 上核对过宿主实现，`0.2.2-rc.1` 上真机验证过）。

## 配置

**client 半身读不到 profile 的 `config`**：宿主创建 bundle entry 时只传 `{ name }`（见 `dsh-client-modules`），`apply(ctx, config)` 收到的 `config` 是 `undefined`；`cordis.patch.yml` 里的 `config` 只作用于 host 半身（本插件的 host 半身没有行为）。因此开关放在页面可读的 `localStorage` 里：

```js
// 关掉 Esc（只保留空格 = 允许一次）
localStorage.setItem("dsh-space-approve:escape", "false");

// 关掉卡片冷却期（0 = 关闭；默认 300 毫秒）
localStorage.setItem("dsh-space-approve:cooldownMs", "0");

// 调试日志
localStorage.setItem("dsh-space-approve:debug", "1");
```

删除对应键即恢复默认。若宿主将来真的把 `config` 传给 client 半身，`config.escape` / `config.cooldownMs` 也会被读取，但 `localStorage` 优先。

## 安装

```bash
# 从 GitHub（<profile> 换成 desktop / web）
dsh plugin --profile <profile> add github:LingYun3241/dsh-space-approve

# 本地开发：link 到本仓库（路径不能含空格）
dsh plugin --profile <profile> add "link:<本仓库绝对路径>"
```

安装后刷新页面（client bundle 生效）或重启 DSH。本包没有 `prepare`/`postinstall` 构建脚本，GitHub 安装不会触发 pnpm 的 `allowBuilds` 拦截。

## 调试

启动时打印一条 warn 级日志（DevTools 默认可见）：

```
[space-approve] ready { version: "1.1.5", mode: "dom+shortcuts", escape: true, cooldownMs: 300, at: … }
```

- `mode`：`dom` 表示只有主路径（兜底服务未就绪或不存在），`dom+shortcuts` 表示两条都在；
- 只有**真正应答**（`answered`）时才打 warn，其余决策（`no-panel` 等）需要 `dsh-space-approve:debug=1` 才打 info，避免每次空格都刷日志；
- 决策记录在 `window.__dshSpaceApprove`（卸载时删除）：

```js
window.__dshSpaceApprove.boot        // { version, mode, escape, cooldownMs, at }
window.__dshSpaceApprove.inputs      // 最近 30 次“候选按键”（已通过输入框/IME/组合键守卫）
window.__dshSpaceApprove.decisions   // 最近 30 次决策
```

原因码：

| 原因码 | 含义 |
|---|---|
| `answered` | 已语义应答 |
| `warming:<key>` | 卡片刚出现，处于冷却期，按键未被消费 |
| `no-panel` / `no-panel:hidden` | 没有卡片 / 卡片存在但不可见（inert、display:none、零尺寸…） |
| `multi-panel:<n>` | 有 n 块卡片都匹配到待批请求（真分屏），放弃 |
| `no-pending:<key[,key]>` | 卡片可见但没有匹配的待批请求（残留 DOM / 已结算） |
| `other-modal` | 最上层弹层（dialog 或 menu）与该卡片无关 |
| `focus-in-card-control` | 焦点在卡片内按钮/链接上，交还原生 |
| `answer-failed` | 宿主没有 `answer()` 或应答抛错，拒绝回退点击 |

## 测试

```bash
node test/space-approve.test.mjs     # 149 项断言
node test/mutation.mjs               # 37 个变异，要求得分 ≥ 80%
node scripts/proof-composer-takeover.mjs   # P0 修复前/后对照
```

全套共 **149 项断言**，全部通过。

测试 harness 加载真实的 `client.js`，并具备：**真实传播模型**（window→document→target 捕获/冒泡、`stopPropagation` 生效、记录 capture 标志）、把宿主 `shortcuts` 的 window 冒泡监听接进同一条派发链、可控时钟、`MutationObserver`、可延迟的 `ctx.inject`。覆盖：两条输入路径、捕获优先级、双路径不重复应答、冷却期（<300ms 不答 / 过期答 / 长时间后首次按键直接答）、`[role="menu"]` 与 aria-modal 弹层、取最上层弹层、三种不可见形态、IME 组字状态机、`kind`/`answerable`/key 匹配、多面板按 pending 匹配、缺少 `answer()`、诊断上限与卸载清理、版本一致性（`boot.version === package.json`）与 README 断言数自校验。

`test/mutation.mjs` 会把项目复制到 `test/.mutants/`，逐个改坏一处安全机制再跑整套测试；当前 **37/37（100%）被杀死**，即每条守卫都有回归保护。`scripts/proof-composer-takeover.mjs` 用 `git show v1.1.4:client.js` 跑修复前代码作对照：修复前空格直接 `allowed-once`，修复后输出 `warming:approval:7`，300ms 后再按才是 `allowed-once`。

## 已知限制

- 应用窗口本身未聚焦（切到别的 App）时，任何按键都送不进来——与 Claude Code / Codex 桌面版一致；
- 分屏同时显示**两块都在待批**的卡片时不响应（宁可不动，也不批错会话）；只有一块匹配待批请求时会正常回答；
- 审批等待期间，`Esc` 不再触发“双击停止 agent”（agent 此时本就阻塞）；
- 焦点在卡片的详情滚动区（`[data-approval-scroll]`）时空格 = 允许一次（设计取舍，想滚动请用方向键/滚轮）；
- Shadow DOM 内的编辑器不会被识别（`event.target`/`activeElement` 被重定向到宿主元素），当前 DSH 正常界面不使用 shadow 输入框；
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
