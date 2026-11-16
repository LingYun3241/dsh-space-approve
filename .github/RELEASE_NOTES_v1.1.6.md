# dsh-space-approve v1.1.6 — 打字中的空格不再误批（1.1.5 的 300ms 只是缓解）

> **勘误（对 v1.1.5）**：1.1.5 的标题写「打字中的空格不会再误批」，与实测不符。
> 卡片接管 composer 后，300ms 冷却期只挡下第一记空格，**+300ms 的下一记空格就批准**了
> （`scripts/proof-composer-takeover.mjs` 的 `+300ms:answered` 一步自证）。1.1.6 用确定性判据
> 替换时间窗，并把冷却期默认关掉。1.1.5 的发布说明保留原文，仅在上方加勘误指向本版。

**TL;DR**：空格是否"在批准"不再由时间判断，而由**你打字的那块编辑区是不是真的不可见了**判断。
卡片接管 composer 后，编辑器被 `display:none` 藏起来、焦点回落到 `<body>`；此时空格一律
`editor-hidden` 拒绝应答（不批准、吞掉按键以免滚动页面、但不 `stopPropagation`）。判据在每次按键时
重新计算、不依赖 `focusout` 事件、不依赖计时器；**点一下任意位置**或重新聚焦编辑器即恢复。
没有编辑器失焦时，第一记空格**立即**批准（默认不再有 300ms 等待）。

---

## 三个版本对照（`node scripts/proof-composer-takeover.mjs` 实跑）

同一个"打字中卡片接管 composer"场景，连打 8 记空格（+120ms 到 +2100ms）：

```
A1. v1.1.4   +120ms:answered/CONSUMED   → 第一记就批准（原始 P0）
A2. v1.1.5   +120ms:warming             → 只挡下第一记
             +300ms:answered/CONSUMED   → 第二记批准（冷却期只是延缓，不是修复）
A3. 1.1.6    +120ms … +2100ms 全部 editor-hidden/CONSUMED，outcomes: []
```

对照场景（**没有**编辑器被隐藏，卡片出现后 +80ms 按键）：

```
B1. v1.1.5   warming:approval:7           → 按了没反应（主卖点被冷却期吃掉）
B2. 1.1.6    answered ["allowed-once"]    → 立即批准
```

---

## 为什么 300ms 一定不够

正常输入里一个空格大约每 5~6 个字符出现一次（40 WPM ≈ 800ms/空格）。卡片落下的时刻相对打字节奏的
相位是随机的：冷却期只覆盖"卡片出现后 300ms 内的那一记"，而人类的常态节奏（400~1200ms/空格）恰好
全部落在危险区；实测最坏相位（+400ms）第一记就批准。反过来，同一个冷却期还会在**主卖点场景**
（焦点在侧栏、用户看着卡片按空格）里静默拒绝第一记。所以 1.1.6 换掉了判据本身。

## 机制（P0）

**判据（`hiddenEditorLost()`，每次按键现算，无计时器）**

```
!engaged && lastEditable && document.activeElement !== lastEditable && !isVisible(lastEditable)
```

- `lastEditable`：最近一次获得焦点、且位于编辑器（`input/textarea/select/contenteditable`…）里的元素，
  统一规范到可编辑根节点（contenteditable 的按键来自内部 `span/p`，不能记子节点）；
- `!isVisible(lastEditable)`：`checkVisibility()` + computed style + `getClientRects` + `[inert]`，
  也就是"这块编辑区真的不可见了"。**不用 `relatedTarget === null`**：Alt-Tab、点空白都会让 `relatedTarget`
  为 null，但那时编辑器还可见，用它当判据会造成"切回来按空格没反应"的新 bug；
- `document.activeElement !== lastEditable`：焦点已经离开编辑器（如果浏览器没移走焦点，现有
  `editingSomewhere()` 守卫本来就会拦住，两条判据互补）；
- `!engaged`：用户已经用鼠标/焦点重新接管 UI（点任意位置、或聚焦卡片外的控件），此时空格应当可用。
  **点进 composer 内部（挪光标、选中文字）不算接管**：`pointerdown` 落在编辑器里会复位 `engaged`，
  编辑器里的任何 `keydown` 也会复位（否则"点一下输入框再打字，卡片一来就解锁"会复活 P0）。

**拒绝时**：`reason: "editor-hidden"`，`preventDefault()`（焦点在 `<body>`，不吞键就会滚动页面），
但**不** `stopPropagation()`；兜底路径（`observeShortcuts`）读到 `defaultPrevented` 后静默跳过，
不会二次记录、也不会二次应答。

**恢复**：点任意位置、聚焦卡片外的控件、或重新点回编辑器打字；pending 请求消失后状态也清零。

## 与 1.1.5 的行为差异

