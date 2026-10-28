import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ServerUpdateMode, UpdaterState, UpdateStatus } from '@shared/types/updater';
import { AUTO_RESTART_IDLE_MS } from '@shared/updater/idleRestart';
import {
  IdleRestartGate,
  type IdleRestartObservation,
} from '../../main/services/updater/idleRestartGate';
import {
  activateBundle,
  bundleInstallDir,
  downloadVerified,
  failedVersion,
  markBootHealthy,
  pruneReleases,
  stageBundle,
} from './bundle';
import { dockerUpdaterAlive, readDockerState, writeDockerRequest } from './dockerControl';
import {
  compareVersions,
  DEFAULT_UPDATE_REPO,
  isReleaseVersion,
  parseChecksums,
  parseRelease,
  SERVER_CHECKSUMS_ASSET,
  type ServerRelease,
  serverAssetName,
} from './release';

export interface ServerUpdaterDeps {
  version: string;
  appRoot: string;
  arch: string;
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  broadcast: (status: UpdateStatus) => void;
  quit: () => void;
  idle: () => IdleRestartObservation;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_CHECK_MS = 30_000;
const HEALTHY_AFTER_MS = 60_000;
const DOCKER_POLL_MS = 1_000;
const DOCKER_PULL_TIMEOUT_MS = 30 * 60 * 1000;
const DOCKER_APPLY_TIMEOUT_MS = 2 * 60 * 1000;
const BUSY_POLL_MS = 5_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 无界面服务端的自更新，对外与桌面 AutoUpdater 同一组 IPC 语义：
 * check → available → download → downloaded → quitAndInstall。
 * docker：经共享卷让 updater sidecar 拉镜像、compose 重建；bundle：下载安装包解到 releases/ 并切 current，
 * 由 systemd 拉起新版本；其余部署只报告新版本。
 */
export class ServerUpdater {
  private status: UpdateStatus | null = null;
  private latest: ServerRelease | null = null;
  private downloadedVersion: string | null = null;
  private running: Promise<void> | null = null;
  private autoUpdate = false;
  private autoRestartWhenIdle = false;
  private applying = false;
  private readonly idleGate = new IdleRestartGate();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly installDir: string | null;
  private readonly controlDir: string;

