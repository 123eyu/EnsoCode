import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPluginHost } from '../../../pluginHost/host';
import { readRegistry } from './registry';
import { ExtensionPluginService } from './service';

/** 用进程内的插件宿主替代真实子进程，测试完整往返 */
class InProcessChild extends EventEmitter {
  pid = 1;
  private handler: (m: unknown) => void = () => {};
  constructor() {
    super();
    runPluginHost({
      send: (m) => queueMicrotask(() => this.emit('message', m)),
      onMessage: (h) => (this.handler = h),
    });
    queueMicrotask(() => this.emit('spawn'));
  }
  postMessage(m: unknown) {
    queueMicrotask(() => this.handler(m));
  }
  kill() {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const temps: string[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writePlugin(files: Record<string, string>) {
  const dir = temp('plugin-src-');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const manifest = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    id: 'example.demo',
    name: 'Demo',
    version: '1.0.0',
    main: 'main.mjs',
    permissions: ['agent.tool'],
    contributes: {
      agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
    },
    ...patch,
  });

const mainJs = `export function activate(enso) { enso.tools.register('lookup', async (args, ctx) => 'got ' + args.q + ' in ' + ctx.sessionId); }`;

let root: string;
let service: ExtensionPluginService;

beforeEach(() => {
  root = temp('plugins-root-');
  service = new ExtensionPluginService({
    root,
    hostVersion: '0.2.12',
    hostPath: '/unused',
    env: {},
    fork: () => new InProcessChild() as never,
    gate: {
      fetch: vi.fn(),
      notify: () => true,
      composer: async () => null,
      sessionMessages: async () => [],
      now: () => Date.now(),
    },
  });
});

async function install(files: Record<string, string>) {
  const preview = await service.stage({ kind: 'dir', path: writePlugin(files) });
  if (!preview.ok) throw new Error(preview.error);
  const committed = await service.commit(preview.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  return preview.preview;
}

describe('ExtensionPluginService', () => {
  it('安装后默认停用，启用后工具进入会话下发列表', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    expect(service.list()[0]).toMatchObject({ id: 'example.demo', state: 'disabled' });
    expect(service.toolsForSpawn()).toEqual([]);
    service.setEnabled('example.demo', true);
    expect(service.toolsForSpawn()).toEqual([
      {
        name: 'plugin_example-demo__lookup',
        description: '查询',
        parameters: { type: 'object' },
        pluginId: 'example.demo',
      },
    ]);
    expect(readRegistry(root).plugins[0]?.state).toBe('enabled');
  });

  it('调用插件工具：会话 id 由 Main 传入', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    service.setEnabled('example.demo', true);
    const result = await service.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: { q: 'x' },
      sessionId: 's1',
      projectRoot: null,
    });
    expect(result).toEqual({ content: 'got x in s1' });
  });

  it('停用的插件调用直接失败，不拉起进程', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    await expect(
      service.callTool({
        toolName: 'plugin_example-demo__lookup',
        args: {},
        sessionId: 's1',
        projectRoot: null,
      })
    ).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
  });

  it('试加载失败时安装失败且不留文件', async () => {
    const preview = await service.stage({
      kind: 'dir',
      path: writePlugin({
        'enso-plugin.json': manifest(),
        'main.mjs': 'export function activate(){ throw new Error("x") }',
      }),
    });
    if (!preview.ok) throw new Error(preview.error);
    const committed = await service.commit(preview.preview.token);
    expect(committed.ok).toBe(false);
    expect(service.list()).toEqual([]);
    expect(existsSync(join(root, 'packages', 'example.demo'))).toBe(false);
  });

  it('更新扩大授权时挂起，旧版本继续可用；同意后切换', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    service.setEnabled('example.demo', true);
    const preview = await service.stage({
      kind: 'dir',
      path: writePlugin({
        'enso-plugin.json': manifest({
          version: '2.0.0',
          permissions: ['agent.tool', 'net.fetch'],
          net: { domains: ['api.example.com'] },
        }),
        'main.mjs': mainJs,
      }),
    });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.preview).toMatchObject({ existingVersion: '1.0.0', expands: true });
    await service.commit(preview.preview.token);
    expect(service.list()[0]).toMatchObject({
      version: '1.0.0',
      pendingVersion: '2.0.0',
      state: 'enabled',
    });
    service.approvePending('example.demo');
    expect(service.list()[0]).toMatchObject({ version: '2.0.0', state: 'enabled' });
    expect(service.list()[0]?.pendingVersion).toBeUndefined();
  });

  it('卸载删除安装目录与数据目录', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    mkdirSync(join(root, 'data', 'example.demo'), { recursive: true });
    await service.uninstall('example.demo');
    expect(service.list()).toEqual([]);
    expect(existsSync(join(root, 'packages', 'example.demo'))).toBe(false);
    expect(existsSync(join(root, 'data', 'example.demo'))).toBe(false);
  });

  it('10 分钟内非预期退出 3 次即标记崩溃停用', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    service.setEnabled('example.demo', true);
    for (let i = 0; i < 3; i++) service.recordCrash('example.demo');
    expect(service.list()[0]?.state).toBe('crashed');
    expect(service.toolsForSpawn()).toEqual([]);
  });

  it('暂存令牌只能提交一次', async () => {
    const preview = await service.stage({
      kind: 'dir',
      path: writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs }),
    });
    if (!preview.ok) throw new Error(preview.error);
    expect((await service.commit(preview.preview.token)).ok).toBe(true);
    expect((await service.commit(preview.preview.token)).ok).toBe(false);
  });
});
