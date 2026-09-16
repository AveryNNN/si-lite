// Index a directory tree with the core pipeline and report timings. Run: node dist/bench.js <dir> [--no-refs]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCallGraph } from './graph';
import { indexText } from './indexText';
import { langForPath } from './languages';
import { ParserService } from './parser';
import { Store } from './store';

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c|h|cpp|cc|cxx|hpp|hh|hxx|inl)$/i.test(e.name)) out.push(p);
  }
}

const mb = (n: number) => (n / 1048576).toFixed(0) + 'MB';

async function main() {
  const dir = path.resolve(process.argv[2]);
  const indexReferences = !process.argv.includes('--no-refs');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const ignoreMacros: string[] = pkg.contributes.configuration.properties['siLite.ignoreMacros'].default;
  const wasmDir = path.join(__dirname, 'wasm');
  const dbPath = path.join(__dirname, 'bench.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const parser = new ParserService(wasmDir);
  await parser.init();
  const store = await Store.open(wasmDir, dbPath);

  const files: string[] = [];
  walk(dir, files);
  console.log(`files=${files.length} refs=${indexReferences}`);

  const t0 = Date.now();
  let lines = 0;
  let bytes = 0;
  let slowest: Array<[number, string]> = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const lang = langForPath(f, 'cpp');
    if (!lang) continue;
    const text = fs.readFileSync(f, 'utf8');
    bytes += text.length;
    lines += text.split('\n').length;
    const st = fs.statSync(f);
    const t = Date.now();
    await indexText(parser, store, f, lang, text, st.mtimeMs, st.size, { indexReferences, ignoreMacros });
    const dt = Date.now() - t;
    slowest.push([dt, path.relative(dir, f)]);
    if (slowest.length > 200) {
      slowest.sort((a, b) => b[0] - a[0]);
      slowest = slowest.slice(0, 5);
    }
    if (i % 500 === 0) {
      const m = process.memoryUsage();
      console.log(`  ${i}/${files.length}  ${Date.now() - t0}ms  rss=${mb(m.rss)} heap=${mb(m.heapUsed)}`);
    }
  }
  const indexMs = Date.now() - t0;
  const stats = store.stats();
  const m = process.memoryUsage();
  console.log(`indexed ${lines} lines / ${mb(bytes)} in ${indexMs}ms  (${(lines / (indexMs / 1000) / 1000).toFixed(0)}k lines/s)`);
  console.log(`stats`, stats, `rss=${mb(m.rss)} heap=${mb(m.heapUsed)}`);
  slowest.sort((a, b) => b[0] - a[0]);
  console.log('slowest files', slowest.slice(0, 5));

  let t = Date.now();
  store.save();
  console.log(`save: ${Date.now() - t}ms  size=${mb(fs.statSync(dbPath).size)}`);

  t = Date.now();
  const store2 = await Store.open(wasmDir, dbPath);
  console.log(`reload: ${Date.now() - t}ms`, store2.stats());

  // Query latency on a hot symbol.
  const probes = ['main', 'av_malloc', 'avcodec_open2', 'ff_get_buffer', 'AVCodecContext', 'av_log'];
  for (const name of probes) {
    t = Date.now();
    const defs = store2.findDefinitions(name);
    const d1 = Date.now() - t;
    if (!defs.length) {
      console.log(`  ${name}: not found`);
      continue;
    }
    t = Date.now();
    const callers = store2.callersOf(name).length;
    const d2 = Date.now() - t;
    t = Date.now();
    const refs = store2.referencesOf(name).length;
    const d3 = Date.now() - t;
    t = Date.now();
    const g = buildCallGraph(store2, defs[0], 'both', 2, 150);
    const d4 = Date.now() - t;
    console.log(
      `  ${name}: ${defs.length} defs (${defs[0].kind}) ${d1}ms | callers=${callers} ${d2}ms | refs=${refs} ${d3}ms | graph ${g.nodes.length}n/${g.edges.length}e ${d4}ms${g.truncated ? ' truncated' : ''}`,
    );
  }
  t = Date.now();
  const s = store2.searchSymbols('avcodec_', 200);
  console.log(`  search 'avcodec_': ${s.length} in ${Date.now() - t}ms`);
  t = Date.now();
  const kc = store2.kindCounts();
  console.log(`  kindCounts ${Date.now() - t}ms`, Object.fromEntries(kc.map((k) => [k.kind, k.count])));
  t = Date.now();
  store2.symbolsByKind('function', 2001);
  console.log(`  symbolsByKind(function) ${Date.now() - t}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
