# EnsoCode Server：宿主核心 / 桌面壳 / Node 壳

目标：EnsoCode 能以纯 Node 进程跑在 Linux 服务器上，浏览器（desk.html / PWA）通过 pair 配对使用完整功能；关掉所有客户端，队列、goal 续跑、卡顿重试、标题总结、自动归档照常进行。桌面与服务器走同一份宿主核心，不存在第二份业务逻辑。

## 分层

```text
src/main/platform/      平台接口（HostPlatform）+ 注册点；核心只依赖它
src/main/**（核心）      IPC handler、会话、worker、pair、自动行为 —— 禁止 import 'electron'
src/main/desktop/       桌面壳：Electron 实现平台接口、窗口/托盘/菜单/更新/浏览器/computer
src/server/             Node 壳：Node 实现平台接口、headless 启动、CLI 配对、文件密钥
```

- 边界由 biome `noRestrictedImports` 守住：核心目录 import `electron` 直接 lint 失败；桌面专属目录在 override 中放行。
- 服务器构建产物只从 `src/server/index.ts` 起步，任何核心模块偷偷依赖 Electron 都会在 Node 下启动即失败（`pnpm test` 中有守卫测试扫描服务器产物）。

## 平台接口

`HostPlatform` 只覆盖核心真实用到的能力：路径（userData/appRoot/resources）、应用信息与退出钩子、密钥加解密、外部打开、电源（resume / 防睡眠）、通知、子进程 fork、IPC 注册、向 renderer 推送、可选能力（browser / computer）。

- 桌面：Electron API 一一映射，行为不变。
- 服务器：IPC 只进注册表，由 remoteRenderer 隧道调用；推送只发远端 renderer；密钥用 userData 下 0600 的随机主密钥做 AES-256-GCM；fork 用 `child_process.fork`（advanced 序列化），agent worker 同时兼容 `process.parentPort` 与 `process.send`。

## 自动行为归宿主（去 leader）

原先只在 leader renderer 执行的自动行为全部迁入 Main 的 `sessionAutomation`，对桌面窗口、远端浏览器、手机一视同仁；`rendererRole` / leader 概念删除，`pairSessionHost` 的 headless 分支并入同一实现。

| 行为 | 宿主实现 |
| --- | --- |
| 排队消息 / goal 续跑 | 宿主拥有 `queuedMessages` 与 `goal`；所有客户端改发同一套 `PairQueueAction`（`session:queue-action`）；宿主跟踪 worker 事件得出运行态，轮次收束后泵队首或续跑 goal |
| 标题总结 | 首条用户消息与每轮 `turn-completed` 摘要由宿主触发，结果写回会话 |
| 卡顿重试 | 宿主按 worker 事件记心跳，超时 abort → retry，重复卡顿放弃 |
| 自动归档 / 删除 | 宿主定时扫描持久化会话 |
| pair 目录 | 宿主由持久化设置与会话直接构建，不再等 renderer 推送 |

宿主对会话的修改走 `patchConversationsFromHost`：写入持久化文档并以 `CONVERSATIONS_PATCH` 推给所有主界面 peer；renderer 写入一律按字段差分合并，不再整体覆盖，避免冲掉宿主修改。

## Node 壳

- `enso-server`（`node out/server/index.js`）：启动核心、agent worker、pair host；`ENSO_DATA_DIR` 指定数据目录。
- 本地控制 socket（`$ENSO_DATA_DIR/server.sock`，0600）：`enso-server pair` 打印邀请链接与终端二维码，`devices` / `revoke <id>` 管理已配对设备。
- 服务器上不可用：桌面控制、内嵌浏览器、托盘、自动更新、系统通知。

## 部署

Docker（debian-slim + Node 24）与 systemd 示例；以非 root 运行。原生模块（better-sqlite3、node-pty、node-datachannel、sqlite-vec）在镜像构建时按 Node ABI 安装。
