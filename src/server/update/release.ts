export const DEFAULT_UPDATE_REPO = 'J3n5en/EnsoCode';
export const SERVER_CHECKSUMS_ASSET = 'enso-server-checksums.txt';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ServerRelease {
  version: string;
  name?: string;
  notes?: string;
  assets: ReleaseAsset[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function comparePre(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    const diff = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : Math.sign(nx - ny);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isReleaseVersion(value: string | undefined): value is string {
  return typeof value === 'string' && SEMVER.test(value.trim());
}

/** 无法解析的版本视为相等：不把 dev/垃圾标签当成新版本 */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePre(x[4], y[4]);
}

export function serverAssetName(arch: string): string | null {
  const name = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  return name ? `enso-server-linux-${name}.tar.gz` : null;
}

/** GitHub releases/latest 响应 → 白名单形状 */
export function parseRelease(payload: unknown): ServerRelease | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  if (raw.draft === true || typeof raw.tag_name !== 'string') return null;
  const match = SEMVER.exec(raw.tag_name.trim());
  if (!match) return null;
  const assets: ReleaseAsset[] = [];
  for (const item of Array.isArray(raw.assets) ? raw.assets : []) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
    assets.push({
      name: a.name,
      url: a.browser_download_url,
      size: typeof a.size === 'number' ? a.size : 0,
    });
  }
  return {
    version: raw.tag_name.trim().replace(/^v/, ''),
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
    ...(typeof raw.body === 'string' && raw.body ? { notes: raw.body } : {}),
    assets,
  };
}

/** sha256sum 输出（`<hash>  <name>` 或 `<hash> *<name>`） */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match) map.set(match[2], match[1].toLowerCase());
  }
  return map;
}
