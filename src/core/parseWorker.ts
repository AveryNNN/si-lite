// Parse+extract helper thread used by the build worker. Results are sent as typed arrays so the
// structured clone stays cheap even for files with tens of thousands of references.
import * as fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { extract, type FileIndex } from './extractor';
import { encodeRefs } from './refCodec';
import { blankMacros } from './indexText';
import type { Lang } from './languages';
import { ParserService } from './parser';

export interface ParseInit {
  type: 'init';
  wasmDir: string;
  indexReferences: boolean;
  ignoreMacros: string[];
  encoding?: string;
}

export interface ParseJob {
  type: 'file';
  path: string;
  lang: Lang;
  mtime: number;
  size: number;
}

export interface ParseResult {
  type: 'result';
  path: string;
  lang: Lang;
  mtime: number;
  size: number;
  symbols: FileIndex['symbols'];
  includes: FileIndex['includes'];
  bases: FileIndex['bases'];
  /** Unique reference names in this file; refData points into it. */
  names: string[];
  /** [nameIdx, kind(0 call / 1 ref), line, col, fromSymbol] per reference. */
  refData: Int32Array;
  error?: string;
}

let parser: ParserService | undefined;
let init: ParseInit | undefined;
let decoder: InstanceType<typeof TextDecoder> | undefined;

async function handle(job: ParseJob): Promise<void> {
  if (!parser || !init) throw new Error('parse worker not initialised');
  const base = { type: 'result' as const, path: job.path, lang: job.lang, mtime: job.mtime, size: job.size };
  try {
    const text = decoder!.decode(fs.readFileSync(job.path));
    const parsed = await parser.parse(job.lang, blankMacros(text, init.ignoreMacros));
    if (!parsed) throw new Error('parse failed');
    let index: FileIndex;
    try {
      index = extract(parsed.tree, parsed.query, job.lang, { indexReferences: init.indexReferences, ignoreMacros: init.ignoreMacros });
    } finally {
      parsed.tree.delete();
    }
    const { names, refData } = encodeRefs(index);
    const msg: ParseResult = { ...base, symbols: index.symbols, includes: index.includes, bases: index.bases, names, refData };
    parentPort!.postMessage(msg, [refData.buffer as ArrayBuffer]);
  } catch (e) {
    const msg: ParseResult = { ...base, symbols: [], includes: [], bases: [], names: [], refData: new Int32Array(0), error: (e as Error).message };
    parentPort!.postMessage(msg);
  }
}

parentPort?.on('message', (msg: ParseInit | ParseJob) => {
  if (msg.type === 'init') {
    init = msg;
    try {
      decoder = new TextDecoder(msg.encoding ?? 'utf-8', { fatal: false });
    } catch {
      decoder = new TextDecoder('utf-8', { fatal: false });
    }
    parser = new ParserService(msg.wasmDir);
    void parser.init().then(() => parentPort!.postMessage({ type: 'ready' }));
    return;
  }
  void handle(msg);
});
