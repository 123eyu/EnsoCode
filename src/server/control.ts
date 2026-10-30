import { isAbsolute } from 'node:path';

const PLUGIN_ID_ACTIONS = ['enable', 'disable', 'approve', 'reject', 'uninstall'] as const;
const PLUGIN_TOKEN_ACTIONS = ['commit', 'discard'] as const;

export type PluginControlCommand =
  | { cmd: 'plugin'; action: 'list' }
  | { cmd: 'plugin'; action: 'stage'; path: string }
  | { cmd: 'plugin'; action: (typeof PLUGIN_TOKEN_ACTIONS)[number]; token: string }
  | { cmd: 'plugin'; action: (typeof PLUGIN_ID_ACTIONS)[number]; id: string };

export type ControlCommand =
  | { cmd: 'pair' }
  | { cmd: 'devices' }
  | { cmd: 'update' }
  | { cmd: 'status' }
  | { cmd: 'revoke'; id: string }
  | PluginControlCommand;

function parsePluginCommand(
  input: Record<string, unknown>
): PluginControlCommand | { error: string } {
  const { action } = input;
  const text = (key: string) => {
    const value = input[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  if (action === 'list') return { cmd: 'plugin', action };
  if (action === 'stage') {
    const path = text('path');
    if (!path || !isAbsolute(path)) return { error: 'plugin stage requires an absolute path' };
    return { cmd: 'plugin', action, path };
  }
  if ((PLUGIN_TOKEN_ACTIONS as readonly unknown[]).includes(action)) {
    const token = text('token');
    if (!token) return { error: `plugin ${String(action)} requires token` };
    return { cmd: 'plugin', action: action as (typeof PLUGIN_TOKEN_ACTIONS)[number], token };
  }
  if ((PLUGIN_ID_ACTIONS as readonly unknown[]).includes(action)) {
    const id = text('id');
    if (!id) return { error: `plugin ${String(action)} requires id` };
    return { cmd: 'plugin', action: action as (typeof PLUGIN_ID_ACTIONS)[number], id };
  }
  return { error: 'unknown plugin action' };
}

export function parseControlCommand(line: string): ControlCommand | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: 'invalid json' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'invalid command' };
  const cmd = (parsed as { cmd?: unknown }).cmd;
  if (cmd === 'pair' || cmd === 'devices' || cmd === 'update' || cmd === 'status') return { cmd };
  if (cmd === 'revoke') {
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim()) return { error: 'revoke requires id' };
    return { cmd, id: id.trim() };
  }
  if (cmd === 'plugin') return parsePluginCommand(parsed as Record<string, unknown>);
  return { error: 'unknown command' };
}
