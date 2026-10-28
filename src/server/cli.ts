import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { PairStatus } from '@shared/types/pair';
import type { UpdaterState } from '@shared/types/updater';
import QRCode from 'qrcode';
import type { ControlCommand } from './control';
import { serviceUnit } from './service';
import { DEFAULT_WEB_PORT, parseWebConfig, webEnv } from './web/config';

export const USAGE = `EnsoCode Server — 无界面宿主，手机 / 浏览器配对后远程使用

用法: enso-server <command>

  start [web 参数]            前台运行（Ctrl+C 退出）
  pair                       生成配对二维码与链接，等待设备配对
  devices                    列出已配对设备
  revoke <pairId>            撤销设备
  status                     运行状态、版本与更新
  update                     检查并安装新版本后重启（npm 全局安装时）
  service install [web 参数]  注册 systemd 服务（开机自启、崩溃拉起）
  service uninstall          移除 systemd 服务
  logs                       跟随 systemd 服务日志

内置 web（默认关闭；开启后手机直接访问本机，不经公共中继）:
  --web                      开启
  --web-host <addr>          监听地址，默认 127.0.0.1（由反向代理对外提供 https）
  --web-port <port>          监听端口，默认 ${DEFAULT_WEB_PORT}
  --public-url <url>         手机访问的地址（反代后的 https 根地址）
  给出任一 web 参数即视为开启

环境变量: ENSO_DATA_DIR（默认 ~/.enso-server）  ENSO_RELAY_URL（自建中继）
          ENSO_WEB=1  ENSO_WEB_HOST  ENSO_WEB_PORT  ENSO_PUBLIC_URL（同上，参数优先）`;

type Reply = Record<string, unknown> & { ok?: boolean; error?: string };

/** 经控制 socket 发一条命令；宿主未运行时 reject */
export function request(socketPath: string, command: ControlCommand): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const lines = createInterface({ input: socket });
    // readline 会转发 socket 的 error，两处都要接住
    lines.once('error', reject);
    socket.once('error', reject);
    socket.end(`${JSON.stringify(command)}\n`);
    lines.once('line', (line) => resolve(JSON.parse(line) as Reply));
  });
}

export const isRunning = (socketPath: string): Promise<boolean> =>
  request(socketPath, { cmd: 'status' }).then(
    () => true,
    () => false
  );

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function call(socketPath: string, command: ControlCommand): Promise<Reply> {
  const reply = await request(socketPath, command).catch(() =>
    fail('enso-server 没在运行：先 `enso-server start`，或 `enso-server service install` 后台常驻')
  );
  if (reply.ok === false) fail(String(reply.error ?? 'failed'));
  return reply;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function printDevices(status: PairStatus): void {
  if (!status.devices.length) {
    console.log('  （无）运行 `enso-server pair` 配对');
    return;
  }
  for (const d of status.devices) {
    const online = d.phoneOnline
      ? `在线·${d.transport === 'direct' ? '直连' : '中继'}${d.rttMs != null ? ` ${d.rttMs}ms` : ''}`
      : '离线';
    const at = new Date(d.pairedAt).toLocaleString();
    console.log(`  ${d.pairId}  ${d.deviceName}  ${online}  配对于 ${at}`);
  }
}

const devicesOf = async (socketPath: string) =>
  (await call(socketPath, { cmd: 'devices' })).status as PairStatus;

async function pair(socketPath: string): Promise<void> {
  const known = new Set((await devicesOf(socketPath)).devices.map((d) => d.pairId));
  const uri = String((await call(socketPath, { cmd: 'pair' })).inviteUri ?? '');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`用手机扫码，或在浏览器打开:\n${uri}\n\n等待配对…（Ctrl+C 退出）`);
  for (;;) {
    await sleep(2_000);
    const status = await devicesOf(socketPath);
    const added = status.devices.find((d) => !known.has(d.pairId));
    if (added) {
      console.log(`已配对: ${added.deviceName} (${added.pairId})`);
      return;
    }
    if (!status.pairing) fail('配对码已过期，重新运行 `enso-server pair`');
  }
}

