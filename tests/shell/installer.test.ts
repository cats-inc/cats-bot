import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';

import { resolveCatsBotHome } from '../../src/core/store/paths.ts';

// SPEC-007 FR-9. The NSIS script runs only inside electron-builder, so these
// checks read it as text and tie its names to the ones the app uses.
const repoRoot = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const nsh = read('assets/installer/installer.nsh');
const pkg = JSON.parse(read('package.json'));
const uninstall = /!macro customUnInstall([\s\S]*?)!macroend/u.exec(nsh)?.[1] ?? '';
const removals = (text: string) => [...text.matchAll(/RMDir \/r "([^"]+)"/gu)].map((match) => match[1]!);

test('the uninstaller asks with an unchecked box, on a page only the uninstaller has', () => {
  assert.equal(pkg.build.nsis.include, 'assets/installer/installer.nsh');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.match(nsh, /!ifdef BUILD_UNINSTALLER\s+[\s\S]*?UninstPage custom un\.UserDataRemovalPage un\.UserDataRemovalPageLeave[\s\S]*?!endif/u);
  assert.match(nsh, /\$\{NSD_SetState\} \$RemoveUserDataCheckbox \$\{BST_UNCHECKED\}/u);
});

test('only the checked box removes data, and only the two roots the app writes', () => {
  const gate = /\$\{If\} \$RemoveUserDataState == \$\{BST_CHECKED\}([\s\S]*?)\$\{EndIf\}/u.exec(uninstall);
  assert.ok(gate, 'customUnInstall gates removal on the checkbox');
  assert.deepEqual(removals(uninstall), removals(gate[1]!), 'nothing is removed outside the gate');
  const appData = pkg.build.productName;
  assert.deepEqual(removals(gate[1]!), [`$PROFILE\\${basename(resolveCatsBotHome({}))}`, `$APPDATA\\${appData}`]);
  // The shell's Electron user data and the installation gate both live there.
  assert.match(read('src/shell/electron/main.ts'), new RegExp(`join\\(app\\.getPath\\('appData'\\), '${appData}', 'bots'`, 'u'));
  assert.match(read('src/shell/electron/update/installation.ts'), new RegExp(`join\\(appData, '${appData}', 'installations'`, 'u'));
  const labels = [...nsh.matchAll(/NSD_Create(?:Label|Checkbox)\}[^"\n]*"([^"]+)"/gu)].map((match) => match[1]!);
  assert.equal(labels.length, 2);
  for (const label of labels) {
    assert.ok(label.includes('%USERPROFILE%\\.catsbot') && label.includes(`%APPDATA%\\${appData}`), label);
  }
});

test('a real uninstall, never an update, removes the login entries named after the appId', () => {
  assert.match(uninstall, /\$\{IfNot\} \$\{isUpdated\}\s+!insertmacro removeLoginEntries "Software\\Microsoft\\Windows\\CurrentVersion\\Run"\s+\$\{EndIf\}/u);
  assert.match(nsh, /\$R1 == "\$\{APP_ID\}"/u);
  assert.match(nsh, /\$R2 == "\$\{APP_ID\}\."/u);
  // Electron names a login entry after the AUMID, which the shell derives from the appId.
  const aumid = pkg.build.appId.replaceAll('.', '\\.');
  assert.match(read('src/shell/electron/main.ts'), new RegExp(`setAppUserModelId\\(\`${aumid}\\.\\$\\{botId\\}\`\\)`, 'u'));
});
