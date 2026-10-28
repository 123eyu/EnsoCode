/**
 * EnsoCode 无界面宿主：跑在 Node 上，通过中继与 PWA 配对，浏览器经隧道加载桌面 renderer。
 * `enso-server` 启动宿主；`enso-server pair|devices|update|revoke <id>` 经控制 socket 操作运行中的宿主。
 */
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { app } from '@platform';
import { registerIpcHandlers } from '../main/ipc';
import { readSettings } from '../main/ipc/settings';
import {
  agentWorkerAlive,
  startAgentWorker,
  stopAgentWorkerForQuit,
} from '../main/services/agentHost';
import { attachAppQuitDrain } from '../main/services/appQuitDrain';
import {
  closeMemoryDb,
  syncMemoryDistillFromSettings,
  syncMemoryEmbeddingFromSettings,
  syncMemoryKgFromSettings,
} from '../main/services/memoryHost';
import {
  flushPairCatalogSnapshot,
  loadPairCatalogSnapshot,
  savePairCatalogSnapshot,
} from '../main/services/pairCatalogStore';
import { startPairGuest, stopPairGuest } from '../main/services/pairGuest';
import {
  getPairStatus,
  revokeDevice,
  setPairCatalogSink,
  setRelayUrl,
  startPairHost,
  startPairing,
  stopPairHost,
  updatePairCatalog,
} from '../main/services/pairHost';
import { getProxyConfig } from '../main/services/proxyConfig';
import { refreshRemoteLeadership, setupRemoteRenderer } from '../main/services/remoteRenderer';
import {
  disposeAllTerminals,
  hasPendingPtys,
  waitPtyQuitIdle,
} from '../main/services/terminalService';
import { parseControlCommand } from './control';
import { registerServerUpdater } from './update/ipc';
import type { ServerUpdater } from './update/serverUpdater';

const socketPath = (): string => path.join(app.getPath('userData'), 'server.sock');

/** 检查 → 下载 → 应用（应用会让宿主退出，由 compose / systemd 拉起新版本） */
async function update(updater: ServerUpdater): Promise<unknown> {
  await updater.checkForUpdates();
  if (updater.state().status?.status === 'available') await updater.downloadUpdate();
  const status = updater.state().status;
  if (status?.status !== 'downloaded') return { ok: status?.status !== 'error', status };
  setTimeout(() => void updater.quitAndInstall(), 200);
  return { ok: true, status, applying: true };
}

async function handle(line: string, updater: ServerUpdater): Promise<unknown> {
  const command = parseControlCommand(line);
  if ('error' in command) return { ok: false, error: command.error };
  if (command.cmd === 'pair') return startPairing();
  if (command.cmd === 'devices') return { ok: true, status: getPairStatus() };
  if (command.cmd === 'update') return update(updater);
  await revokeDevice(command.id);
  return { ok: true };
}

function listenControl(updater: ServerUpdater): void {
  const file = socketPath();
  if (existsSync(file)) rmSync(file);
  // 客户端发完即半关闭；保持写端打开，等异步命令（如向中继登记配对）回包
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    createInterface({ input: socket }).on('line', (line) => {
      void handle(line, updater)
        .catch((error: unknown) => ({ ok: false, error: String(error) }))
        .then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
    });
  });
  server.listen(file, () => chmodSync(file, 0o600));
  app.on('before-quit', () => {
    server.close();
    rmSync(file, { force: true });
  });
}

function serve(): void {
  setupRemoteRenderer();
  registerIpcHandlers();
  const updater = registerServerUpdater();
  const persisted = readSettings()?.['enso-settings'] as
    | { state?: Record<string, unknown> }
    | undefined;
  const state = persisted?.state ?? {};
  getProxyConfig().initFromConfig(state.proxyMode, state.customProxyUrl);
  syncMemoryEmbeddingFromSettings(state);
  syncMemoryDistillFromSettings(state);
  syncMemoryKgFromSettings(state);
  // 目录平时由 leader 渲染器推送；重启后先用快照，headless 接管的会话才有据可依
  const snapshot = loadPairCatalogSnapshot();
  if (snapshot) updatePairCatalog(snapshot);
  setPairCatalogSink(savePairCatalogSnapshot);
  // 没有本地窗口：无远端 leader 时由宿主接管 pair 会话
  refreshRemoteLeadership();
  void getProxyConfig()
    .whenReady()
    .finally(() => startAgentWorker());
  const relay = process.env.ENSO_RELAY_URL?.trim();
  if (relay) setRelayUrl(relay);
  startPairHost();
  startPairGuest();
  listenControl(updater);

  app.on('before-quit', () => {
    flushPairCatalogSnapshot();
    stopPairHost();
    stopPairGuest();
    closeMemoryDb();
  });
  attachAppQuitDrain(app, [
    { begin: disposeAllTerminals, shouldWait: hasPendingPtys, wait: waitPtyQuitIdle },
    { shouldWait: agentWorkerAlive, wait: () => stopAgentWorkerForQuit(3_000) },
  ]);
  let quitting = false;
  const quit = () => {
    if (quitting) process.exit(130);
    quitting = true;
    app.quit();
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  console.log(`[server] enso-server ${app.getVersion()} data=${app.getPath('userData')}`);
}

function client(request: Record<string, unknown>): void {
  const socket = createConnection(socketPath());
  socket.on('error', (error) => {
    console.error(`enso-server is not running (${error.message})`);
    process.exit(1);
  });
  socket.end(`${JSON.stringify(request)}\n`);
  createInterface({ input: socket }).on('line', (line) => {
    const reply = JSON.parse(line) as { ok?: boolean; inviteUri?: string };
    if (reply.inviteUri) console.log(reply.inviteUri);
    else console.log(JSON.stringify(reply, null, 2));
    process.exitCode = reply.ok === false ? 1 : 0;
  });
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'pair' || cmd === 'devices' || cmd === 'update') client({ cmd });
else if (cmd === 'revoke') client({ cmd, id: arg ?? '' });
else if (!cmd || cmd === 'start') serve();
else {
  console.error('usage: enso-server [start] | pair | devices | update | revoke <pairId>');
  process.exit(2);
}
