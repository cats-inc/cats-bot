import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { AppUpdater } from 'electron-updater';
import { InstallHandoffTimeout, type BotUpdater } from './controller.ts';

/** Adapted from cats-platform desktop/host/updaterAdapter.ts at f09c2901 (MIT). */
export function configureUpdater(updater: AppUpdater): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = true;
  updater.channel = null as unknown as string;
  updater.setFeedURL({ provider: 'github', owner: 'cats-inc', repo: 'cats-bots' });
  updater.allowDowngrade = false;
}

export interface UpdaterLifecycle {
  onQuit(listener: () => void): () => void;
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
  async function request<T>(start: () => Promise<T>): Promise<T> {
    if (pending) throw new Error('The previous update request is still finishing. Try again shortly.');
    const underlying = Promise.resolve().then(start);
    pending = underlying;
    void underlying.finally(() => { if (pending === underlying) pending = null; }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([underlying, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The update request timed out. Please try again.')), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
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
      return request(async () => {
        if (!checkedVersion) throw new Error('Check for updates first.');
        const expected = checkedVersion;
        let completedVersion: string | null = null;
        let acceptingProgress = true;
        const onProgress = (info: { percent: number }) => { if (acceptingProgress) progress(info.percent); };
        const onDownloaded = (info: { version: string }) => { completedVersion = info.version; };
        updater.on('download-progress', onProgress);
        updater.on('update-downloaded', onDownloaded);
        // The native promise remains fenced after the caller's timeout.
        const progressTimer = setTimeout(() => { acceptingProgress = false; }, timeoutMs);
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
          clearTimeout(progressTimer);
          updater.removeListener('download-progress', onProgress);
          updater.removeListener('update-downloaded', onDownloaded);
        }
      });
    },
    async prepareInstall() {
      if (pending || !downloadedVersion || downloadedVersion !== checkedVersion || !artifacts.length) throw new Error('No completed matching download is ready.');
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

/** Only a verified electron-updater download path is accepted; never use a shell. */
export function installDebianUpdate(file: string, quit: () => void): Promise<void> {
  if (!isAbsolute(file) || !file.endsWith('.deb')) return Promise.reject(new Error('Invalid verified Debian package.'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pkexec', ['/usr/bin/apt-get', 'install', '--yes', file], { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) {
        const message = 'The package manager exited ' + (code ?? 'without a result') + '. Finish or close the installer before reopening Cats Bot.';
        // pkexec 126/127 means authorization was cancelled/denied before apt ran.
        // Any apt failure may already have changed installed files.
        reject(code === 126 || code === 127 ? new Error(message) : new InstallHandoffTimeout(message));
      }
      else { quit(); resolve(); }
    });
    // A host timeout must not kill apt/dpkg while installed files are being changed.
  });
}
