# Changelog

## 1.1.5 — 2026-11-16

安全修复版（对抗性审查后的整改）。无 API/安装方式变化。

- **P0 修复：打字中的空格会误批特权命令**。审批卡接管 `conversation.composer` 时，官方渲染器把原
  composer（含正在聚焦的编辑器）包进 `display:none`，浏览器让编辑器失焦、`document.activeElement`
  回落到 `<body>`，两个“是否在打字”的守卫同时失效 → 空格 = `allowed-once`。
  现在为每块卡片记录**首次可见时间**（`MutationObserver`，卡片出现在任意时刻都准确，不是“第一次按键才记”），
  距今 `< cooldownMs`（默认 300，可用 `config.cooldownMs` 或 `localStorage["dsh-space-approve:cooldownMs"]` 调整）
  时返回原因码 `warming:<key>`，**不消费按键**，再按一次即可；Esc 不受冷却期影响。
- **P1 修复：`MODAL` 与宿主 `modalSelector` 不一致**。选择器改为
  `[role="dialog"][aria-modal="true"], [role="menu"]`，取**最上层**可见弹层（不是文档序第一个），
  并过滤不可见的挂载节点。右键菜单/下拉菜单打开时不再批准，也不会再被 `display:none` 的弹层永久压住。
- **P1 修复：DOM 主路径缺少“组字结束”守卫**。照抄官方卡片的 `composing` / `compositionEnded`
  状态机（`compositionstart` / `compositionend` / `keyup` 捕获监听），WebKit 上“空格选词”不再可能变成批准。
- **P2 修复：`config.escape:false` 送不到 client 半身**。已确认宿主创建 bundle entry 只传 `{ name }`，
  `apply(ctx, config)` 的 `config` 恒为 `undefined`。改用页面可读的 `localStorage`
  （`escape` / `cooldownMs` / `debug`）；README 的配置章节按实际行为重写。
- **P2 修复：`shortcuts` 启动竞态**。改用官方写法 `ctx.inject(["shortcuts"], scope => scope.effect(...))`
  等待服务就绪；老宿主没有 `ctx.inject` 时退回 `ctx.get` 并在缺失时打一条一次性 warning。
- **P2 修复：删除按位置点按钮的兜底**（`clickDecision`/`decisionButtons`）。没有 `answer()` 时直接
  `answer-failed`，兑现“绝不点按钮、绝不持久授权”的承诺。
- **P2 修复：`isVisible` 放宽**。去掉 `checkOpacity`（淡入动画期间不再误判 `no-panel`），保留
  display/visibility/零尺寸/`[inert]`；原因码细分 `no-panel` / `no-panel:hidden`。
- **P2 修复：分屏/动画重叠静默失效**。多块可见卡片时先按“key 是否真有匹配的待批请求”筛选：
  只有一块匹配就回答它（残留卡片不再挡住真的待批卡），两块都匹配才 `multi-panel:<n>` 放弃。
- **P2 修复：版本号漂移**。`client.js` 的 `boot.version` 改为单一 `VERSION` 常量并与
  `package.json` 对齐，测试新增版本一致性断言，README 的断言数量也由测试反向校验。
- **P2 修复：卸载清理**。disposer 里删除 `window.__dshSpaceApprove`，不再跨热更新泄漏。
- **P3**：非应答按键不再无条件 `console.warn`（改为仅应答时 warn、调试开关下 info）；诊断 `inputs`
  只记录通过输入守卫的候选按键；`[role="combobox"]` 只保留在 EDITABLE 一处；兜底路径补
  `context.target === null` 守卫；README 注明 Shadow DOM / `isTrusted` 的边界。
- **测试重写：57 → 149 项断言**。新 harness 具备真实传播模型（capture 顺序、`stopPropagation`
  生效、记录 capture 标志）、接到同一条派发链上的宿主 `shortcuts`（window 冒泡）、可控时钟、
  `MutationObserver` 与可延迟的 `ctx.inject`。修复了原 A12（inert 实际走 multi-panel）、C1、C2 三条假阳性。
