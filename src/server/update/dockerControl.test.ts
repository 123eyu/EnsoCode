import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dockerUpdaterAlive, readDockerState, writeDockerRequest } from './dockerControl';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-control-'));
});

describe('docker updater control files', () => {
  it('writes one-line requests the sidecar shell can read', () => {
    writeDockerRequest(dir, 'r1', 'pull');
    expect(readFileSync(path.join(dir, 'request'), 'utf8')).toBe('r1 pull\n');
    writeDockerRequest(dir, 'r2', 'apply');
    expect(readFileSync(path.join(dir, 'request'), 'utf8')).toBe('r2 apply\n');
  });

  it('parses key=value state and ignores unknown phases', () => {
    writeFileSync(path.join(dir, 'state'), 'id=r1\nphase=done\nchanged=1\nversion=0.3.0\nerror=\n');
    expect(readDockerState(dir)).toEqual({
      id: 'r1',
      phase: 'done',
      changed: true,
      version: '0.3.0',
    });
    writeFileSync(path.join(dir, 'state'), 'id=r2\nphase=failed\nerror=pull access denied\n');
    expect(readDockerState(dir)).toEqual({
      id: 'r2',
      phase: 'failed',
      changed: false,
      error: 'pull access denied',
    });
    writeFileSync(path.join(dir, 'state'), 'id=r3\nphase=weird\n');
    expect(readDockerState(dir)).toBeNull();
  });

  it('treats the sidecar as alive only while its heartbeat is fresh', () => {
    const now = Date.now();
    expect(dockerUpdaterAlive(dir, now)).toBe(false);
    const alive = path.join(dir, 'alive');
    writeFileSync(alive, '');
    expect(dockerUpdaterAlive(dir, now)).toBe(true);
    const stale = new Date(now - 60_000);
    utimesSync(alive, stale, stale);
    expect(dockerUpdaterAlive(dir, now)).toBe(false);
  });
});
