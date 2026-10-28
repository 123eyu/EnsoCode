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
- `enso-server` 启动宿主；`enso-server pair | devices | update | revoke <id>` 经 `$ENSO_DATA_DIR/server.sock`（0600）操作运行中的宿主。`ENSO_RELAY_URL` 指定中继。
- `docker/server.Dockerfile` 一条流水线两种产物：`--target bundle-out` 得到安装包（包内自带 node、生产依赖与按 Node ABI 构建的原生模块、`bin/enso-server` 启动脚本）；默认目标是基于安装包的运行镜像，内置 relay-go。依赖安装用 `--ignore-scripts`，避免下载 Electron。
- 服务器上不可用：桌面控制、内嵌浏览器、托盘、系统通知、原生目录选择（desk 改为手输路径）。

## 更新与重启

服务端复用桌面的 `updater:*` 通道（多了 `getState` / `restart`），这些通道只有服务端会开放给远端（`allowRemoteHostControl`）；远端连桌面宿主时仍然拒绝。版本以 GitHub `releases/latest` 为准（`ENSO_UPDATE_REPO` / `ENSO_UPDATE_API` 可改）。

| 部署 | 识别 | 下载 | 应用 |
| --- | --- | --- | --- |
| Docker | `ENSO_UPDATE_MODE=docker` 且 updater sidecar 心跳新鲜 | sidecar `docker pull`，按镜像 `org.opencontainers.image.version` label 判断是否更新 | sidecar 执行 `docker compose up -d relay server` 重建，宿主收到 SIGTERM 退出 |
| 安装包 | `ENSO_UPDATE_MODE=bundle` 且经 `<install>/current` 启动 | 下载 `enso-server-linux-<arch>.tar.gz`，校验 sha256，解到 `releases/<v>` | 切换 `current`（旧版本记作 `previous`），然后退出，由 systemd 拉起 |
| 其他 | — | 只报告新版本 | 手动 |

- 宿主和 sidecar 之间只通过共享卷 `/control` 下的纯文本文件通信，格式见 `src/server/update/dockerControl.ts` 与 `docker/updater.sh`。宿主不挂 docker.sock。
- 远程重启需要有进程守护：compose 设置了 `ENSO_SUPERVISED=1`，systemd 会自带 `INVOCATION_ID`。其他情况不显示重启按钮。
- 安装包回滚：启动脚本统计 systemd 拉起次数，连续 4 次失败就切回 `previous`，并把坏版本写进 `failed-version`，自更新不会再装回这个版本；宿主稳定运行 60 秒后清零计数。
- CI（`build.yml` 的 `build-server`）：两个架构各用原生 runner 构建安装包，镜像按 digest 推送；Release 发布后才合并清单并打 `:<version>` / `:latest`，避免镜像先于 Release 被拉到。
