import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');
const testOnly = process.argv.includes('--test');

// Runtime wasm assets live next to the bundle so locateFile() can find them.
mkdirSync('dist/wasm', { recursive: true });
const wasmFiles = [
  require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  require.resolve('tree-sitter-c/tree-sitter-c.wasm'),
  require.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm'),
  require.resolve('sql.js/dist/sql-wasm.wasm'),
];
for (const f of wasmFiles) copyFileSync(f, path.join('dist/wasm', path.basename(f)));

const common = { bundle: true, sourcemap: true, logLevel: 'info', minify: false };

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node14',
  external: ['vscode'],
};

const worker = {
  ...common,
  entryPoints: ['src/core/worker.ts'],
  outfile: 'dist/worker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node14',
};

const parseWorker = {
  ...common,
  entryPoints: ['src/core/parseWorker.ts'],
  outfile: 'dist/parseWorker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node14',
};

const workerBench = {
  ...common,
  entryPoints: ['src/core/worker-bench.ts'],
  outfile: 'dist/worker-bench.js',
  platform: 'node',
  format: 'cjs',
  target: 'node14',
};

const coreTest = {
  ...common,
  entryPoints: ['src/core/core-test.ts'],
  outfile: 'dist/core-test.js',
  platform: 'node',
  format: 'cjs',
  target: 'node14',
};

const relationWebview = {
  ...common,
  entryPoints: ['webview/relation.ts'],
  outfile: 'media/relation.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

const suiteTest = {
  ...common,
  entryPoints: ['test/suite.ts', 'test/suite-ffmpeg.ts'],
  outdir: 'dist/test',
  platform: 'node',
  format: 'cjs',
  target: 'node14',
  external: ['vscode'],
};

if (testOnly) {
  await Promise.all([coreTest, suiteTest, worker, parseWorker, workerBench].map((o) => esbuild.build(o)));
} else if (watch) {
  const ctxs = await Promise.all([extension, worker, parseWorker, relationWebview].map((o) => esbuild.context(o)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all([extension, worker, parseWorker, relationWebview].map((o) => esbuild.build(o)));
}
