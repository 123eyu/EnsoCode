import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPluginRenderer, type PluginRendererDeps } from './loader';
import { pluginMessageActions, resetPluginSlots } from './registry';

beforeEach(() => resetPluginSlots());

type Enso = {
  slots: { register: (registration: object) => unknown };
  dispatch: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
};

const deps = (
  onLoad: (enso: unknown) => unknown,
  call: PluginRendererDeps['call'] = vi.fn(async () => 'v')
): PluginRendererDeps => ({
  importModule: async () => ({ onLoad }),
  react: {},
  sessionId: () => 's1',
  call,
});

describe('loadPluginRenderer', () => {
  it('登记挂点，卸载后全部收回', async () => {
    const handle = await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps((enso) => {
        (enso as Enso).slots.register({
          slot: 'message.action',
          position: 'left',
          component: () => null,
        });
      })
    );
    expect(pluginMessageActions('left')).toHaveLength(1);
    handle.dispose();
    expect(pluginMessageActions('left')).toHaveLength(0);
  });

  it('onLoad 抛错时收回已登记的挂点', async () => {
    await expect(
      loadPluginRenderer(
        'a.b',
        'ui.js',
        deps((enso) => {
          (enso as Enso).slots.register({
            slot: 'message.action',
            position: 'left',
            component: () => null,
          });
          throw new Error('boom');
        })
      )
    ).rejects.toThrow('boom');
    expect(pluginMessageActions('left')).toHaveLength(0);
  });

  it('plugin.call 转到宿主调用并带上当前会话', async () => {
    const call = vi.fn(async () => 'pong');
    await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps(async (enso) => {
        await (enso as Enso).dispatch('plugin.call', { method: 'ping', args: { a: 1 } });
      }, call)
    );
    expect(call).toHaveBeenCalledWith('a.b', 'ping', { a: 1 }, 's1');
  });

  it('没有 onLoad 时失败', async () => {
    const broken: PluginRendererDeps = {
      importModule: async () => ({}),
      react: {},
      sessionId: () => null,
      call: vi.fn(),
    };
    await expect(loadPluginRenderer('a.b', 'ui.js', broken)).rejects.toThrow(/onLoad/);
  });
});
