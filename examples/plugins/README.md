# Enso 插件示例

完整的清单字段、接口、挂点和错误码见 [插件开发文档](../../docs/plugins.md)。

每个目录是一个可直接安装的插件：设置 → 插件 → Enso plugins → 安装目录；
服务端用 `enso-server plugin install examples/plugins/<name>`，再 `enso-server plugin enable <id>`。

| 目录 | 演示 | 权限 |
| --- | --- | --- |
| `word-stats` | Agent 工具读项目文件、工具结果卡片、` ```<pluginId>:bars` 代码块、随插件下发的 skill | `agent.tool` `fs.read` `ui.slot` |
| `snippets` | `#` 补全、输入框右侧按钮、消息操作按钮，读写当前草稿 | `ui.slot` `composer.draft` |
| `notes` | 侧栏页面（sandbox iframe）+ 插件私有数据目录，笔记一键插入输入框 | `ui.view` `composer.draft` |
| `github-repo` | Agent 工具经 `net.fetch` 访问白名单域名，系统通知 | `agent.tool` `net.fetch` `ui.notify` |

## 结构

```text
enso-plugin.json   清单（必需）
main.mjs           插件进程入口，导出 activate(enso)；工具、补全、界面调用都在这里处理
ui.js              可选，主界面里运行的渲染模块，导出 onLoad(enso) 登记挂点
*.html             可选，侧栏页面，自包含（内联脚本与样式），经 window.enso.call 调 main
skills/            可选，随插件下发给新会话的 skill
```

## 运行环境要点

- `main.mjs` 跑在独立子进程里，是完整的 Node，不继承 EnsoCode 的环境变量；
  `enso.fs` / `enso.net` / `enso.composer` 等宿主接口按清单权限逐次校验。
- `enso.fs` 的路径相对当前会话的项目根，范围由 `fs.read` / `fs.write` 声明（`.` 表示整个项目）。
- 读写草稿只能发生在用户操作触发的调用里（按钮、补全选中、侧栏页面），30 秒内有效。
- `ui.js` 在主界面里运行，与 EnsoCode 同权，只适合你信任的插件；用 `enso.React` 写组件，
  样式用 CSS 变量（`var(--border)`、`var(--muted-foreground)` 等）跟随主题。
- 侧栏页面在 `sandbox="allow-scripts"` 的 iframe 里运行，不能访问网络与外部资源，
  只能通过 `window.enso.call(method, args)` 调本插件 `enso.renderer.handle` 注册的方法。
