import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';

import { AppInfo } from 'app-builder-lib/out/appInfo.js';

import { resolveCatsBotHome } from '../../src/core/store/paths.ts';

// SPEC-007 FR-9. The NSIS script runs only inside electron-builder, so these
// checks read it as text and tie its names to the ones the app and
// electron-builder use.
const repoRoot = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const nsh = read('assets/installer/installer.nsh');
const main = read('src/shell/electron/main.ts');
const pkg = JSON.parse(read('package.json'));
const macro = (name: string) => new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`, 'u').exec(nsh)?.[1] ?? '';
const uninstall = macro('customUnInstall');
const roots = (text: string) => [...text.matchAll(/!insertmacro removeDataRoot "([^"]+)"/gu)].map((match) => match[1]!);
// electron-updater's download cache is named from the packaged package name.
const updaterCache = new AppInfo({ metadata: { ...pkg, ...pkg.build.extraMetadata }, config: pkg.build } as never, null).updaterCacheDirName;
const code = nsh.split('\n').filter((line) => !line.trimStart().startsWith(';')).join('\n');
const guarded = /\$\{IfNot\} \$\{isUpdated\}\s+\$\{AndIf\} \$installMode != "all"([\s\S]*)\$\{EndIf\}\s*$/u.exec(uninstall)?.[1] ?? '';

test('the uninstaller asks with an unchecked box, on a page only a per-user uninstall shows', () => {
  assert.equal(pkg.build.nsis.include, 'assets/installer/installer.nsh');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.match(nsh, /!ifdef BUILD_UNINSTALLER\s+[\s\S]*?UninstPage custom un\.UserDataRemovalPage un\.UserDataRemovalPageLeave[\s\S]*?!endif/u);
  // A per-machine install would remove another account's data: customUnInit,
  // which runs after initMultiUser, makes its uninstall skip the page.
  assert.match(nsh, /Function un\.UserDataRemovalPage\s+\$\{If\} \$RemoveUserDataPerUser != "1"\s+Abort/u);
  assert.match(macro('customUnInit'), /StrCpy \$RemoveUserDataPerUser "1"\s+\$\{If\} \$installMode == "all"\s+StrCpy \$RemoveUserDataPerUser ""/u);
  assert.match(nsh, /\$\{NSD_SetState\} \$RemoveUserDataCheckbox \$\{BST_UNCHECKED\}/u);
});

test('only the checked box removes data: the three roots the app and its updater write', () => {
  assert.equal(updaterCache, 'cats-bot-updater');
  const gate = /\$\{If\} \$RemoveUserDataState == \$\{BST_CHECKED\}([\s\S]*?)\$\{EndIf\}\s+\$\{EndIf\}\s*$/u.exec(guarded)?.[1] ?? '';
  const expected = [`$PROFILE\\${basename(resolveCatsBotHome({}))}`, `$APPDATA\\${pkg.build.productName}`, `$LOCALAPPDATA\\${updaterCache}`];
  assert.deepEqual(roots(gate), expected);
  assert.deepEqual(roots(uninstall), expected, 'nothing is removed outside the gate');
  // The shell's Electron user data and the installation gate both live in the second root.
  assert.match(main, new RegExp(`join\\(app\\.getPath\\('appData'\\), '${pkg.build.productName}', 'bots'`, 'u'));
  assert.match(read('src/shell/electron/update/installation.ts'), new RegExp(`join\\(appData, '${pkg.build.productName}', 'installations'`, 'u'));
  for (const root of expected) assert.ok(gate.includes(`!insertmacro noteDataRootLeft "${root}"`), `reports ${root} if it remains`);
  assert.match(gate, /MessageBox MB_OK\|MB_ICONEXCLAMATION "[^"]*\$RemoveUserDataLeft[^"]*" \/SD IDOK/u);
  const [description, checkbox] = [...nsh.matchAll(/NSD_Create(?:Label|Checkbox)\}[^"\n]*"([^"]+)"/gu)].map((match) => match[1]!);
  for (const shown of ['%USERPROFILE%\\.catsbot', `%APPDATA%\\${pkg.build.productName}`, `%LOCALAPPDATA%\\${updaterCache}`]) {
    assert.ok(description?.includes(shown), shown);
  }
  assert.ok(checkbox?.includes('%USERPROFILE%\\.catsbot') && checkbox.includes(`%APPDATA%\\${pkg.build.productName}`));
});

test('removing a root never follows a junction or symlink', () => {
  // NSIS's RMDir /r enters reparse points and empties their targets.
  assert.doesNotMatch(code, /RMDir \/r/u);
  const remove = macro('removeDataRoot');
  assert.match(remove, /GetFileAttributesW\(w "\$\{DIR\}"\) i \.R0'[\s\S]*IntOp \$R0 \$R0 & 0x400/u);
  assert.match(remove, /\$\{If\} \$R0 != 0\s+RMDir "\$\{DIR\}"\s+\$\{Else\}/u);
  // The path reaches cmd through a variable, so % and ! in it are never expanded.
  assert.match(remove, /SetEnvironmentVariableW\(w "CATS_REMOVE_ROOT", w "\$\{DIR\}"\) i \.R0'\s+nsExec::Exec '"\$SYSDIR\\cmd\.exe" \/d \/v:off \/c rd \/s \/q "%CATS_REMOVE_ROOT%"'\s+Pop \$R0/u);
});

test('a real per-user uninstall removes only this installation\'s login entries', () => {
  assert.match(guarded, /^\s+!insertmacro removeLoginEntries "\$\{CATS_BOT_RUN_KEY\}" "\$\{CATS_BOT_APPROVED_KEY\}"/u);
  const entries = macro('removeLoginEntries');
  assert.match(entries, /\$\{If\} \$R1 == "\$\{APP_ID\}"\s+\$\{OrIf\} \$R2 == "\$\{APP_ID\}\."/u);
  assert.match(entries, /\$\{If\} \$R2 == '"\$INSTDIR\\'\s+ClearErrors\s+DeleteRegValue HKCU "\$\{RUN_KEY\}" \$R1\s+\$\{IfNot\} \$\{Errors\}\s+DeleteRegValue HKCU "\$\{APPROVED_KEY\}" \$R1/u);
  // A value that is not deleted, the unnamed default one included, is stepped over.
  assert.match(entries, /\$\{If\} \$\{Errors\}\s+\$\{ExitDo\}\s+\$\{EndIf\}\s+StrCpy \$R5 ""/u);
  assert.match(entries, /\$\{If\} \$R5 == ""\s+IntOp \$R0 \$R0 \+ 1/u);
  // Electron names the Run value after the AUMID, which the shell derives from the appId.
  assert.match(main, new RegExp(`setAppUserModelId\\(\`${pkg.build.appId.replaceAll('.', '\\.')}\\.\\$\\{botId\\}\`\\)`, 'u'));
  assert.match(main, /app\.setLoginItemSettings\(\{ openAtLogin: enabled, args: \['--id', botId\] \}\)/u);
  // An uninstall that kept the data deleted the entry, so an installed Windows
  // copy restores the owner's choice, but only when no entry starts it: one
  // disabled in Task Manager stays disabled, and a portable copy never registers.
  assert.match(main, /if \(process\.platform === 'win32' && app\.isPackaged && !process\.env\.PORTABLE_EXECUTABLE_FILE\s+&& windows\.shellState\.openAtLogin && !app\.getLoginItemSettings\(\{ args: \['--id', botId\] \}\)\.openAtLogin\) applyLoginItem\(true\);/u);
});
