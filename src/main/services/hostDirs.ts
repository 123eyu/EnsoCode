import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HostDirListing } from '@shared/types';

async function isDir(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false
  );
}

/** 列出宿主机目录下的可见子目录（供远端客户端添加项目时浏览）；路径不存在时退到最近的已存在祖先 */
export async function listHostDirs(target?: string, home = homedir()): Promise<HostDirListing> {
  const input = target?.trim() || '~';
  const expanded =
    input === '~' ? home : input.startsWith('~/') ? path.join(home, input.slice(2)) : input;
  let dir = path.resolve(home, expanded);
  while (!(await isDir(dir))) {
    const up = path.dirname(dir);
    if (up === dir) return { ok: false, error: 'Directory not found.' };
    dir = up;
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (await isDir(path.join(dir, entry.name))))
      )
        dirs.push(entry.name);
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const parent = path.dirname(dir);
    return { ok: true, path: dir, parent: parent === dir ? null : parent, dirs };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
