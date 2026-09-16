// Drive dist/worker.js the way the extension does, outside VS Code. Usage: node dist/worker-bench.js <dir> [parallelism]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { langForPath } from './languages';
import { normalizePath } from './store';
import type { StartMessage, WorkerFile } from './worker';

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c|h|cpp|cc|cxx|hpp|hh|hxx|inl)$/i.test(e.name)) out.push(p);
  }
}

const dir = path.resolve(process.argv[2]);
const parallelism = Number(process.argv[3] ?? 0);
const files: WorkerFile[] = [];
const list: string[] = [];
walk(dir, list);
for (const f of list) {
  const lang = langForPath(f, 'cpp');
  if (!lang) continue;
  const st = fs.statSync(f);
  files.push({ path: normalizePath(f), lang, mtime: Math.floor(st.mtimeMs), size: st.size });
}
const dbPath = path.join(__dirname, 'worker-bench.sqlite');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const t0 = Date.now();
const w = new Worker(path.join(__dirname, 'worker.js'));
w.on('message', (m: { type: string; [k: string]: unknown }) => {
  if (m.type === 'done') {
    console.log(`files=${files.length} total=${Date.now() - t0}ms ${m.timing} stats=${JSON.stringify(m.stats)}`);
    void w.terminate();
  } else if (m.type === 'error') {
    console.error(m.message);
    process.exit(1);
  } else if (m.type === 'fileError') console.error('file error', m.path, m.message);
});
const msg: StartMessage = { type: 'start', wasmDir: path.join(__dirname, 'wasm'), dbPath, files, indexReferences: true, ignoreMacros: ['av_cold', 'av_unused', 'av_always_inline', 'attribute_align_arg'], parallelism };
w.postMessage(msg);
