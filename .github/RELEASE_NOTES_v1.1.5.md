# dsh-space-approve v1.1.5 — 安全修复版：打字中的空格不会再误批

**TL;DR / 一句话**：审批卡刚接管 composer 的 300ms 内，空格不再批准（也不会被吞掉）；右键菜单/下拉菜单打开时不再误批；输入法选词的空格在 WebKit 上也不再误批。命令行之外的体验不变。

---

## 为什么发这个版本

一次对抗性审查（含 26 个变异实验）发现：原测试 57 项全绿，但 17 个变异存活（得分约 35%）——**测试没能保护最关键的安全机制**。同时确认了 1 个 P0 和 2 个 P1 真实缺陷。本版按审查结论整改，并把测试升级到“改坏就能变红”。

## 修复内容

### P0：打字中的空格会批准一条特权命令

`conversation.composer` 用 `overlay: true` 渲染，审批卡被选中时官方渲染器把原 composer（含正在聚焦的编辑器）包进 `display:none`，浏览器让编辑器失焦、`document.activeElement` 回落到 `<body>`。于是“用户还在打字、顺手按下空格”会同时绕过两个输入守卫，直接 `answer("allowed-once")`。

现在每块卡片都会记录**首次可见时间**（`MutationObserver`，不是“第一次按键才记”，所以等多久之后的第一下都算数）。卡片出现后 `cooldownMs`（默认 300ms）内的空格按 `warming:<key>` 处理：**不批准，也不吞键**，过了冷却期再按即可。冷却期可用 `localStorage["dsh-space-approve:cooldownMs"]`（或宿主传入的 `config.cooldownMs`）调整，`0` 表示关闭。`Esc` 不受冷却期影响。

复现与对照：`node scripts/proof-composer-takeover.mjs`

```
before (v1.1.4): Space +50ms → allowed-once（误批）
after  (1.1.5):  Space +50ms → warming:approval:7；+450ms → allowed-once
```

### P1：弹层判定与宿主不一致

- `MODAL` 原先缺 `[role="menu"]`，且取文档序第一个、不判可见。现在与宿主 `modalSelector` 完全一致：`[role="dialog"][aria-modal="true"], [role="menu"]`，取**最上层可见**弹层。右键菜单/下拉菜单打开时按空格不再批准；被 `display:none` 挂载的弹层也不会再永久压住审批。
- 照抄官方卡片的 `composing` / `compositionEnded` 状态机（`compositionstart` / `compositionend` / `keyup`），修复 WebKit 上“用空格选词 → 批准”的隐患。

### P2 / P3

- `config.escape:false` 确认送不到 client 半身（宿主只传 `{ name }`）→ 开关改到 `localStorage`，README 按实际行为重写；
- `shortcuts` 改用 `ctx.inject(["shortcuts"], …)` 等待服务，修掉启动竞态导致的永久降级；
- **删除按位置点按钮的兜底**：没有 `answer()` 就 `answer-failed`，绝不点按钮；
- `isVisible` 去掉 `checkOpacity`（淡入期间不再误判），原因码细分 `no-panel` / `no-panel:hidden`；
- 分屏/动画重叠时按“哪块卡片真有匹配的待批请求”选择，只有唯一匹配才回答；
- 版本号单一来源并与 `package.json` 对齐；卸载时清掉 `window.__dshSpaceApprove`；
- 日志降噪：只有真正应答才 `warn`，其余走 debug；`[role="combobox"]` 去重；兜底路径补 `context.target === null` 守卫。

## 测试升级

- **149 项断言**（原 57）：新增真实传播模型（capture 顺序、`stopPropagation` 生效）、同一条派发链上的宿主 `shortcuts`（window 冒泡）、可控时钟、`MutationObserver`、可延迟的 `ctx.inject`；修复原 A12/C1/C2 三条假阳性。
- **变异检查 37/37 = 100% 被杀死**（原 9/26 ≈ 35%）：`node test/mutation.mjs`。
- CI 仍只跑 `node test/space-approve.test.mjs`，退出码 0。

## 安装 / 升级

```bash
dsh plugin --profile <desktop|web> add github:LingYun3241/dsh-space-approve#v1.1.5

# 或最新 main
dsh plugin --profile <desktop|web> add github:LingYun3241/dsh-space-approve
```

升级后刷新页面即可（无构建脚本）。启动日志应显示：

```
[space-approve] ready { version: "1.1.5", mode: "dom+shortcuts", escape: true, cooldownMs: 300, … }
```

## 需要在真机上确认的

1. composer 里打字时来审批：空格不应立刻批准；停 300ms 后再按才批准；
2. 右键菜单/下拉菜单打开时按空格不应批准；
3. 中文输入法选词时按空格不应批准；
4. 刷新后 Console 有 `version: "1.1.5"` 的 ready 日志；
5. Esc 拒绝仍正常。

## 兼容性

`dsh.engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"`，与 `0.2.2-rc.3` 对齐核对过宿主源码；安装方式、包结构、`dsh.bundle.patch` / `dsh.client.platform` 均未变。

## License

MIT
