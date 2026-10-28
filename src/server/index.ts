/**
 * EnsoCode 无界面宿主：跑在 Node 上，通过中继与 PWA 配对，浏览器经隧道加载桌面 renderer。
 * `enso-server` 启动宿主；`enso-server pair|devices|revoke <id>` 经控制 socket 操作运行中的宿主。
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
import { startPairGuest, stopPairGuest } from '../main/services/pairGuest';
import {
  getPairStatus,
  revokeDevice,
  startPairHost,
  startPairing,
  stopPairHost,
} from '../main/services/pairHost';
import { getProxyConfig } from '../main/services/proxyConfig';
import { refreshRemoteLeadership, setupRemoteRenderer } from '../main/services/remoteRenderer';
import {
  disposeAllTerminals,
  hasPendingPtys,
  waitPtyQuitIdle,
} from '../main/services/terminalService';
import { parseControlCommand } from './control';

const socketPath = (): string => path.join(app.getPath('userData'), 'server.sock');

async function handle(line: string): Promise<unknown> {
  const command = parseControlCommand(line);
  if ('error' in command) return { ok: false, error: command.error };
  if (command.cmd === 'pair') return startPairing();
  if (command.cmd === 'devices') return { ok: true, status: getPairStatus() };
  await revokeDevice(command.id);
  return { ok: true };
}

function listenControl(): void {
  const file = socketPath();
  if (existsSync(file)) rmSync(file);
  const server = createServer((socket: Socket) => {
    createInterface({ input: socket }).on('line', (line) => {
      void handle(line)
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
  const persisted = readSettings()?.['enso-settings'] as
    | { state?: Record<string, unknown> }
    | undefined;
  const state = persisted?.state ?? {};
  getProxyConfig().initFromConfig(state.proxyMode, state.customProxyUrl);
  syncMemoryEmbeddingFromSettings(state);
  syncMemoryDistillFromSettings(state);
  syncMemoryKgFromSettings(state);
  // 没有本地窗口：无远端 leader 时由宿主接管 pair 会话
  refreshRemoteLeadership();
  void getProxyConfig()
    .whenReady()
    .finally(() => startAgentWorker());
  startPairHost();
  startPairGuest();
  listenControl();

  app.on('before-quit', () => {
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
if (cmd === 'pair' || cmd === 'devices') client({ cmd });
else if (cmd === 'revoke') client({ cmd, id: arg ?? '' });
else if (!cmd || cmd === 'start') serve();
else {
  console.error('usage: enso-server [start] | pair | devices | revoke <pairId>');
  process.exit(2);
}
