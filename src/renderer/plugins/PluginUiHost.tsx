import { useEffect } from 'react';
import { useSessionsStore } from '@/stores/sessions';
import { createRendererDeps, loadPluginRenderer } from './loader';

/** 挂一次：启用插件的渲染模块在宿主页面加载，登记挂点；停用或变更时收回 */
export function PluginUiHost() {
  useEffect(() => {
    const deps = createRendererDeps(() => useSessionsStore.getState().activeId ?? null);
    let generation = 0;
    let handles: { dispose(): void }[] = [];
    const reload = () => {
      const mine = ++generation;
      for (const handle of handles) handle.dispose();
      handles = [];
      void window.electronAPI.extensionPlugins.list().then(async (list) => {
        if (mine !== generation) return;
        for (const plugin of list) {
          if (plugin.state !== 'enabled' || !plugin.renderer) continue;
          try {
            const handle = await loadPluginRenderer(plugin.id, plugin.renderer, deps);
            if (mine !== generation) {
              handle.dispose();
              return;
            }
            handles.push(handle);
          } catch (error) {
            console.warn(`[plugin] ${plugin.id} 渲染模块加载失败`, error);
          }
        }
      });
    };
    reload();
    const unsubscribe = window.electronAPI.extensionPlugins.onChanged(reload);
    return () => {
      generation += 1;
      unsubscribe();
      for (const handle of handles) handle.dispose();
    };
  }, []);
  return null;
}