- 默认没有 300ms 等待：卡片出现后立刻按空格就批准（`boot.cooldownMs === 0`）；
- 打字中被接管：空格被拒绝**且吞掉**（不再滚动页面），控制台**一条**可见 warn，点一下恢复；
- 冷却是可选项：`localStorage["dsh-space-approve:cooldownMs"] = "300"` 仍可复现 1.1.5 的语义；
- 落单组字自愈：`window.blur` 与 `visibilitychange === "hidden"` 复位 `composing`/`compositionEnded`；
- 诊断 `window.__dshSpaceApprove.inputs` 现在记录被守卫挡下的按键及 `skip` 原因（每个物理按键严格一条）；
- 每块卡片/每个 pending key 的"按了没反应"只 warn 一次，不再刷屏；
- 重复 apply（HMR / 双挂载）只保留一个实例：`document` 监听器、fixed-input 订阅都只有一条，
  诊断对象每次 apply 新建、卸载只删自己的；
- 卡片内 `ApprovalWarning` 悬浮卡（rc.3 新增、portal 到 body、`role="dialog"` 无 `aria-modal`）里按
  Space/Esc 现在**交还原生**（`focus-in-card-control`），不再误批/误拒。

---

## 测试与变异（实测口径）

```
node test/space-approve.test.mjs            # 207 项断言，全部通过
node test/mutation.mjs                      # 选定 59 个变异，全部被杀死（59/59）
node scripts/proof-composer-takeover.mjs    # v1.1.4 / v1.1.5 / 1.1.6 三段对照，PASS
```

变异集的用法要说清楚：**59 个变异是手工挑选的，全部被杀只说明"选中的行为被测试钉住了"，不说明
覆盖率、更不等于"每条守卫都有回归保护"**。已知没有回归保护的机制：`MAX_SEEN_KEYS` 剪枝、
`isVisible` 在真实动画/离屏布局下的语义（`opacity`/`transform`/`content-visibility`）、真实中文 IME
与死键、React 真实卸载/重挂载时序、`answer()` 落定前连按的时序。这些只能靠真机清单确认。

## 第 0 步：一个未验证的前提

本版 P0 判据依赖两个浏览器观测值，而本次开发环境**没有可用的浏览器自动化**
（`browser-skill` 守护进程无法启动；无头 Edge 两次尝试均失败），因此 **`focusout` 在
`display:none` 时的派发时序未验证**。实现据此做了保守选择：**不依赖 `focusout`**，改为按键时动态复查。
测试里也有一条"完全不派发 `focusout` 也照样拦住"的用例。

真机请先确认（任一不成立就停止使用本版并上报）：

1. 卡片出现后，`document.activeElement.tagName === "BODY"`；
2. 卡片出现**之前**用 DevTools 的 `$0` 选中 composer 编辑器，卡片出现后 `$0.checkVisibility() === false`。

如果焦点**没有**回落到 `<body>`，判据会走"焦点仍在编辑器"分支（`editor-focused`，不误批），
行为与 1.1.5 的输入框守卫一致。

## 安装 / 升级

```bash
dsh plugin --profile <desktop|web> add github:LingYun3241/dsh-space-approve#v1.1.6

# 或最新 main
dsh plugin --profile <desktop|web> add github:LingYun3241/dsh-space-approve
```

升级后刷新页面即可（没有构建脚本）。启动日志：

```
[space-approve] ready { version: "1.1.6", mode: "dom+shortcuts", escape: true, cooldownMs: 0, at: … }
```

`mode` 必须是 `dom+shortcuts`；只有 `dom` 说明兜底路径没挂上（`ctx.inject(["shortcuts"])` 没拿到服务）。

## 真机确认清单

1. **先确认上面第 0 步的两个判据值**；
2. 在 composer 里打字时来审批：继续按 3~6 记空格（间隔 300~500ms）→ **一条都不批**，页面不跳动；
   控制台只有一条 `Space ignored — the composer hid the editor…`；
3. 没在打字（焦点不在 composer）时卡片弹出 → 80ms 内第一记空格**立即**批准；
4. 打字接管后轻点任意空白 → 再按空格立即批准；
5. `Esc` 仍能拒绝（含焦点在 `<body>` 时）；
6. 右键菜单/对话框打开时空格不批准；
7. 中文输入法选词时空格不批准；
8. Alt-Tab 切走再回来 → 空格/Esc 仍然立即可用（组字复位）；
9. 点开卡片里的警告徽标（rc.3 `ApprovalWarning`）后按 Space/Esc → 交还原生，不误批/误拒；
10. 菜单刚关闭时按 Esc 的行为（宿主右键菜单自己的 Esc 是死码，见 README「已知限制」）。

## 兼容性

- `dsh.engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"`。该范围对 `0.2.2-rc.3` **只在宿主传
  `includePrerelease: true` 时成立**（宿主实现：`dsh-app-boot/src/plugin-compatibility.ts:52`）；
  测试里用同一语义做了断言，普通 semver 规则下这个范围**不**匹配 `0.2.2-rc.3`；
- 安装方式、包结构、`dsh.bundle.patch`、`dsh.client.platform` 均未变；
- 不使用 `analysis`、不发网络请求、不读凭据。

## License

MIT

