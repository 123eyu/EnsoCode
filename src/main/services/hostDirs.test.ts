import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listHostDirs } from './hostDirs';

describe('listHostDirs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'host-dirs-'));
    mkdirSync(path.join(home, 'beta'));
    mkdirSync(path.join(home, 'Alpha'));
    mkdirSync(path.join(home, '.hidden'));
    writeFileSync(path.join(home, 'file.txt'), '');
    symlinkSync(path.join(home, 'beta'), path.join(home, 'linked'));
    symlinkSync(path.join(home, 'missing'), path.join(home, 'dangling'));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('defaults to home and lists visible subdirectories including symlinked ones', async () => {
    const result = await listHostDirs(undefined, home);
    expect(result).toEqual({
      ok: true,
      path: home,
      parent: path.dirname(home),
      dirs: ['Alpha', 'beta', 'linked'],
    });
  });

  it('expands ~ and resolves relative input against home', async () => {
    expect(await listHostDirs('~/beta', home)).toMatchObject({ path: path.join(home, 'beta') });
    expect(await listHostDirs('Alpha', home)).toMatchObject({ path: path.join(home, 'Alpha') });
  });

  it('falls back to the nearest existing ancestor for a half-typed path', async () => {
    const result = await listHostDirs(path.join(home, 'beta', 'not', 'yet'), home);
    expect(result).toMatchObject({ ok: true, path: path.join(home, 'beta') });
    expect(await listHostDirs(path.join(home, 'file.txt'), home)).toMatchObject({ path: home });
  });

  it('reports root as having no parent', async () => {
    expect(await listHostDirs(path.parse(home).root, home)).toMatchObject({ parent: null });
  });
});
