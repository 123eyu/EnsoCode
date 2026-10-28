import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateBundle,
  bundleInstallDir,
  downloadVerified,
  markBootHealthy,
  pruneReleases,
  stageBundle,
} from './bundle';

let root: string;

function makeRelease(version: string): string {
  const dir = path.join(root, 'releases', version);
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'bin', 'enso-server'), '#!/bin/sh\n');
  return dir;
}

function makeTarball(version: string): string {
  const src = mkdtempSync(path.join(tmpdir(), 'bundle-src-'));
  mkdirSync(path.join(src, 'bin'));
  writeFileSync(path.join(src, 'bin', 'enso-server'), '#!/bin/sh\n');
  writeFileSync(path.join(src, 'VERSION'), version);
  const file = path.join(src, '..', `${path.basename(src)}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', src, '.']);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'enso-install-'));
});

describe('bundleInstallDir', () => {
  it('recognises releases/<v> reached through the current symlink', () => {
    const app = makeRelease('0.2.12');
    symlinkSync('releases/0.2.12', path.join(root, 'current'));
    expect(bundleInstallDir(app)).toBe(realpathSync(root));
    expect(bundleInstallDir(path.join(root, 'current'))).toBe(realpathSync(root));
  });

  it('refuses layouts it cannot swap safely', () => {
    const app = makeRelease('0.2.12');
    expect(bundleInstallDir(app)).toBeNull();
    symlinkSync('releases/0.2.11', path.join(root, 'current'));
    expect(bundleInstallDir(app)).toBeNull();
    expect(bundleInstallDir(mkdtempSync(path.join(tmpdir(), 'loose-')))).toBeNull();
  });
});

describe('stage / activate / prune', () => {
  it('extracts a release, flips current atomically and keeps a rollback target', () => {
    makeRelease('0.2.12');
    symlinkSync('releases/0.2.12', path.join(root, 'current'));
    writeFileSync(path.join(root, 'boot-attempts'), '2');

    const staged = stageBundle(root, '0.3.0', makeTarball('0.3.0'));
    expect(readFileSync(path.join(staged, 'VERSION'), 'utf8')).toBe('0.3.0');

    activateBundle(root, '0.3.0');
    expect(readlinkSync(path.join(root, 'current'))).toBe('releases/0.3.0');
    expect(readlinkSync(path.join(root, 'previous'))).toBe('releases/0.2.12');
    expect(existsSync(path.join(root, 'boot-attempts'))).toBe(false);
  });

  it('rejects archives without a launcher and leaves no staging behind', () => {
    const src = mkdtempSync(path.join(tmpdir(), 'bad-src-'));
    writeFileSync(path.join(src, 'README'), 'x');
    const file = `${src}.tar.gz`;
    execFileSync('tar', ['-czf', file, '-C', src, '.']);
    expect(() => stageBundle(root, '0.3.0', file)).toThrow(/launcher/);
    expect(existsSync(path.join(root, 'releases', '0.3.0'))).toBe(false);
    expect(pruneReleases(root)).toEqual([]);
  });

  it('rejects path-like versions', () => {
    expect(() => stageBundle(root, '../evil', makeTarball('x'))).toThrow(/version/);
  });

  it('prunes everything except current and previous', () => {
    for (const v of ['0.2.10', '0.2.11', '0.2.12', '0.3.0']) makeRelease(v);
    mkdirSync(path.join(root, 'releases', '.staging-0.3.1-abc'));
    symlinkSync('releases/0.3.0', path.join(root, 'current'));
    symlinkSync('releases/0.2.12', path.join(root, 'previous'));
    expect(pruneReleases(root).sort()).toEqual(['.staging-0.3.1-abc', '0.2.10', '0.2.11']);
    expect(existsSync(path.join(root, 'releases', '0.2.12'))).toBe(true);
  });

  it('marks a boot healthy by clearing the attempt counter', () => {
    writeFileSync(path.join(root, 'boot-attempts'), '1');
    markBootHealthy(root);
    markBootHealthy(root);
    expect(existsSync(path.join(root, 'boot-attempts'))).toBe(false);
  });
});

describe('downloadVerified', () => {
  const body = Buffer.from('hello bundle');
  const sha = createHash('sha256').update(body).digest('hex');
  const fetchOk = async () =>
    new Response(body, { headers: { 'content-length': String(body.length) } });

  it('streams to disk, reports progress and verifies sha256', async () => {
    const dest = path.join(root, 'dl', 'a.tar.gz');
    const seen: number[] = [];
    await downloadVerified('https://x/a', dest, sha, (p) => seen.push(p.transferred), fetchOk);
    expect(readFileSync(dest)).toEqual(body);
    expect(seen.at(-1)).toBe(body.length);
  });

  it('deletes the file on checksum mismatch or http error', async () => {
    const dest = path.join(root, 'b.tar.gz');
    await expect(
      downloadVerified('https://x/b', dest, 'f'.repeat(64), () => {}, fetchOk)
    ).rejects.toThrow(/checksum/);
    expect(existsSync(dest)).toBe(false);
    await expect(
      downloadVerified(
        'https://x/b',
        dest,
        sha,
        () => {},
        async () => new Response('', { status: 404 })
      )
    ).rejects.toThrow(/404/);
    expect(existsSync(dest)).toBe(false);
  });
});
