import type {
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
} from '@shared/extensionPlugins/types';
import { describe, expect, it, vi } from 'vitest';
import { formatInstallPreview, formatPluginList, runPluginCommand } from './pluginCli';

const preview: ExtensionPluginInstallPreview = {
  token: 't1',
  id: 'demo.hello',
  name: 'Hello',
  version: '1.0.0',
  description: 'say hi',
  permissions: ['agent.tool', 'net.fetch'],
  fsRead: [],
  fsWrite: [],
  netDomains: ['api.example.com'],
  mcpServers: [],
  tools: [{ name: 'greet', description: 'greet someone' }],
  hasRenderer: false,
  warnings: ['w1'],
  expands: true,
};

function deps(answer = true) {
  const out: string[] = [];
  const call = vi.fn(async (command: Record<string, unknown>) => {
    if (command.action === 'stage') return { ok: true, preview };
    if (command.action === 'list') return { ok: true, plugins: [] };
    return { ok: true };
  });
  return {
    out,
    call,
    deps: {
      call,
      confirm: vi.fn(async () => answer),
      log: (line: string) => out.push(line),
      cwd: '/home/u',
      interactive: true,
    },
  };
}

describe('enso-server plugin', () => {
  it('安装预览列出权限、网络域名、工具与警告', () => {
    const text = formatInstallPreview(preview);
    for (const part of ['demo.hello', '1.0.0', 'agent.tool', 'api.example.com', 'greet', 'w1'])
      expect(text).toContain(part);
  });

  it('列表为空时给出提示', () => {
    expect(formatPluginList([])).toContain('无');
    const summary = {
      id: 'demo.hello',
      name: 'Hello',
      version: '1.0.0',
      state: 'enabled',
      pendingVersion: '1.1.0',
    } as ExtensionPluginSummary;
    const text = formatPluginList([summary]);
    expect(text).toContain('demo.hello');
    expect(text).toContain('1.1.0');
  });

  it('install：相对路径按 cwd 解析，确认后提交', async () => {
    const { call, deps: d } = deps(true);
    await runPluginCommand(['install', 'plugins/hello.zip'], d);
    expect(call).toHaveBeenNthCalledWith(1, {
      cmd: 'plugin',
      action: 'stage',
      path: '/home/u/plugins/hello.zip',
    });
    expect(call).toHaveBeenNthCalledWith(2, { cmd: 'plugin', action: 'commit', token: 't1' });
  });

  it('install：拒绝确认则丢弃暂存', async () => {
    const { call, deps: d } = deps(false);
    await runPluginCommand(['install', '/srv/hello'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'discard', token: 't1' });
  });

  it('install：非交互终端必须带 --yes', async () => {
    const { call, deps: d } = deps(true);
    await expect(
      runPluginCommand(['install', '/srv/hello'], { ...d, interactive: false })
    ).rejects.toThrow('--yes');
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'discard', token: 't1' });
    await runPluginCommand(['install', '/srv/hello', '--yes'], { ...d, interactive: false });
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'commit', token: 't1' });
  });

  it('按 id 的动作', async () => {
    const { call, deps: d } = deps();
    await runPluginCommand(['disable', 'demo.hello'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'disable', id: 'demo.hello' });
    await expect(runPluginCommand(['enable'], d)).rejects.toThrow('用法');
    await expect(runPluginCommand(['bogus'], d)).rejects.toThrow('用法');
  });
});