- **新增变异检查 `test/mutation.mjs`**：37 个针对性变异（审查报告的 26 个 + 冷却期/传播/监控等），
  当前 **37/37 = 100% 被杀死**（整改前为 9/26 ≈ 35%）。
- **新增 `scripts/proof-composer-takeover.mjs`**：用 `git show v1.1.4:client.js` 跑修复前代码作对照，
  修复前空格直接 `allowed-once`，修复后输出 `warming:approval:7`，300ms 后再按才是 `allowed-once`。

## 1.1.4 — 2026-11-13

- **修复：插件整体不加载**。1.1.1 起用 PowerShell 改写 `package.json` 时写入了 UTF-8 BOM，
  宿主 `JSON.parse` 直接失败，bundle 行加载失败 → 没有任何监听器，空格和 Esc 一起失灵，
  控制台也没有插件日志。已去掉 BOM；并新增 8 项 manifest 卫生检查（BOM / JSON 可解析 /
  `dsh.bundle` / `dsh.client` / patch 文件存在）防止复发。
- 测试总数 57 项。

## 1.1.3 — 2026-11-13

- 启动日志与按键决策日志改为 `warn` 级别：Info 级别会被 DevTools 的级别过滤器隐藏
  （控制台显示 “2 hidden”），看起来像插件完全静默。

## 1.1.2 — 2026-11-13

- 把静默失败改成可诊断：启动日志（版本 / 输入路径 / Esc 开关）、每次空格/Esc 的决策日志、
  以及原因码（`no-panel` / `multi-panel:<n>` / `no-pending:<key>` / `other-modal` /
  `focus-in-card-control` / `answer-failed` / `answered`），同一份数据也留在
  `window.__dshSpaceApprove`。

## 1.1.1 — 2026-11-13

- **修复：空格在“切回会话后”失灵**。原因是我们改到宿主 `window` 冒泡阶段后排在了焦点控件自己的
  处理器之后，对方对空格调用 `preventDefault()` 会让宿主把按键标记为已处理，插件按设计跳过。
  现在恢复 `document` **捕获阶段**监听为主路径（抢在控件之前），官方 `observeFixedInput` 作为兜底；
  应答后 `stopPropagation()`，两条路径不会重复应答。
- 新增诊断：最近 20 次按键事实与决策记录在 `window.__dshSpaceApprove`（DevTools 可读）。
- 测试 49 项（新增捕获阶段优先级、双路径不重复应答）。

## 1.1.0 — 2026-11-13

- **不需要先点卡片**：改用 DSH 官方快捷键服务 `ctx.shortcuts.observeFixedInput()`，
  按键不再依赖审批卡片的 DOM 焦点。从其他会话切回来、焦点停在侧栏时，直接按即可。
- **新增 Esc = 拒绝**（可用 `config.escape: false` 关闭）。
- 宿主缺失 `shortcuts` 服务时自动降级为 `document` keydown 监听，行为一致。
- IME、死键、AltGraph、按键重复、modal 追踪改由宿主判定。
- 焦点在卡片内的按钮上时，按键交还原生行为（聚焦「拒绝」按空格仍是拒绝）。
- 无关键重复应答：官方已处理（`defaultPrevented`）的按键不会被二次应答。
- 测试从 33 项扩展到 45 项，覆盖两条输入路径。

## 1.0.1 — 2026-11-13

- 语义应答失败（`answer()` 抛错）时不再回退点击按钮，避免二次应答。
- 新增 7 项测试：双次空格、多会话匹配、contenteditable、链接聚焦、缺少服务降级、应答抛错/拒绝。

## 1.0.0 — 2026-11-13

- 首个版本：空格 = 允许一次（`allowed-once`），语义应答、不点按钮。
- 打字安全：文本框、contenteditable、IME、重复键、组合键全部放行。
- 只应答唯一可见且 key 匹配的待批审批；隐藏/inert/多面板/残留 DOM 一律不动作。
- 26 项离线断言。
