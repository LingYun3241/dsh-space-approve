# dsh-space-approve

按 **空格（Space）** 批准 DSH 的权限审批弹窗——**只允许一次**，不抢输入框、不误批、不会点成「始终允许」。

A DSH client plugin: press **Space** to answer the pending approval prompt with **allow once**.

## 它做什么

- 审批弹窗出现（且真正可见）时，按一下空格 = 「允许一次」。
- 语义级应答：直接调用官方待批请求的 `answer("allowed-once")`，与官方 Enter 的效果完全一致。
- 不依赖「点最后一个按钮」——即使弹窗带有「始终允许」，空格也只会允许一次。

## 安全边界（刻意不做的事）

| 场景 | 行为 |
|---|---|
| 焦点在输入框 / textarea / contenteditable / 下拉框 | 空格照常输入，插件不处理 |
| 焦点在任意按钮 / 链接上 | 交给浏览器原生激活（空格=点击那个按钮） |
| 输入法组字中（`isComposing` / keyCode 229） | 不处理 |
| 按住空格自动重复（`repeat`） | 只认第一次，不连批 |
| Ctrl/Alt/Shift/Cmd + 空格 | 不处理 |
| 没有待批请求 / 弹窗已撤销但 DOM 残留 | 不处理 |
| 屏幕上有多个可见审批弹窗（分屏） | 不处理，避免批错会话 |
| 面板被 `inert` / `display:none` / `visibility:hidden` 隐藏 | 不处理 |
| 弹窗带「始终允许」 | 插件只应答 `allowed-once`，绝不持久授权 |
| Esc / Enter | 完全不动，交给官方处理 |

除此之外：没有任何自动批准、超时默认值、网络请求或凭据访问；卸载/热更新时移除监听器。

## 工作方式

1. 监听 `document` 捕获阶段的 `keydown`（仅 Space、无修饰键、非重复、非输入法组字）。
2. 找到**唯一可见**的 `[data-approval-key]` 面板，取其 `data-approval-key`。
3. 从 `ctx.uiSession.sessionStatus` 的待处理交互中找 `kind === "approval"` 且 `key` 相同、`answerable` 的记录。
4. 调用该记录的 `answer("allowed-once")`，并阻止本次空格滚动页面。

依赖 DSH Web 的运行态语义（`uiSession.sessionStatus` / pending interaction），对应 DSH `0.2.x`（在 `0.2.2-rc.1` 上实测）。

## 安装

本包是纯 client bundle，随 profile 加载。任选其一：

```bash
# 从 GitHub 安装（<profile> 换成 desktop / web）
dsh plugin --profile <profile> add github:LingYun3241/dsh-space-approve

# 本地开发：link 到本仓库（路径不能含空格）
dsh plugin --profile <profile> add "link:<本仓库绝对路径>"

# 也可以在 DSH 插件管理器里安装 GitHub 源或本目录
```

安装后需要让 profile 重新组合（重启 DSH，或用 `dsh-unlag` 之类的方式刷新页面/组合）。

> 本包没有 `prepare`/`postinstall` 构建脚本，GitHub 安装不会触发 pnpm 的 `allowBuilds` 拦截。

## 调试

```js
localStorage.setItem("dsh-space-approve:debug", "1");
```

开启后每次聚焦决策与应答都会打印 `[space-approve]` 日志；设为其他值关闭。

## 测试

```bash
node test/space-approve.test.mjs
```

测试自带一个最小 DOM harness，直接加载本包的 `client.js`，覆盖：可见待批请求、文本框、聚焦按钮、IME、重复键、修饰键、多面板歧义、隐藏面板、三按钮「始终允许」卡片、卸载清理。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-space-approve
```

或从 profile 的 `package.json`（`dependencies` 与 `dsh.profile.bundles`）移除后重启。

## License

MIT
