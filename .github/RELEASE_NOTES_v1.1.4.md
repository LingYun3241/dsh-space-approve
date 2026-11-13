# dsh-space-approve v1.1.4 — 按空格批准，按 Esc 拒绝，无需点击

**TL;DR / 一句话**：DSH 审批弹窗出现后，不用先点卡片——直接按 **空格** = 允许一次，按 **Esc** = 拒绝；打字、输入法、焦点在别处都不会误批。

---

## 它解决什么问题

DSH 自带的审批卡把按键处理器绑在卡片内部，且要求焦点已在卡片内（`currentTarget.contains(document.activeElement)`），卡片出现时又不会自动聚焦。结果是从别的会话切回来、或焦点停在侧栏时，`Enter` / `Esc` 完全无反应，必须先用鼠标点一下卡片。Claude Code Desktop 与 Codex App 都是窗口级快捷键，这里补的就是同一层体验。

## 使用方式

| 按键 | 行为 |
|---|---|
| `Space` | 允许一次（语义应答 `allowed-once`，与官方 Enter 同义） |
| `Esc` | 拒绝（`rejected`） |

两条都**不依赖焦点位置**：切会话、焦点停在侧栏按钮、正在阅读审批详情时都能直接按。

## 安全设计

- **语义应答，不点按钮**：直接调用待批请求的 `answer(...)`，绝不点"最后一个按钮"——即使卡片带「始终允许」，空格也只会允许一次；
- **打字安全**：焦点/事件在输入框、textarea、contenteditable（`region === "editable"`）时按键原样放行；
- **输入法安全**：组字中（`isComposing` / keyCode 229）、死键、AltGraph 不处理；
- **按键纪律**：长按只认第一次；Ctrl/Alt/Shift/Cmd 组合键不处理；
- **只答真正待批的那一个**：屏幕上必须恰好有一块可见 `[data-approval-key]`，且与 `uiSession.sessionStatus` 中的待处理请求 key 匹配；隐藏/inert 面板、DOM 残留、分屏多面板一律不动；
- **不重复应答**：官方已处理（`defaultPrevented`）的按键直接跳过；
- **无网络、无凭据、无自动批准**；卸载即清理。

## 输入路径（1.1.4 定稿）

1. **主路径**：`document` **捕获阶段** keydown——抢在焦点控件自己的处理器之前（后者可能对空格调 `preventDefault()` 把批准吞掉）；
2. **兜底**：官方快捷键服务 `ctx.shortcuts.observeFixedInput()`（宿主归一化 IME/死键/repeat/modal）；
3. 应答后 `stopPropagation()`，两条路径永不重复。

## 可诊断性

- 启动日志：`[space-approve] ready {version, mode, escape}`（warn 级别，DevTools 默认可见）；
- 每次空格/Esc 的决策日志带原因码：`answered` / `no-panel` / `multi-panel:n` / `no-pending:key` / `other-modal` / `focus-in-card-control` / `answer-failed`；
- 同一份数据保留在 `window.__dshSpaceApprove`，DevTools 一眼可读。

## 安装

```bash
# GitHub（钉住版本）
dsh plugin --profile <desktop|web> add github:LingYun3241/dsh-space-approve#v1.1.4

# 或最新 main
dsh plugin --profile <desktop|web> add github:LingYun3241/dsh-space-approve
```

安装后刷新页面即可（无构建脚本，不触发 `allowBuilds`）。只想保留空格时：

```yaml
# profile 的 cordis.patch.yml
- id: dsh-space-approve
  config:
    escape: false
```

## 验证

- **57 项离线断言**（`test/space-approve.test.mjs`）：覆盖两条输入路径、捕获优先级、双路径不重复、manifest 卫生（BOM/JSON/结构）等，CI 全绿；
- **真机验证**：DSH `0.2.2-rc.1` 桌面端，切会话后不点卡片直接按空格/Esc 均生效；
- 兼容：`dsh.engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"`。

## 版本历程（都是真实踩坑）

- **1.1.1** 捕获阶段修复：挂在宿主 window 冒泡阶段时，焦点控件的 `preventDefault()` 会吞掉空格；
- **1.1.2** 失败大声化：静默 `try/catch` 让按键失灵无从排查，改为原因码 + 决策日志；
- **1.1.3** 日志级别 warn：Info 级会被 DevTools 过滤器隐藏，看起来像"插件死了"；
- **1.1.4** 修复 manifest BOM：PowerShell 写文件带入 UTF-8 BOM 使宿主 `JSON.parse` 失败、整个 bundle 不加载——已加 8 项 manifest 卫生检查防复发。

详见 [CHANGELOG.md](https://github.com/LingYun3241/dsh-space-approve/blob/main/CHANGELOG.md)。

## 已知限制

- 应用窗口本身未聚焦（切到别的 App）时按键送不进来——与 Claude Code / Codex 桌面版一致；
- 分屏同时显示多块审批卡时不响应（宁可不动，不批错会话）；
- 审批等待期间 `Esc` 不再触发"双击停止 agent"（agent 此时本就阻塞）；
- 仅支持 DSH `0.2.x`。

## License

MIT
