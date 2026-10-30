import { resolve } from 'node:path';
import type {
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
} from '@shared/extensionPlugins/types';
import type { PluginControlCommand } from './control';

export const PLUGIN_USAGE = `用法: enso-server plugin <action>

  list                         已安装插件与状态
  install <目录|zip> [--yes]    安装或更新；先展示权限，确认后落盘（新装默认停用）
  enable <id> / disable <id>   启用 / 停用
  approve <id> / reject <id>   更新扩大了授权时：同意新版本 / 保留旧版本
  uninstall <id>               卸载并删除插件数据`;

type Reply = Record<string, unknown> & { ok?: boolean; error?: string };

export interface PluginCliDeps {
  call(command: PluginControlCommand): Promise<Reply>;
  confirm(question: string): Promise<boolean>;
  log(line: string): void;
  cwd: string;
  interactive: boolean;
}

const list = (items: readonly string[]) => (items.length ? items.join(', ') : '无');

export function formatInstallPreview(p: ExtensionPluginInstallPreview): string {
  const lines = [
    `${p.name} ${p.version}（${p.id}）${p.existingVersion ? `，替换已安装的 ${p.existingVersion}` : ''}`,
    p.description,
    '',
    '插件代码会以本机用户身份运行，下列权限只约束它经 EnsoCode 调用的能力。',
    `  权限：${list(p.permissions)}`,
    `  可读：${list(p.fsRead)}`,
    `  可写：${list(p.fsWrite)}`,
    `  网络：${list(p.netDomains)}`,
    `  工具：${list(p.tools.map((t) => `${t.name}（${t.description}）`))}`,
    `  MCP：${list(p.mcpServers.map((m) => `${m.name}: ${[m.command, ...m.args].join(' ')}`))}`,
    `  界面模块：${p.hasRenderer ? '有（运行在主界面里）' : '无'}`,
  ];
  if (p.existingVersion && !p.expands) lines.push('', '授权没有扩大，确认后直接替换。');
  if (p.existingVersion && p.expands)
    lines.push('', '授权扩大了：新版本装好后需要 `enso-server plugin approve` 才会生效。');
  for (const warning of p.warnings) lines.push(`  ⚠ ${warning}`);
  return lines.filter((line, i) => line !== '' || i > 0).join('\n');
}

export function formatPluginList(plugins: readonly ExtensionPluginSummary[]): string {
  if (plugins.length === 0) return '  （无）用 `enso-server plugin install <目录|zip>` 安装';
  return plugins
    .map((p) => {
      const pending = p.pendingVersion ? `  待同意更新 ${p.pendingVersion}` : '';
      return `  ${p.id}  ${p.name} ${p.version}  ${p.state}${pending}`;
    })
    .join('\n');
}

function ensureOk(reply: Reply): Reply {
  if (reply.ok === false) throw new Error(String(reply.error ?? 'failed'));
  return reply;
}

export async function runPluginCommand(args: string[], deps: PluginCliDeps): Promise<void> {
  const [action, target, ...flags] = args;
  if (action === 'list') {
    const reply = ensureOk(await deps.call({ cmd: 'plugin', action: 'list' }));
    deps.log(formatPluginList((reply.plugins as ExtensionPluginSummary[]) ?? []));
    return;
  }
  if (action === 'install' && target) {
    const reply = ensureOk(
      await deps.call({ cmd: 'plugin', action: 'stage', path: resolve(deps.cwd, target) })
    );
    const preview = reply.preview as ExtensionPluginInstallPreview;
    deps.log(formatInstallPreview(preview));
    const yes = flags.includes('--yes') || flags.includes('-y');
    let accepted = yes;
    if (!yes) {
      if (!deps.interactive) {
        await deps.call({ cmd: 'plugin', action: 'discard', token: preview.token });
        throw new Error('非交互终端需要加 --yes 确认安装');
      }
      accepted = await deps.confirm('确认安装？(y/N)');
    }
    if (!accepted) {
      await deps.call({ cmd: 'plugin', action: 'discard', token: preview.token });
      deps.log('已取消');
      return;
    }
    ensureOk(await deps.call({ cmd: 'plugin', action: 'commit', token: preview.token }));
    deps.log(
      preview.existingVersion
        ? '已更新'
        : `已安装（停用中），启用：enso-server plugin enable ${preview.id}`
    );
    return;
  }
  if (
    (action === 'enable' ||
      action === 'disable' ||
      action === 'approve' ||
      action === 'reject' ||
      action === 'uninstall') &&
    target
  ) {
    ensureOk(await deps.call({ cmd: 'plugin', action, id: target }));
    deps.log('完成');
    return;
  }
  throw new Error(PLUGIN_USAGE);
}