async function status(socketPath: string): Promise<void> {
  const reply = await request(socketPath, { cmd: 'status' }).catch(() => null);
  if (!reply) {
    console.log('状态: 未运行');
    process.exitCode = 3;
    return;
  }
  const pairStatus = reply.pair as PairStatus;
  const updater = reply.update as UpdaterState;
  const s = updater.status;
  const updateText =
    updater.mode !== 'npm'
      ? '手动（npm i -g @ensocode/server@latest）'
      : s?.status === 'available' || s?.status === 'downloaded'
        ? `有新版本 ${s.info?.version}，运行 \`enso-server update\``
        : s?.status === 'error'
          ? `检查失败: ${s.error}`
          : '自动';
  console.log(`状态: 运行中 (pid ${reply.pid})`);
  console.log(`版本: ${reply.version}`);
  console.log(`数据: ${reply.dataDir}`);
  const web = reply.web as { listen: string; publicUrl: string } | null | undefined;
  console.log(`中继: ${pairStatus.relayUrl}${web ? '（内置）' : ''}`);
  if (web) console.log(`Web: 监听 ${web.listen} → ${web.publicUrl}`);
  console.log(`更新: ${updateText}`);
  console.log('设备:');
  printDevices(pairStatus);
}

async function update(socketPath: string): Promise<void> {
  console.log('检查更新…');
  const reply = await call(socketPath, { cmd: 'update' });
  const s = reply.status as UpdaterState['status'];
  if (reply.applying) console.log(`正在安装 ${s?.info?.version}，完成后服务自动重启`);
  else if (s?.status === 'not-available') console.log(`已是最新 (${s.info?.version})`);
  else if (s?.status === 'available')
    console.log(`有新版本 ${s.info?.version}：执行 npm i -g @ensocode/server@latest 后重启`);
  else console.log(JSON.stringify(s));
}

function systemctl(user: boolean, ...args: string[]): void {
  const result = spawnSync('systemctl', user ? ['--user', ...args] : args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`systemctl ${args.join(' ')} 失败`);
}

async function service(
  action: string | undefined,
  flags: string[],
  dataDir: string,
  socketPath: string
): Promise<void> {
  if (action !== 'install' && action !== 'uninstall') fail(USAGE);
  const parsed = parseWebConfig(flags, process.env);
  if (!parsed.ok) fail(`${parsed.error}\n\n${USAGE}`);
  if (spawnSync('systemctl', ['--version']).status !== 0) fail('需要 systemd');
  const root = process.getuid?.() === 0;
  const unitDir = root ? '/etc/systemd/system' : path.join(homedir(), '.config/systemd/user');
  const unitFile = path.join(unitDir, 'enso-server.service');
  if (action === 'uninstall') {
    if (existsSync(unitFile)) systemctl(!root, 'disable', '--now', 'enso-server');
    rmSync(unitFile, { force: true });
    systemctl(!root, 'daemon-reload');
    console.log(`已移除 enso-server 服务（数据保留在 ${dataDir}）`);
    return;
  }
  if (!existsSync(unitFile) && (await isRunning(socketPath)))
    fail('enso-server 正在前台运行，先停掉它（Ctrl+C）再注册服务');
  const env: Record<string, string> = { ENSO_DATA_DIR: dataDir, PATH: process.env.PATH ?? '' };
  for (const key of ['ENSO_RELAY_URL', 'ENSO_NPM_REGISTRY']) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  if (parsed.web) Object.assign(env, webEnv(parsed.web));
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(
    unitFile,
    serviceUnit({
      node: process.execPath,
      script: realpathSync(process.argv[1]),
      ...(root ? { user: userInfo().username } : {}),
      env,
    })
  );
  systemctl(!root, 'daemon-reload');
  systemctl(!root, 'enable', '--now', 'enso-server');
  console.log(`已注册并启动 enso-server 服务（${unitFile}）`);
  if (!root) console.log('用户级服务：退出登录后仍要运行，执行 `loginctl enable-linger`');
  console.log('下一步: enso-server pair');
}

function logs(): void {
  const root = process.getuid?.() === 0;
  const args = [root ? '-u' : '--user-unit', 'enso-server', '-f', '-n', '200'];
  spawn('journalctl', args, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
}

/** start 以外的子命令；返回 false 表示不认识 */
export async function runCommand(
  argv: string[],
  ctx: { socketPath: string; dataDir: string; version: string }
): Promise<boolean> {
  const [cmd, arg, ...rest] = argv;
  switch (cmd) {
    case 'pair':
      await pair(ctx.socketPath);
      return true;
    case 'devices':
      printDevices(await devicesOf(ctx.socketPath));
      return true;
    case 'revoke':
      if (!arg) fail('用法: enso-server revoke <pairId>');
      await call(ctx.socketPath, { cmd: 'revoke', id: arg });
      console.log(`已撤销 ${arg}`);
      return true;
    case 'status':
      await status(ctx.socketPath);
      return true;
    case 'update':
      await update(ctx.socketPath);
      return true;
    case 'service':
      await service(arg, rest, ctx.dataDir, ctx.socketPath);
      return true;
    case 'logs':
      logs();
      return true;
    case '-v':
    case '--version':
      console.log(ctx.version);
      return true;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return true;
    default:
      return false;
  }
}