  constructor(private readonly deps: ServerUpdaterDeps) {
    this.installDir =
      deps.env.ENSO_UPDATE_MODE === 'bundle' ? bundleInstallDir(deps.appRoot) : null;
    this.controlDir = deps.env.ENSO_UPDATE_CONTROL_DIR || '/control';
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  mode(): ServerUpdateMode {
    const env = this.deps.env.ENSO_UPDATE_MODE;
    if (env === 'docker' && dockerUpdaterAlive(this.controlDir, this.now())) return 'docker';
    if (env === 'bundle' && this.installDir) return 'bundle';
    return 'manual';
  }

  canRestart(): boolean {
    return this.deps.env.ENSO_SUPERVISED === '1' || Boolean(this.deps.env.INVOCATION_ID);
  }

  state(): UpdaterState {
    return {
      host: 'server',
      status: this.status,
      mode: this.mode(),
      canRestart: this.canRestart(),
    };
  }

  start(autoUpdate: boolean, autoRestartWhenIdle: boolean): void {
    this.autoRestartWhenIdle = autoRestartWhenIdle;
    this.setAutoUpdateEnabled(autoUpdate);
    const installDir = this.installDir;
    if (installDir) this.later(HEALTHY_AFTER_MS, () => markBootHealthy(installDir));
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.clearIdleTimer();
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private setStatus(status: UpdateStatus, force = false): void {
    if (!force && this.downloadedVersion && status.status !== 'downloaded') return;
    this.status = status;
    this.deps.broadcast(status);
  }

  private fail(error: unknown): void {
    this.downloadedVersion = null;
    this.setStatus({ status: 'error', error: message(error) }, true);
  }

  private exclusive(task: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    this.running = task().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async fetchLatest(): Promise<ServerRelease | null> {
    const api = (this.deps.env.ENSO_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '');
    const repo = this.deps.env.ENSO_UPDATE_REPO || DEFAULT_UPDATE_REPO;
    const token = this.deps.env.ENSO_GITHUB_TOKEN?.trim();
    const response = await this.deps.fetch(`${api}/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `enso-server/${this.deps.version}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`release check failed: HTTP ${response.status}`);
    return parseRelease(await response.json());
  }

  checkForUpdates(): Promise<void> {
    if (this.downloadedVersion) return Promise.resolve();
    return this.exclusive(async () => {
      this.setStatus({ status: 'checking' });
      let release: ServerRelease | null;
      try {
        release = await this.fetchLatest();
      } catch (error) {
        this.fail(error);
        return;
      }
      if (!release || compareVersions(release.version, this.deps.version) <= 0) {
        this.setStatus({
          status: 'not-available',
          info: { version: release?.version ?? this.deps.version },
        });
        return;
      }
      if (this.installDir && failedVersion(this.installDir) === release.version) {
        this.fail(`${release.version} failed to start and was rolled back`);
        return;
      }
      this.latest = release;
      this.setStatus({ status: 'available', info: this.info(release.version) });
      if (this.autoUpdate && this.mode() !== 'manual') await this.fetchUpdate();
    });
  }

  downloadUpdate(): Promise<void> {
    if (this.downloadedVersion) return Promise.resolve();
    return this.exclusive(() => this.fetchUpdate());
  }

  private info(version: string): NonNullable<UpdateStatus['info']> {
    const release = this.latest;
    return {
      version,
      ...(release?.version === version && release.notes ? { releaseNotes: release.notes } : {}),
      ...(release?.version === version && release.name ? { releaseName: release.name } : {}),
    };
  }

  private async fetchUpdate(): Promise<void> {
    const mode = this.mode();
    try {
      if (mode === 'docker') await this.pullImage();
      else if (mode === 'bundle') await this.fetchBundle();
      else throw new Error('this deployment cannot update itself');
    } catch (error) {
      this.fail(error);
      return;
    }
    this.idleGate.reset();
    this.notifyIdleStateChanged();
  }

  private async dockerRequest(action: 'pull' | 'apply', timeoutMs: number) {
    const id = `${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    writeDockerRequest(this.controlDir, id, action);
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      await this.sleep(DOCKER_POLL_MS);
      const state = readDockerState(this.controlDir);
      if (state?.id !== id || state.phase === 'running') continue;
      if (state.phase === 'failed') throw new Error(state.error || `docker ${action} failed`);
      return state;
    }
    throw new Error(`docker ${action} timed out`);
  }

  private async pullImage(): Promise<void> {
    this.setStatus({
      status: 'downloading',
      progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 },
    });
    const state = await this.dockerRequest('pull', DOCKER_PULL_TIMEOUT_MS);
    // 镜像带版本 label 时以它为准；本地构建没有 label 时退回“镜像是否变化”
    const newer = isReleaseVersion(state.version)
      ? compareVersions(state.version, this.deps.version) > 0
      : state.changed;
    if (!newer) throw new Error('the image registry has no newer image yet');
    this.markDownloaded(
      isReleaseVersion(state.version) ? state.version : (this.latest?.version ?? 'latest')
    );
  }

  private async fetchBundle(): Promise<void> {
    const installDir = this.installDir;
    const release = this.latest;
    if (!installDir || !release) throw new Error('check for updates first');
    const staged = path.join(installDir, 'releases', release.version);
    if (existsSync(path.join(staged, 'bin', 'enso-server'))) {
      this.markDownloaded(release.version);
      return;
    }
    const name = serverAssetName(this.deps.arch);
    const asset = release.assets.find((a) => a.name === name);
    const sums = release.assets.find((a) => a.name === SERVER_CHECKSUMS_ASSET);
    if (!name || !asset || !sums)
      throw new Error(`release has no ${name ?? this.deps.arch} bundle`);
    const sumsResponse = await this.deps.fetch(sums.url);
    if (!sumsResponse.ok) throw new Error(`checksums download failed: HTTP ${sumsResponse.status}`);
    const sha = parseChecksums(await sumsResponse.text()).get(name);
    if (!sha) throw new Error(`no checksum for ${name}`);
    const tarball = path.join(installDir, 'downloads', name);
    const started = this.now();
    let lastPercent = -1;
    await downloadVerified(
      asset.url,
      tarball,
      sha,
      ({ transferred, total }) => {
        const size = total || asset.size;
        const percent = size ? Math.floor((transferred / size) * 100) : 0;
        if (percent === lastPercent) return;
        lastPercent = percent;
        const seconds = Math.max((this.now() - started) / 1000, 0.001);
        this.setStatus({
          status: 'downloading',
          progress: { percent, bytesPerSecond: transferred / seconds, total: size, transferred },
        });
      },
      (url) => this.deps.fetch(url)
    );
    try {
      stageBundle(installDir, release.version, tarball);
    } finally {
      rmSync(tarball, { force: true });
    }
    this.markDownloaded(release.version);
  }

  private markDownloaded(version: string): void {
    this.downloadedVersion = version;
    this.setStatus({ status: 'downloaded', info: this.info(version) });
  }

  async quitAndInstall(): Promise<void> {
    const version = this.downloadedVersion;
    if (!version || this.applying) return;
    this.applying = true;
    try {
      if (this.mode() === 'docker') {
        // sidecar 用 compose 重建容器，本进程会收到 SIGTERM 正常退出；走到这里说明没被替换
        await this.dockerRequest('apply', DOCKER_APPLY_TIMEOUT_MS);
        throw new Error('docker compose did not recreate the server');
      }
      const installDir = this.installDir;
      if (!installDir) throw new Error('this deployment cannot update itself');
      activateBundle(installDir, version);
      pruneReleases(installDir);
      this.deps.quit();
    } catch (error) {
      this.applying = false;
      this.fail(error);
    }
  }

  restart(): void {
    if (!this.canRestart()) throw new Error('enso-server is not running under a supervisor');
    this.deps.quit();
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    this.autoUpdate = enabled;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (enabled) {
      this.interval = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
      this.interval.unref?.();
      this.later(INITIAL_CHECK_MS, () => void this.checkForUpdates());
    }
    this.notifyIdleStateChanged();
  }

  setAutoRestartWhenIdle(enabled: boolean): void {
    this.autoRestartWhenIdle = enabled;
    if (!enabled) this.idleGate.reset();
    this.notifyIdleStateChanged();
  }

  private notifyIdleStateChanged(): void {
    this.clearIdleTimer();
    if (
      this.applying ||
      this.idleGate.isFailed() ||
      !this.downloadedVersion ||
      !this.autoUpdate ||
      !this.autoRestartWhenIdle
    ) {
      return;
    }
    const now = this.now();
    if (this.idleGate.evaluate(this.deps.idle(), now)) {
      void this.quitAndInstall();
      return;
    }
    const remaining = this.idleGate.delayUntilReadyMs(now);
    const delay = Math.min(
      remaining === null ? BUSY_POLL_MS : Math.max(remaining, 250),
      AUTO_RESTART_IDLE_MS
    );
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.notifyIdleStateChanged();
    }, delay);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
