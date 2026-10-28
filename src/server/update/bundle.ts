import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

/**
 * 安装包布局（deploy/server/install.sh 创建）：
 *   <install>/releases/<version>/   解包后的完整版本
 *   <install>/current -> releases/<version>   systemd 从这里启动
 *   <install>/previous -> releases/<version>  启动连续失败时启动脚本回滚到这里
 *   <install>/boot-attempts         启动脚本计数，宿主稳定运行后清除
 */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function resolveLink(installDir: string, name: string): string | null {
  try {
    return realpathSync(path.join(installDir, name));
  } catch {
    return null;
  }
}

/** 只有经 current 链接启动、且位于 releases/ 下时才允许自更新；否则交给人工 */
export function bundleInstallDir(appRoot: string): string | null {
  let real: string;
  try {
    real = realpathSync(appRoot);
  } catch {
    return null;
  }
  const releases = path.dirname(real);
  if (path.basename(releases) !== 'releases') return null;
  const installDir = path.dirname(releases);
  return resolveLink(installDir, 'current') === real ? installDir : null;
}

function swapLink(installDir: string, name: string, target: string): void {
  const tmp = path.join(installDir, `.${name}-${randomBytes(4).toString('hex')}`);
  symlinkSync(target, tmp);
  renameSync(tmp, path.join(installDir, name));
}

export function stageBundle(installDir: string, version: string, tarball: string): string {
  if (!VERSION_RE.test(version)) throw new Error(`invalid version: ${version}`);
  const releases = path.join(installDir, 'releases');
  const staging = path.join(releases, `.staging-${version}-${randomBytes(4).toString('hex')}`);
  mkdirSync(staging, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'pipe' });
    if (!existsSync(path.join(staging, 'bin', 'enso-server'))) {
      throw new Error('bundle is missing bin/enso-server launcher');
    }
    const target = path.join(releases, version);
    if (resolveLink(installDir, 'current') === resolveLink(releases, version)) {
      throw new Error(`version ${version} is already running`);
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return target;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function activateBundle(installDir: string, version: string): void {
  if (!VERSION_RE.test(version)) throw new Error(`invalid version: ${version}`);
  let previous: string | null = null;
  try {
    previous = readlinkSync(path.join(installDir, 'current'));
  } catch {}
  swapLink(installDir, 'current', `releases/${version}`);
  if (previous && previous !== `releases/${version}`) swapLink(installDir, 'previous', previous);
  markBootHealthy(installDir);
}

/** 删掉 current / previous 之外的版本与残留 staging，返回删除的目录名 */
export function pruneReleases(installDir: string): string[] {
  const releases = path.join(installDir, 'releases');
  const keep = new Set(
    ['current', 'previous'].map((name) => resolveLink(installDir, name)).filter(Boolean)
  );
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(releases);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const full = path.join(releases, entry);
    if (keep.has(realpathSync(full))) continue;
    rmSync(full, { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

/** 启动脚本回滚时记下的坏版本 */
export function failedVersion(installDir: string): string | null {
  try {
    return readFileSync(path.join(installDir, 'failed-version'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function markBootHealthy(installDir: string): void {
  rmSync(path.join(installDir, 'boot-attempts'), { force: true });
}

export interface DownloadProgress {
  transferred: number;
  total: number;
}

export async function downloadVerified(
  url: string,
  dest: string,
  sha256: string,
  onProgress: (progress: DownloadProgress) => void,
  fetchImpl: (url: string) => Promise<Response> = fetch
): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const response = await fetchImpl(url);
    if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    const out = createWriteStream(dest);
    let transferred = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        transferred += chunk.length;
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        onProgress({ transferred, total });
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve()))
      );
    }
    if (hash.digest('hex') !== sha256.toLowerCase()) throw new Error('checksum mismatch');
  } catch (error) {
    rmSync(dest, { force: true });
    throw error;
  }
}
