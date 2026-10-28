import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateStatus } from '@shared/types/updater';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerUpdater, type ServerUpdaterDeps } from './serverUpdater';

const idle = () => ({
  enabled: true,
  downloaded: true,
  agentBusy: false,
  windowFocused: false,
  queuedCount: 0,
  pendingAskCount: 0,
  pendingApprovalCount: 0,
});

function tarball(version: string): Buffer {
  const src = mkdtempSync(path.join(tmpdir(), 'upd-src-'));
  mkdirSync(path.join(src, 'bin'));
  writeFileSync(path.join(src, 'bin', 'enso-server'), '#!/bin/sh\n');
  writeFileSync(path.join(src, 'VERSION'), version);
  const file = `${src}.tar.gz`;
  execFileSync('tar', ['-czf', file, '-C', src, '.']);
  return readFileSync(file);
}

function releaseFetch(version: string, bundle = tarball(version)) {
  const sha = createHash('sha256').update(bundle).digest('hex');
  return vi.fn(async (url: string) => {
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        tag_name: `v${version}`,
        name: `EnsoCode ${version}`,
        assets: [
          {
            name: 'enso-server-linux-arm64.tar.gz',
            browser_download_url: 'https://dl/bundle',
            size: bundle.length,
          },
          { name: 'enso-server-checksums.txt', browser_download_url: 'https://dl/sums', size: 1 },
        ],
      });
    }
    if (url === 'https://dl/sums') return new Response(`${sha}  enso-server-linux-arm64.tar.gz\n`);
    if (url === 'https://dl/bundle') return new Response(new Uint8Array(bundle));
    return new Response('', { status: 404 });
  });
}

let root: string;
let statuses: UpdateStatus[];

function updater(overrides: Partial<ServerUpdaterDeps>): ServerUpdater {
  return new ServerUpdater({
    version: '0.2.12',
    appRoot: path.join(root, 'current'),
    arch: 'arm64',
    env: {},
    fetch: releaseFetch('0.3.0'),
    broadcast: (status) => statuses.push(status),
    quit: vi.fn(),
    idle,
    sleep: async () => {},
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'enso-upd-'));
  statuses = [];
});

describe('ServerUpdater (bundle)', () => {
  beforeEach(() => {
    mkdirSync(path.join(root, 'releases', '0.2.12', 'bin'), { recursive: true });
    symlinkSync('releases/0.2.12', path.join(root, 'current'));
  });

  it('checks, downloads, stages and switches current before quitting', async () => {
    const quit = vi.fn();
    const u = updater({ env: { ENSO_UPDATE_MODE: 'bundle', INVOCATION_ID: 'x' }, quit });
    expect(u.state()).toMatchObject({ host: 'server', mode: 'bundle', canRestart: true });

    await u.checkForUpdates();
    expect(statuses.map((s) => s.status)).toEqual(['checking', 'available']);

    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({ status: 'downloaded', info: { version: '0.3.0' } });
    expect(statuses.some((s) => s.status === 'downloading')).toBe(true);
    expect(readFileSync(path.join(root, 'releases', '0.3.0', 'VERSION'), 'utf8')).toBe('0.3.0');
    expect(existsSync(path.join(root, 'downloads', 'enso-server-linux-arm64.tar.gz'))).toBe(false);

    await u.quitAndInstall();
    expect(readlinkSync(path.join(root, 'current'))).toBe('releases/0.3.0');
    expect(readlinkSync(path.join(root, 'previous'))).toBe('releases/0.2.12');
    expect(quit).toHaveBeenCalledOnce();
  });

  it('reports a checksum mismatch and keeps running the old version', async () => {
    const good = tarball('0.3.0');
    const fetch = releaseFetch('0.3.0', good);
    const tampered = vi.fn(async (url: string) =>
      url === 'https://dl/bundle' ? new Response('evil') : fetch(url)
    );
    const u = updater({ env: { ENSO_UPDATE_MODE: 'bundle' }, fetch: tampered });
    await u.checkForUpdates();
    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({ status: 'error', error: 'checksum mismatch' });
    expect(existsSync(path.join(root, 'releases', '0.3.0'))).toBe(false);
    expect(readlinkSync(path.join(root, 'current'))).toBe('releases/0.2.12');
  });

  it('refuses a version the launcher already rolled back', async () => {
    writeFileSync(path.join(root, 'failed-version'), '0.3.0\n');
    const u = updater({ env: { ENSO_UPDATE_MODE: 'bundle' } });
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/rolled back/),
    });
  });

  it('says up to date when the release is not newer', async () => {
    const u = updater({ env: { ENSO_UPDATE_MODE: 'bundle' }, fetch: releaseFetch('0.2.12') });
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'not-available' });
  });
});

describe('ServerUpdater (docker)', () => {
  function sidecar(dir: string, reply: Record<string, string>) {
    return async () => {
      const file = path.join(dir, 'request');
      if (!existsSync(file)) return;
      const [id] = readFileSync(file, 'utf8').trim().split(' ');
      rmSync(file);
      const lines = Object.entries({ id, ...reply }).map(([k, v]) => `${k}=${v}`);
      writeFileSync(path.join(dir, 'state'), `${lines.join('\n')}\n`);
    };
  }

  it('pulls through the sidecar and asks it to recreate the container', async () => {
    writeFileSync(path.join(root, 'alive'), '');
    const env = { ENSO_UPDATE_MODE: 'docker', ENSO_UPDATE_CONTROL_DIR: root, ENSO_SUPERVISED: '1' };
    const u = updater({
      env,
      sleep: sidecar(root, { phase: 'done', changed: '1', version: '0.3.0' }),
    });
    expect(u.state()).toMatchObject({ mode: 'docker', canRestart: true });

    await u.checkForUpdates();
    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({ status: 'downloaded', info: { version: '0.3.0' } });

    // sidecar 回报完成却没重建本容器 → 报错而不是假装成功
    await u.quitAndInstall();
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('does not treat an unchanged image as an update', async () => {
    writeFileSync(path.join(root, 'alive'), '');
    const env = { ENSO_UPDATE_MODE: 'docker', ENSO_UPDATE_CONTROL_DIR: root };
    const u = updater({
      env,
      sleep: sidecar(root, { phase: 'done', changed: '0', version: '0.2.12' }),
    });
    await u.checkForUpdates();
    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('uses the image-changed flag when the label is not a release version', async () => {
    writeFileSync(path.join(root, 'alive'), '');
    const env = { ENSO_UPDATE_MODE: 'docker', ENSO_UPDATE_CONTROL_DIR: root };
    const u = updater({
      env,
      sleep: sidecar(root, { phase: 'done', changed: '1', version: 'dev' }),
    });
    await u.checkForUpdates();
    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({ status: 'downloaded', info: { version: '0.3.0' } });
  });

  it('falls back to manual without a live sidecar', async () => {
    const u = updater({ env: { ENSO_UPDATE_MODE: 'docker', ENSO_UPDATE_CONTROL_DIR: root } });
    expect(u.state()).toMatchObject({ mode: 'manual', canRestart: false });
    expect(() => u.restart()).toThrow(/supervisor/);
    await u.checkForUpdates();
    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });
});
