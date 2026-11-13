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
| 输入法组字中（`isComposing` / keyCode 229 / 死键 / AltGraph） | 不处理 |
| 按住键自动重复（`repeat`） | 只认第一次，不连批 |
| Ctrl / Alt / Shift / Cmd + 键 | 不处理 |
| 有无关的 modal 弹层打开 | 不处理 |
| 焦点在**卡片内**的按钮 / 链接上 | 交给原生激活（聚焦「拒绝」按空格仍是拒绝） |
| 没有待批请求 / 卡片已撤销但 DOM 残留 | 不处理 |
| 屏幕上有多个可见审批卡（分屏） | 不处理，避免批错会话 |
| 卡片被 `inert` / `display:none` / `visibility:hidden` 隐藏 | 不处理 |
| 卡片带「始终允许」 | 只应答 `allowed-once`，**绝不持久授权** |
| 官方 `Enter` / `Esc` 已经处理过（`defaultPrevented`） | 不重复应答 |

除此之外：没有自动批准、没有超时默认值、没有网络请求、没有凭据访问；卸载或热更新时注销监听。

## 输入路径

两条路径同时工作，**捕获阶段优先**：

1. **主路径**：`document` 的 **capture** 阶段 `keydown` 监听。它比“当前焦点控件自己的处理器”更早执行，因此即使你刚点过的侧栏按钮对空格调用了 `preventDefault()`，也不会把批准吞掉。应答后立即 `preventDefault()` + `stopPropagation()`。
2. **兜底路径**：DSH 官方快捷键服务 `ctx.shortcuts.observeFixedInput()`。宿主返回归一化的 `{ gesture: { code, repeats, composing, defaultPrevented }, context: { region, modal }, consume() }`，覆盖 IME、死键、AltGraph、重复键与 modal 追踪。主路径已应答的按键会因 `stopPropagation` 到不了这里，因此不会重复应答。

业务判断只有一套：找到**唯一可见**的待批卡片 → 匹配 `uiSession.sessionStatus` 中的 pending 请求 → `answer("allowed-once" | "rejected")`。

> 早期 1.0.x 只监听 DOM，空格可用但有焦点守卫；1.1.0 只走官方通道，会在“焦点控件的处理器先吞掉空格”时失效；1.1.1 起两者并存、捕获优先。

## 工作方式

1. 取 `[data-approval-key]` 面板（必须有且只有一个可见）；
2. 用面板的 key 在 `uiSession.sessionStatus` 中找 `kind === "approval"`、`answerable` 的待处理请求；
3. 调用该请求的 `answer(...)`——语义级应答，不点按钮；
4. `consume()` 阻止按键继续触发别的动作（包括焦点所在的侧栏按钮）。

依赖 DSH Web 的运行态语义（`uiSession.sessionStatus` / pending interaction），对应 DSH `0.2.x`（在 `0.2.2-rc.1` 上实测）。

## 配置

默认 `Space` = 允许一次、`Esc` = 拒绝。只想保留空格时，在 profile 的 `cordis.patch.yml` 里关掉 Esc：

```yaml
- id: dsh-space-approve
  config:
    escape: false
```

## 安装

```bash
# 从 GitHub（<profile> 换成 desktop / web）
dsh plugin --profile <profile> add github:LingYun3241/dsh-space-approve

# 本地开发：link 到本仓库（路径不能含空格）
dsh plugin --profile <profile> add "link:<本仓库绝对路径>"
```

安装后刷新页面（client bundle 生效）或重启 DSH。本包没有 `prepare`/`postinstall` 构建脚本，GitHub 安装不会触发 pnpm 的 `allowBuilds` 拦截。

## 调试

```js
localStorage.setItem("dsh-space-approve:debug", "1");
```

开启后打印 `[space-approve]` 日志：激活的输入路径、每次应答、配置状态。

## 测试

```bash
node test/space-approve.test.mjs
```

自带最小 DOM harness，加载真实的 `client.js`，覆盖两条输入路径（官方 `observeFixedInput` 与 DOM 降级），共 **45 项断言**：可见待批请求、文本框/contenteditable、聚焦卡片内按钮、聚焦侧栏按钮（本次修复的核心场景）、IME、重复键、修饰键、无关 modal、多面板歧义、隐藏/inert 面板、三按钮「始终允许」卡片、`answer()` 抛错/拒绝、缺少 `uiSession`、卸载清理。

## 已知限制

- 应用窗口本身未聚焦（切到别的 App）时，任何按键都送不进来——与 Claude Code / Codex 桌面版一致；
- 分屏同时显示多个审批卡时不响应（宁可不动，也不批错会话）；
- 审批等待期间，`Esc` 不再触发“双击停止 agent”（agent 此时本就阻塞）；
- 仅支持 DSH `0.2.x`，`0.3` 会因 `engines` 被跳过并提示。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-space-approve
```

或从 profile 的 `package.json`（`dependencies` 与 `dsh.profile.bundles`）移除后重启。

## License

MIT
