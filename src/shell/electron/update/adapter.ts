import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, mkdirSync, openSync, readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import type { AppUpdater } from 'electron-updater';
import { InstallHandoffTimeout, type BotUpdater } from './controller.ts';

/** Adapted from cats-platform desktop/host/updaterAdapter.ts at f09c2901 (MIT). */
export function configureUpdater(updater: AppUpdater): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = true;
  updater.channel = null as unknown as string;
  updater.setFeedURL({ provider: 'github', owner: 'cats-inc', repo: 'cats-bot' });
  updater.allowDowngrade = false;
}

export interface UpdaterLifecycle {
  onQuit(listener: () => void): () => void;
  /** Refuses an installation this process could not complete, before anything is stopped. */
  assertCanInstall?: () => void;
  installDeb?: (verifiedFile: string) => Promise<void>;
  fingerprint?: (file: string) => Promise<string>;
}
async function fingerprintFile(file: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}
export function createUpdaterAdapter(updater: AppUpdater, lifecycle: UpdaterLifecycle, timeoutMs = 120_000): BotUpdater {
  updater.on('error', () => undefined);
  let pending: Promise<unknown> | null = null;
  let checkedVersion: string | null = null;
  let downloadedVersion: string | null = null;
  let downloadedFile: string | null = null;
  let artifacts: { file: string; hash: string }[] = [];
  let expectedFiles = new Map<string, string>();
  const fingerprint = lifecycle.fingerprint ?? fingerprintFile;
  async function request<T>(start: (activity: () => void) => Promise<T>): Promise<T> {
    if (pending) throw new Error('The previous update request is still finishing. Try again shortly.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refresh = () => {};
    const timeout = new Promise<never>((_resolve, reject) => {
      refresh = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => reject(new Error('The update request timed out. Please try again.')), timeoutMs);
      };
      refresh();
    });
    const underlying = Promise.resolve().then(() => start(() => { if (timer) refresh(); }));
    pending = underlying;
    void underlying.finally(() => { if (pending === underlying) pending = null; }).catch(() => undefined);
    try {
      return await Promise.race([underlying, timeout]);
    } finally { if (timer) clearTimeout(timer); timer = undefined; }
  }
  return {
    async check() {
      return request(async () => {
        checkedVersion = null; downloadedVersion = null; downloadedFile = null; artifacts = []; expectedFiles = new Map();
        const result = await updater.checkForUpdates();
        if (!result) throw new Error('The updater is unavailable for this installation.');
        for (const file of result.updateInfo.files ?? []) {
          const name = basename(decodeURIComponent(new URL(file.url, 'https://github.com/').pathname));
          if (!name || !file.sha512 || expectedFiles.has(name)) throw new Error('Invalid release download metadata.');
          expectedFiles.set(name, file.sha512);
        }
        if (!expectedFiles.size) throw new Error('The release has no verified download metadata.');
        checkedVersion = result.updateInfo.version;
        return checkedVersion;
      });
    },
    async download(progress) {
      let acceptingProgress = true;
      try {
        await request(async activity => {
          if (!checkedVersion) throw new Error('Check for updates first.');
          lifecycle.assertCanInstall?.();
          const expected = checkedVersion;
          let completedVersion: string | null = null;
          let previousTransferred = 0;
          let previousPercent = 0;
          const onProgress = (info: { percent: number; transferred?: number }) => {
            if (!acceptingProgress) return;
            // A large/differential download can take more than two minutes while
            // advancing. Time out inactivity, rather than the whole transfer.
            if (typeof info.transferred === 'number' && Number.isFinite(info.transferred) && info.transferred >= 0) {
              if (info.transferred > previousTransferred) activity();
              previousTransferred = info.transferred;
            } else if (Number.isFinite(info.percent) && info.percent > previousPercent) activity();
            if (Number.isFinite(info.percent)) {
              previousPercent = info.percent;
              progress(info.percent);
            }
          };
          const onDownloaded = (info: { version: string }) => { completedVersion = info.version; };
          updater.on('download-progress', onProgress);
          updater.on('update-downloaded', onDownloaded);
          try {
            const files = await updater.downloadUpdate();
            if (completedVersion !== expected || checkedVersion !== expected) throw new Error('Downloaded update identity changed. Check again.');
            if (!files.length || files.some(file => !isAbsolute(file))) throw new Error('No verified update files were returned.');
            artifacts = await Promise.all(files.map(async file => {
              const expectedHash = expectedFiles.get(basename(file));
              if (!expectedHash) throw new Error('The downloaded file is not in the selected release metadata.');
              if (await fingerprint(file) !== expectedHash) {
                // Native in-memory cache hits only check existence. Remove a bad
                // cache file so the next explicit retry fetches verified bytes.
                await unlink(file).catch(() => undefined);
                throw new Error('The downloaded update failed checksum validation. Check for updates and download it again.');
              }
              return { file, hash: expectedHash };
            }));
            downloadedVersion = expected;
            downloadedFile = files.find(file => isAbsolute(file) && file.endsWith('.deb')) ?? null;
          } finally {
            updater.removeListener('download-progress', onProgress);
            updater.removeListener('update-downloaded', onDownloaded);
          }
        });
      } finally {
        // The native promise remains fenced after a timeout, but its late
        // progress must not update the failed operation's UI.
        acceptingProgress = false;
      }
    },
    async prepareInstall() {
      if (pending || !downloadedVersion || downloadedVersion !== checkedVersion || !artifacts.length) throw new Error('No completed matching download is ready.');
      lifecycle.assertCanInstall?.();
      try {
        for (const artifact of artifacts) if (await fingerprint(artifact.file) !== artifact.hash) throw new Error('Changed update file.');
      } catch {
        downloadedVersion = null; artifacts = [];
        throw new Error('The downloaded update was removed or changed. Check for updates and download it again.');
      }
    },
    async install() {
      if (pending || !downloadedVersion || downloadedVersion !== checkedVersion) throw new Error('No completed matching download is ready.');
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let detachQuit = () => undefined as void;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          updater.removeListener('error', onError);
          detachQuit();
          if (error) reject(error); else resolve();
        };
        const onError = (error: Error) => finish(error);
        updater.on('error', onError);
        try {
          detachQuit = lifecycle.onQuit(() => finish());
          if (lifecycle.installDeb) {
            if (!downloadedFile) throw new Error('A verified Debian package was not downloaded.');
            void lifecycle.installDeb(downloadedFile).catch(error => finish(error));
          } else updater.quitAndInstall(false, true);
          if (!settled) timer = setTimeout(() => finish(new InstallHandoffTimeout('The installer has not confirmed completion. Finish or close it before reopening Cats Bot.')), timeoutMs);
        } catch (error) { finish(error); }
      });
    },
  };
}

