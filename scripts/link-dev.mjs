// Development install: make VS Code load this working copy directly.
//   node scripts/link-dev.mjs        replace the installed extension folder with a junction to this repo
//   node scripts/link-dev.mjs --undo remove the junction and reinstall the packaged .vsix
// Afterwards keep `npm run watch` running; with siLite.devAutoReload enabled every rebuild reloads
// the windows that use the extension.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`.toLowerCase();
const extDir = path.join(homedir(), '.vscode', 'extensions');
const codeCli = process.env.VSCODE_CLI || 'code';

function installed() {
  if (!existsSync(extDir)) return [];
  return readdirSync(extDir).filter((d) => d.toLowerCase().startsWith(id + '-')).map((d) => path.join(extDir, d));
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

const undo = process.argv.includes('--undo');
let dirs = installed();

if (undo) {
  for (const d of dirs) {
    if (isJunction(d)) {
      rmSync(d, { recursive: false, force: true });
      console.log('removed link', d);
    }
  }
  const vsix = readdirSync(repo).find((f) => f.endsWith('.vsix'));
  if (!vsix) throw new Error('no .vsix in the repo; run npm run package first');
  run(codeCli, ['--install-extension', path.join(repo, vsix), '--force']);
  console.log('reinstalled', vsix);
  process.exit(0);
}

if (!dirs.length) {
  // Register the extension once so VS Code's extensions.json knows the id, then swap the folder.
  const vsix = readdirSync(repo).find((f) => f.endsWith('.vsix'));
  if (!vsix) throw new Error('no .vsix in the repo; run npm run package first');
  run(codeCli, ['--install-extension', path.join(repo, vsix), '--force']);
  dirs = installed();
}
if (!existsSync(path.join(repo, 'dist', 'extension.js'))) run('npm', ['run', 'build']);

for (const d of dirs) {
  if (isJunction(d)) {
    console.log('already linked:', d);
    continue;
  }
  rmSync(d, { recursive: true, force: true });
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', d, repo], { stdio: 'inherit' });
  else execFileSync('ln', ['-s', repo, d], { stdio: 'inherit' });
  console.log(`linked ${d} -> ${repo}`);
}
console.log('\nNext: reload the VS Code window once, run `npm run watch`, and turn on siLite.devAutoReload.');

function isJunction(p) {
  try {
    return path.resolve(realpathSync(p)).toLowerCase() === path.resolve(repo).toLowerCase();
  } catch {
    return false;
  }
}
