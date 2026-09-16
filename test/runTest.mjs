import { runTests } from '@vscode/test-electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Running from inside a VS Code terminal sets this and would make Code.exe behave like plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'si-lite-test-'));
const arg = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `=${dflt}`).split('=')[1];
const suite = arg('suite', 'suite');
const workspace = path.resolve(root, arg('workspace', 'test/fixture'));
const locale = arg('locale', '');
const version = arg('vscode', '');
// Set VSCODE_EXE to reuse a local install; otherwise a private copy is downloaded into .vscode-test/.
const vscodeExecutablePath = process.env.VSCODE_EXE || undefined;

try {
  await runTests({
    vscodeExecutablePath,
    ...(version ? { version } : {}),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist', 'test', `${suite}.js`),
    extensionTestsEnv: { VSCODE_USER_DATA_DIR: path.join(scratch, 'user') },
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      ...(locale ? [`--locale=${locale}`] : []),
      `--user-data-dir=${path.join(scratch, 'user')}`,
      `--extensions-dir=${path.join(scratch, 'ext')}`,
    ],
  });
} catch (e) {
  console.error('integration tests failed', e);
  process.exit(1);
}
