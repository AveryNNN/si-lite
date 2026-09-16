// Full-project indexing runs here, off the extension host thread. Large jobs fan parsing out to
// helper threads (parseWorker.ts) while this thread owns the database and does the inserts.
// Protocol: main -> { type: 'start', ... } | { type: 'cancel' }
//           worker -> { type: 'progress', done, total } | { type: 'done', stats, indexed, cancelled, timing } | { type: 'error', message }
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker, parentPort } from 'node:worker_threads';
import type { FileIndex } from './extractor';
import { indexText } from './indexText';
import type { Lang } from './languages';
import { ParserService } from './parser';
import type { ParseInit, ParseJob, ParseResult } from './parseWorker';
import { decodeRefs } from './refCodec';
import { Store } from './store';

export interface WorkerFile {
  path: string;
  lang: Lang;
  mtime: number;
  size: number;
}

export interface StartMessage {
  type: 'start';
  wasmDir: string;
  dbPath: string;
  files: WorkerFile[];
  indexReferences: boolean;
  ignoreMacros: string[];
  encoding?: string;
  /** Parse helper threads; 0 = decide from CPU count. */
  parallelism?: number;
}

const PARALLEL_MIN_FILES = 150;

let cancelled = false;

function decideParallelism(requested: number | undefined, fileCount: number): number {
  if (fileCount < PARALLEL_MIN_FILES) return 0;
  if (requested && requested > 0) return Math.min(requested, 8);
  const cpus = os.cpus().length;
  return Math.max(0, Math.min(4, cpus - 2));
}

async function run(msg: StartMessage): Promise<void> {
  const t0 = Date.now();
  const store = await Store.open(msg.wasmDir, msg.dbPath);
  const tOpen = Date.now() - t0;
  const total = msg.files.length;
  let done = 0;
  let indexed = 0;
  const report = () => {
    if (done % 25 === 0 || done === total) parentPort!.postMessage({ type: 'progress', done, total });
  };

  const parallel = decideParallelism(msg.parallelism, total);
  if (parallel > 0) {
    await runParallel(msg, store, parallel, (ok) => {
      done++;
      if (ok) indexed++;
      report();
    });
  } else {
    const parser = new ParserService(msg.wasmDir);
    await parser.init();
    let decoder: InstanceType<typeof TextDecoder>;
    try {
      decoder = new TextDecoder(msg.encoding ?? 'utf-8', { fatal: false });
    } catch {
      decoder = new TextDecoder('utf-8', { fatal: false });
    }
    for (const f of msg.files) {
      if (cancelled) break;
      try {
        const text = decoder.decode(fs.readFileSync(f.path));
        await indexText(parser, store, f.path, f.lang, text, f.mtime, f.size, {
          indexReferences: msg.indexReferences,
          ignoreMacros: msg.ignoreMacros,
        });
        indexed++;
      } catch (e) {
        parentPort!.postMessage({ type: 'fileError', path: f.path, message: (e as Error).message });
      }
      done++;
      report();
    }
  }

  const tIndex = Date.now() - t0 - tOpen;
  store.save();
  const tSave = Date.now() - t0 - tOpen - tIndex;
  const m = process.memoryUsage();
  parentPort!.postMessage({
    type: 'done',
    stats: store.stats(),
    indexed,
    cancelled,
    timing: `open=${tOpen}ms index=${tIndex}ms save=${tSave}ms rss=${(m.rss / 1048576).toFixed(0)}MB parallel=${parallel}`,
  });
  store.close();
}

/** Hand files to `n` parse threads; insert results here as they arrive. */
function runParallel(msg: StartMessage, store: Store, n: number, onFile: (ok: boolean) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const queue = [...msg.files];
    let inFlight = 0;
    let finished = false;
    const workers: Worker[] = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const w of workers) void w.terminate();
      resolve();
    };
    const feed = (w: Worker) => {
      if (cancelled || !queue.length) {
        if (inFlight === 0) finish();
        return;
      }
      const f = queue.shift()!;
      inFlight++;
      const job: ParseJob = { type: 'file', path: f.path, lang: f.lang, mtime: f.mtime, size: f.size };
      w.postMessage(job);
    };
    for (let i = 0; i < n; i++) {
      const w = new Worker(path.join(__dirname, 'parseWorker.js'));
      workers.push(w);
      w.on('message', (r: ParseResult | { type: 'ready' }) => {
        if (r.type === 'ready') {
          feed(w);
          return;
        }
        inFlight--;
        if (r.error) {
          parentPort!.postMessage({ type: 'fileError', path: r.path, message: r.error });
          onFile(false);
        } else {
          try {
            const index: FileIndex = { symbols: r.symbols, includes: r.includes, bases: r.bases, refs: decodeRefs(r.names, r.refData) };
            store.replaceFile(r.path, r.mtime, r.size, r.lang, index);
            onFile(true);
          } catch (e) {
            parentPort!.postMessage({ type: 'fileError', path: r.path, message: (e as Error).message });
            onFile(false);
          }
        }
        feed(w);
      });
      w.on('error', (e) => {
        if (!finished) {
          finished = true;
          for (const x of workers) void x.terminate();
          reject(e);
        }
      });
      const init: ParseInit = { type: 'init', wasmDir: msg.wasmDir, indexReferences: msg.indexReferences, ignoreMacros: msg.ignoreMacros, encoding: msg.encoding };
      w.postMessage(init);
    }
  });
}

parentPort!.on('message', (msg: StartMessage | { type: 'cancel' }) => {
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  run(msg).catch((e) => parentPort!.postMessage({ type: 'error', message: (e as Error).stack ?? String(e) }));
});
