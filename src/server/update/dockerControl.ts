import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 与 docker/updater.sh 的约定（共享卷里的纯文本，sidecar 只用 POSIX sh 读写）：
 * - alive：sidecar 每轮 touch 的心跳
 * - request：`<id> <pull|apply>`，sidecar 取走后删除
 * - state：key=value 行，id/phase(running|done|failed)/changed/version/error
 */
export type DockerAction = 'pull' | 'apply';

export interface DockerState {
  id: string;
  phase: 'running' | 'done' | 'failed';
  changed: boolean;
  version?: string;
  error?: string;
}

const ALIVE_MS = 15_000;

export function writeDockerRequest(dir: string, id: string, action: DockerAction): void {
  const file = path.join(dir, 'request');
  writeFileSync(`${file}.tmp`, `${id} ${action}\n`);
  renameSync(`${file}.tmp`, file);
}

export function readDockerState(dir: string): DockerState | null {
  let text: string;
  try {
    text = readFileSync(path.join(dir, 'state'), 'utf8');
  } catch {
    return null;
  }
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const id = fields.get('id');
  const phase = fields.get('phase');
  if (!id || (phase !== 'running' && phase !== 'done' && phase !== 'failed')) return null;
  const version = fields.get('version');
  const error = fields.get('error');
  return {
    id,
    phase,
    changed: fields.get('changed') === '1',
    ...(version ? { version } : {}),
    ...(error ? { error } : {}),
  };
}

export function dockerUpdaterAlive(dir: string, now: number): boolean {
  try {
    return now - statSync(path.join(dir, 'alive')).mtimeMs < ALIVE_MS;
  } catch {
    return false;
  }
}
