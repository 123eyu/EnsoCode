import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseChecksums,
  parseRelease,
  SERVER_CHECKSUMS_ASSET,
  serverAssetName,
} from './release';

describe('compareVersions', () => {
  it('orders numeric parts and treats prereleases as older', () => {
    expect(compareVersions('0.2.12', '0.2.13')).toBeLessThan(0);
    expect(compareVersions('v0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
  });

  it('never reports garbage as newer', () => {
    expect(compareVersions('0.2.12', 'latest')).toBe(0);
    expect(compareVersions('dev', '0.2.12')).toBe(0);
  });
});

describe('serverAssetName', () => {
  it('maps node arch to release asset names', () => {
    expect(serverAssetName('x64')).toBe('enso-server-linux-amd64.tar.gz');
    expect(serverAssetName('arm64')).toBe('enso-server-linux-arm64.tar.gz');
    expect(serverAssetName('ia32')).toBeNull();
  });
});

describe('parseRelease', () => {
  it('keeps version, notes and downloadable assets', () => {
    const release = parseRelease({
      tag_name: 'v0.3.0',
      name: 'EnsoCode 0.3.0',
      body: 'notes',
      draft: false,
      assets: [
        { name: 'enso-server-linux-arm64.tar.gz', browser_download_url: 'https://x/a', size: 10 },
        { name: SERVER_CHECKSUMS_ASSET, browser_download_url: 'https://x/c', size: 1 },
        { name: 'broken' },
      ],
    });
    expect(release).toEqual({
      version: '0.3.0',
      name: 'EnsoCode 0.3.0',
      notes: 'notes',
      assets: [
        { name: 'enso-server-linux-arm64.tar.gz', url: 'https://x/a', size: 10 },
        { name: SERVER_CHECKSUMS_ASSET, url: 'https://x/c', size: 1 },
      ],
    });
  });

  it('rejects drafts and malformed payloads', () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ tag_name: 'v1.0.0', draft: true, assets: [] })).toBeNull();
    expect(parseRelease({ tag_name: 'nightly', assets: [] })).toBeNull();
  });
});

describe('parseChecksums', () => {
  it('reads sha256sum output and ignores junk', () => {
    const hash = 'a'.repeat(64);
    const map = parseChecksums(
      `${hash}  enso-server-linux-amd64.tar.gz\n${'B'.repeat(64)} *enso-server-linux-arm64.tar.gz\nnope line\n`
    );
    expect(map.get('enso-server-linux-amd64.tar.gz')).toBe(hash);
    expect(map.get('enso-server-linux-arm64.tar.gz')).toBe('b'.repeat(64));
    expect(map.size).toBe(2);
  });
});
