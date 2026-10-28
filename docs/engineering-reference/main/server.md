# EnsoCode Server：宿主核心 / 桌面壳 / Node 壳

目标：EnsoCode 以纯 Node 进程跑在 Linux 上，浏览器（desk 完整版 / 手机 PWA）经 pair 配对使用；关掉所有客户端，排队消息、goal 续跑、卡顿重试、首条标题照常进行。桌面与服务器共用同一份宿主核心。

## 分层

```text
src/main/platform/      平台门面 `@platform` 的接口声明（api.ts / types.ts）
src/main/**（核心）      IPC handler、会话、worker、pair —— 只从 @platform 取进程能力
src/main/desktop/       桌面壳：platform.ts 直接转出 Electron；localUi.ts 注册窗口
src/server/             Node 壳：platform.ts 的 Node 实现、入口、控制 socket
test/stubs/platform.ts  测试平台（转出 electron 桩）
```

- `@platform` 由构建别名决定：electron.vite.config.ts → desktop，vite.server.config.ts → server，vitest → test stub。
- biome `noRestrictedImports` 禁止核心目录 import `electron`；`src/server/electronBoundary.test.ts` 从服务端入口追静态 import 图，触达 `electron` / `?modulePath` 即失败。
- 窗口相关一律经 `services/renderers.ts`（`broadcastToRenderers` / `isMainRenderer` / `localMainContents`）与 `services/uiHost.ts` 的 `LocalUi`；服务端不注册 LocalUi（`localUi() === null`）。
- 浏览器 / computer / 通知 / PDF 窗口 / 更新等桌面能力经 `services/desktopHooks.ts` 注入，服务端为 noop。桌面专属 IPC 在 `ipc/desktop.ts`，只有桌面入口注册。

## 服务端平台实现

app 路径来自 `ENSO_DATA_DIR`（默认 `~/.enso-server`）与 `ENSO_APP_ROOT`；ipcMain 是注册表，由 remoteRenderer 隧道调用；safeStorage 用 userData 下 0600 的 `secret.key` 做 AES-256-GCM；utilityProcess.fork 用 `child_process.fork`，agent worker 的 `workerPort()` 同时兼容 `process.parentPort` 与 `process.send`；shell / 电源 / 通知为日志或 noop。

## 无渲染器时的自动行为

没有本地窗口时 leader 由远端 desk 担任（`refreshRemoteLeadership`）；连远端 desk 都没有就进入 `pairSessionHost` 的 headless 分支，由 Main 接管：

| 行为 | headless 实现 |
| --- | --- |
| 排队消息 / goal 续跑 | `HeadlessSessionRuntime` 跟踪 worker 事件，轮次收束后泵队首或续跑 goal，写回会话并更新 pair 目录 |
| 卡顿重试 | 事件心跳 + 前台命令截止时间；`generationStallTimeoutMin` 超时 abort → retry，3 次放弃（判定函数在 `@shared/stallTimeout`） |
| 首条标题 | 冷会话首条用户消息取代表行；开启标题总结时经 `requestTitleSummary` 请求模型，基准未变才回写 |
| pair 目录 | 平时由 leader 推送；服务端把每次变化防抖落盘到 `pair-catalog.json`，重启先回灌 |
| 自动归档 / 删除 | 仍在 leader 水合时扫描（与桌面“启动时扫一次”一致），任一 desk 连上即执行 |

新装的服务端需先用 desk 连一次，leader 才会推出目录（项目、模型列表）；之后手机端可独立使用。

## Node 壳与部署

- `pnpm build:server` 产出 `out/server/{index,agent}.js`（另含 `?nodeWorker` 拆出的 worker chunk）；依赖保持 external。
- `enso-server` 启动宿主；`enso-server pair | devices | revoke <id>` 经 `$ENSO_DATA_DIR/server.sock`（0600）操作运行中的宿主。`ENSO_RELAY_URL` 指定中继。
- `docker/server.Dockerfile`：`--ignore-scripts` 安装后只为 Node ABI 重建原生依赖（避免下载 Electron），rg 用系统包，rtk 按打包布局放到 `resources/rtk/rtk`；同一镜像内置 relay-go（含手机 PWA 与 desk renderer 产物）。`docker/compose.yaml` 起 relay + server（host 网络，便于 WebRTC 直连）。
- 服务器上不可用：桌面控制、内嵌浏览器、托盘、自动更新、系统通知、原生目录选择（desk 改为手输路径）。