const NO_NEW_PRIVILEGES = /^NoNewPrivs:\s*1\s*$/mu;

/**
 * NoNewPrivs is inherited and cannot be cleared, and pkexec cannot gain root under it. Older versions
 * relaunched through Electron, which sets it, so a cold start is the only way out. An unreadable status
 * proves nothing: pkexec still reports the real outcome.
 */
export function assertCanElevate(readStatus: () => string = () => readFileSync('/proc/self/status', 'utf8')): void {
  let status: string;
  try { status = readStatus(); } catch { return; }
  if (NO_NEW_PRIVILEGES.test(status)) {
    throw new Error('Cats Bot cannot ask for administrator rights in this session, so the update was not installed and your bots are still running. Quit Cats Bot from the tray, open it again from the applications menu, then install the update.');
  }
}

const STDERR_TAIL_CHARACTERS = 300;

/** The last output is what explains a failure; the whole dialog error is limited in length. */
function stderrTail(file: string): string {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text.length > STDERR_TAIL_CHARACTERS ? text.slice(-STDERR_TAIL_CHARACTERS) : text;
  } catch { return ''; }
}

/**
 * A file, not a pipe: if this host dies mid-install, apt must not lose its stderr to SIGPIPE,
 * and the output stays readable afterwards. This is only diagnostics, so it can never block the install.
 */
function openStderrLog(file: string): number | 'ignore' {
  try {
    mkdirSync(dirname(file), { recursive: true });
    return openSync(file, 'w', 0o600);
  } catch { return 'ignore'; }
}

/** Only a verified electron-updater download path is accepted; never use a shell. */
export function installDebianUpdate(file: string, quit: () => void, stderrLog: string, pkexec = '/usr/bin/pkexec'): Promise<void> {
  if (!isAbsolute(file) || !file.endsWith('.deb')) return Promise.reject(new Error('Invalid verified Debian package.'));
  return new Promise((resolve, reject) => {
    const stderr = openStderrLog(stderrLog);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pkexec, ['/usr/bin/apt-get', 'install', '--yes', file], { stdio: ['ignore', 'ignore', stderr], shell: false });
    } catch (error) {
      reject(error);
      return;
    } finally { if (stderr !== 'ignore') closeSync(stderr); }
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) { quit(); resolve(); return; }
      const detail = stderr === 'ignore' ? '' : stderrTail(stderrLog);
      const suffix = detail ? ' ' + detail : '';
      // pkexec returns these before apt runs: 126 is a dismissed prompt, 127 is no authorization or no way to get it.
      if (code === 126) reject(new Error('The administrator prompt was closed, so the update was not installed.'));
      else if (code === 127) reject(new Error('Cats Bot could not get administrator rights, so the update was not installed.' + suffix));
      // Any apt failure may already have changed installed files.
      else reject(new InstallHandoffTimeout('The package manager exited ' + (code ?? 'without a result') + '. Finish or close the installer before reopening Cats Bot.' + suffix));
    });
    // A host timeout must not kill apt/dpkg while installed files are being changed.
  });
}
