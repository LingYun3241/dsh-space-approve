# Changelog

## 1.1.6 — 2026-11-16

安全修复版：把 P0（打字惯性误批）的判据从"时间窗"换成"确定性复查"，并修 1.1.5 引入的静默失效路径。
无 API / 安装方式变化。

- **P0 真修复（替换 1.1.5 的 300ms 缓解）**。1.1.5 的 300ms 冷却只挡下第一记空格：实测卡片接管
  composer 后 `+300ms` 的下一记空格就批准（`scripts/proof-composer-takeover.mjs` 的
  `+300ms:answered` 一步自证）。1.1.6 改为**按键时动态复查**：记录最近获得焦点的可编辑根节点，
  按键时若"它仍在文档里、`activeElement` 已离开它、且它已不可见（`display:none`/`inert`/零尺寸…）"，
  且用户没有重新接管 UI，则 Space 返回 `editor-hidden`：**不批准**、`preventDefault()`（焦点在
  `<body>`，防滚动）、**不** `stopPropagation()`。判据不依赖 `focusout` 事件、不依赖计时器；
  点任意位置、聚焦卡片外控件、或重新点回编辑器即恢复。
- **冷却期降级为可选项，默认关闭**（`DEFAULT_COOLDOWN_MS = 0`）。`warming:<key>` 只在
  `localStorage["dsh-space-approve:cooldownMs"] > 0` 时出现；同时修掉"无时间戳卡片在
  `cooldownMs=0` 时仍被懒记录拒绝"的分支（否则主卖点的第一按会被吃）。
- **P1 落单组字自愈**：`window.blur` 与 `visibilitychange === "hidden"` 复位
  `composing`/`compositionEnded`（宿主自己的 `observeComposition` 也有这两个复位点）。此前一次
  落单的 `compositionstart` 会让 Space 和 Esc 永久失效且诊断零留痕。
- **P1 冷却被重置**：`MutationObserver` 增加
  `attributes: true, attributeFilter: ["data-approval-key"]`（属性后置也能记时）；
  `forget()` 只在 pending 真的消失（`pendingFor()` 为 null）时才删时间戳，同一 key 的 DOM 重挂载
  不再重置冷却。
- **P1 按了没反应可查**：`editor-hidden` / `warming:<key>` 每个 key **只 warn 一次**（上限 32 条），
  不再完全静默；README「安全边界」写明代价与恢复方式。
- **诊断 `inputs` 重做**：记录每个被守卫挡下的 Space/Esc 及 `skip` 原因
  （`repeat | ime | composing | composition-ended | modifier | editable-target | editor-focused |
  editor-hidden | not-page | modal | no-target`），并挪到每次决策之后写入，**一个物理按键严格一条**；
  已被其它处理器 `preventDefault` 的按键静默忽略，避免自污染（否则 editor-hidden 的 `preventDefault`
  会在兜底路径留下第二条记录）。
- **单实例 / 诊断归属**：每次 `apply` 新建 `{boot, inputs, decisions}`，不再复用页面全局对象；
  apply 开头先拆掉上一个实例（`window.__dshSpaceApproveTeardown`），卸载只删自己的。重复 apply
  不再叠加 `document` keydown / fixed-input 监听器，也不会删掉存活实例的诊断。
- **P2-9 rc.3 `ApprovalWarning` 悬浮卡**：焦点在该 portal 的 `role="dialog"`（无 `aria-modal`）内、
  且其 `id` 能被卡片内某个 `aria-controls` 触发元素引用时，视为卡片内控件（`focus-in-card-control`），
  Space/Esc 交还原生。`MODAL` 选择器未变。
- **引擎兼容**：`engines.dsh` 未变，但 README/发布说明写明它依赖宿主传
  `{ includePrerelease: true }`（`dsh-app-boot/src/plugin-compatibility.ts:52`）；测试新增用同一语义
  的断言（默认 semver 规则下 `0.2.2-rc.3` 不匹配）。
- **测试：149 → 207 项断言**。新增：两秒打字惯性 0 批准、无 `focusout` 也拦住、点 composer 内部不算
  接管、点空白后回编辑器继续打字、无编辑器焦点 80ms 首按立即批准、点空白后首按仍批准、Alt-Tab
  视图（编辑器仍可见）不锁、编辑器被卸载仍锁、卡片内 autofocus 不解锁、`Esc` 在守卫下仍可拒绝、
  组字 `blur`/`visibilitychange` 复位、属性后置记时、重挂载保留时间戳、无 observation 时 `cooldownMs=0`
  首按放行、诊断 `inputs` 的 skip 原因与上限、重复 apply 单实例与诊断归属、悬浮卡交还原生、
  engines 的 `includePrerelease` 语义与边界。修掉 1.1.5 的两条同义反复断言（`C3 bundle id`
  实际没比包名、`B35 inputs 为空`在从不记录时恒真），`A12` 的 inert 用例改由 inert 单独驱动。
- **变异检查 `test/mutation.mjs`**：选定 **59 个变异全部被杀（59/59）**；判定改为
  `status !== 0 && failed > 0 && total >= baseline`，崩溃型运行单列 `SUSPECT`（不计杀）；
  每个 `find` 必须**恰好命中一处**，否则脚本直接报错。该集合是手工挑选的，**不代表覆盖率**，
  也不代表"每条守卫都有回归保护"。
- **`scripts/proof-composer-takeover.mjs`**：改为 v1.1.4 / v1.1.5 / 1.1.6 三段对照，
  前两段源码只从 `git tag` 读取（删除了"删掉冷却行重建"的回退，避免造出假结论），并新增
  "无编辑器焦点 + 80ms 首按"的对照组。

## 1.1.5 — 2026-11-16

> **勘误（1.1.6）**：本段把 300ms 冷却期称为"P0 修复"，与实测不符。它只挡下卡片出现后的第一记
> 空格，`+300ms` 的下一记空格仍会批准（详见 1.1.6 段与 `scripts/proof-composer-takeover.mjs`）。
> 1.1.5 应理解为**缓解**，真正的修复在 1.1.6。以下保留 1.1.5 的原始记录。

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
  当前 **37/37 被杀死**（整改前为 9/26 ≈ 35%）。
  〔1.1.6 更正〕这是**手工挑选**的 37 个变异全部被杀，不是覆盖率，也不代表"每条守卫都有回归保护"；
  1.1.6 已扩到 59 个，并把判定改为"失败数 > 0 且套件断言数不少于基线"。
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
- 新增诊断：最近 30 次按键事实与决策记录在 `window.__dshSpaceApprove`（DevTools 可读）。
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
