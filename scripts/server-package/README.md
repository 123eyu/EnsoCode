# @ensocode/server

EnsoCode 的无界面服务端：跑在 Linux（或 macOS）上，手机 / 浏览器经中继配对后远程使用 agent。

```bash
npm i -g @ensocode/server        # 需要 Node.js 22+
enso-server start            # 前台运行
enso-server pair             # 另开终端：扫码或打开链接完成配对
```

后台常驻（systemd，开机自启、崩溃拉起，网页端可一键更新 / 重启）：

```bash
enso-server service install
enso-server status
enso-server logs
```

| 命令 | 说明 |
| --- | --- |
| `start` | 前台运行 |
| `pair` | 生成配对二维码与链接，等待设备配对 |
| `devices` / `revoke <pairId>` | 查看 / 撤销已配对设备 |
| `status` | 运行状态、版本、更新与设备 |
| `update` | 检查并安装新版本后重启 |
| `service install\|uninstall` | 注册 / 移除 systemd 服务 |
| `logs` | 跟随服务日志 |

环境变量：`ENSO_DATA_DIR`（默认 `~/.enso-server`）、`ENSO_RELAY_URL`（自建中继）。`service install` 会把当时的这些变量和 `PATH` 写进服务。
