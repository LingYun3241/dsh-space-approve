# Changelog

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
