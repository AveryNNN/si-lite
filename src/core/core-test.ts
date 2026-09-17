// Standalone smoke test for the vscode-free core. Run: npm run test:core
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildCallGraph, buildClassGraph, buildIncludeGraph } from './graph';
import { indexText } from './indexText';
import { ParserService } from './parser';
import { Store } from './store';
import { Resolver } from './resolver';
import { renderLine } from '../views/syntax';
import { ContextRenderer } from '../views/contextRender';
import { setLocaleResolver } from '../i18n';

const C_SRC = `#include "util.h"
#include <stdio.h>
#define MAX 10
#define SQUARE(x) ((x) * (x))
typedef struct point { int x; int y; } point_t;
typedef struct { int w; int h; } size_t2;
enum color { RED, GREEN };
static int helper(int a);
int g_counter;
int (*fp)(int);
void (*signal_like(int sig))(int);

/* Entry point */
int main(void) {
  point_t p = { 1, 2 };
  int r = helper(p.x);
  printf("%d %d\\n", r, g_counter);
  return SQUARE(r);
}

static int helper(int a) {
  g_counter++;
  return a + MAX;
}
`;

const MACRO_SRC = `static void av_cold jpeg2000_init_tier1_luts(void) { helper(1); }
av_unused av_cold static int pcm_encode_init(int x) { return x; }
`;

const RES_SRC = `struct pkt { int c; int size; };
typedef struct { float c; } s2_t;
struct pkt g_pkt;
int c;
struct pkt *get_pkt(void);
void work(struct pkt *p, int n, s2_t *sp) {
  float c = 1;
  for (int i = 0; i < n; i++) { c += p->c; }
  sp->c = 2;
  ((s2_t *)p)->c = 3;
  g_pkt.c = c;
  get_pkt()->size = n;
  c = 0;
}
void other(void) { c = 5; }
`;

const H_SRC = `#pragma once
int util_add(int a, int b);
`;

const CPP_SRC = `#include "util.h"
class Bar {};
class Baz : public Bar, private Qux<int> {};
namespace ns {
class Foo : public Bar {
public:
  void run(int x);
  int inlineOne() { return util_add(1, 2); }
private:
  int value_;
};
}
void ns::Foo::run(int x) { helper(x); obj.method(x); this->inlineOne(); }
template <typename T> T add(T a, T b) { return a + b; }
`;

async function main() {
  const wasmDir = path.join(__dirname, 'wasm');
  const parser = new ParserService(wasmDir);
  await parser.init();
  const store = await Store.open(wasmDir);
  const opts = { indexReferences: true };

  await indexText(parser, store, 'D:/proj/src/main.c', 'c', C_SRC, 1, C_SRC.length, opts);
  await indexText(parser, store, 'D:/proj/inc/util.h', 'cpp', H_SRC, 1, H_SRC.length, opts);
  await indexText(parser, store, 'D:/proj/src/foo.cpp', 'cpp', CPP_SRC, 1, CPP_SRC.length, opts);

  await indexText(parser, store, 'D:/proj/src/macros.c', 'c', MACRO_SRC, 1, MACRO_SRC.length, { ...opts, ignoreMacros: ['av_cold', 'av_unused'] });
  assert.equal(store.findSymbols('jpeg2000_init_tier1_luts')[0]?.kind, 'function', 'decorator macro after type');
  assert.equal(store.findSymbols('jpeg2000_init_tier1_luts')[0].col, 20, 'columns preserved after blanking');
  assert.equal(store.findSymbols('pcm_encode_init')[0]?.kind, 'function', 'decorator macros before storage class');
  assert.equal(store.findSymbols('av_cold').length, 0);
  store.removeFile('D:/proj/src/macros.c');

  const kinds = Object.fromEntries(store.kindCounts().map((k) => [k.kind, k.count]));
  console.log('kinds', kinds);

  const main = store.findDefinitions('main');
  assert.equal(main.length, 1);
  assert.equal(main[0].kind, 'function');
  assert.equal(main[0].line, 13);

  const helper = store.findSymbols('helper');
  assert.deepEqual(helper.map((h) => h.kind), ['function', 'prototype']);

  assert.equal(store.findSymbols('fp')[0].kind, 'variable', 'function pointer var');
  assert.equal(store.findSymbols('signal_like')[0].kind, 'prototype', 'function returning fn pointer');
  assert.equal(store.findSymbols('point_t')[0].kind, 'typedef');
  assert.equal(store.findSymbols('point')[0].kind, 'struct');
  assert.equal(store.findSymbols('RED')[0].kind, 'enumerator');
  assert.equal(store.findSymbols('SQUARE')[0].kind, 'macro');
  assert.equal(store.findSymbols('g_counter')[0].kind, 'variable');
  assert.equal(store.findSymbols('x')[0].kind, 'field');

  const run = store.findSymbols('run');
  assert.equal(run.find((r) => r.kind === 'function')?.qualname, 'ns::Foo::run');
  assert.equal(run.find((r) => r.kind === 'prototype')?.qualname, 'ns::Foo::run');
  assert.equal(store.findSymbols('inlineOne')[0].kind, 'method');
  assert.equal(store.findSymbols('inlineOne')[0].qualname, 'ns::Foo::inlineOne');
  assert.equal(store.findSymbols('Foo')[0].kind, 'class');
  assert.equal(store.findSymbols('ns')[0].kind, 'namespace');

  const bar = store.findDefinitions('Bar')[0];
  assert.deepEqual(store.derivedOf('Bar').map((d) => d.qualname).sort(), ['Baz', 'ns::Foo']);
  assert.deepEqual(store.basesOf(store.findDefinitions('Baz')[0].id).map((b) => [b.name, !!b.symbol]), [['Bar', true], ['Qux', false]]);
  const cg = buildClassGraph(store, bar, 'both', 2, 50);
  assert.equal(cg.nodes.length, 3);
  assert.equal(cg.edges.length, 2);

  assert.deepEqual(store.functionsUsingAll(['helper', 'printf']).map((r) => r.symbol.name), ['main']);
  assert.deepEqual(store.functionsUsingAll(['g_counter']).map((r) => r.symbol.name).sort(), ['helper', 'main']);
  assert.equal(store.functionsUsingAll(['helper', 'nope']).length, 0);

  // Call graph: ⊕ expansion beyond the depth limit, and folder grouping of large fan-in.
  const runSym = store.findDefinitions('run').find((r) => r.kind === 'function')!;
  const g1 = buildCallGraph(store, runSym, 'callees', 1, 100);
  const inlineNode = g1.nodes.find((n) => n.label === 'inlineOne')!;
  assert.deepEqual(inlineNode.expandable, ['callees'], 'leaf that calls something is expandable');
  assert.ok(!g1.nodes.some((n) => n.label === 'util_add'), 'depth 1 stops before util_add');
  const inlineId = Number(inlineNode.id.slice(4));
  const g2 = buildCallGraph(store, runSym, 'callees', 1, 100, { expanded: new Map([[inlineId, 'callees']]) });
  assert.ok(g2.nodes.some((n) => n.label === 'util_add'), 'expanded node shows its callees');
  assert.equal(g2.nodes.find((n) => n.label === 'inlineOne')!.expandedDir, 'callees');
  for (let i = 0; i < 8; i++) {
    const dir = i < 5 ? 'a' : 'b';
    await indexText(parser, store, `D:/proj/${dir}/caller${i}.c`, 'c', `void caller${i}(void) { helper(${i}); }`, 1, 10, opts);
  }
  const helperSym = store.findDefinitions('helper')[0];
  const g3 = buildCallGraph(store, helperSym, 'callers', 1, 100, { groupThreshold: 4, relRoot: 'D:/proj' });
  const groups = g3.nodes.filter((n) => n.kind === 'group').map((n) => n.label).sort();
  assert.deepEqual(groups, ['a/ (5)', 'b/ (3)', 'src/ (2)'], 'callers folded by folder above the threshold');
  const gidA = g3.nodes.find((n) => n.label === 'a/ (5)')!.id;
  const g4 = buildCallGraph(store, helperSym, 'callers', 1, 100, { groupThreshold: 4, relRoot: 'D:/proj', expandedGroups: new Set([gidA]) });
  assert.equal(g4.nodes.filter((n) => n.label.startsWith('caller')).length, 5, 'opened folder shows its members');
  for (let i = 0; i < 8; i++) store.removeFile(`D:/proj/${i < 5 ? 'a' : 'b'}/caller${i}.c`);

  // Syntax lexer used by the Context view.
  const lx = renderLine('static int x = 10; /* start', false);
  assert.match(lx.html, /tk-k">static</);
  assert.match(lx.html, /tk-n">10</);
  assert.ok(lx.inComment, 'unterminated block comment carries over');
  assert.match(renderLine('end */ foo(1);', true).html, /tk-c">end \*\/<\/span>.*tk-f">foo</);

  const callers = store.callersOf('helper');
  assert.deepEqual(callers.map((c) => c.fromSymbol?.qualname).sort(), ['main', 'ns::Foo::run']);

  const callees = store.calleesOf(main[0].id);
  assert.deepEqual(callees.map((c) => c.name), ['helper', 'printf', 'SQUARE']);
  assert.equal(callees.find((c) => c.name === 'SQUARE')?.target?.kind, 'macro');
  assert.equal(callees.find((c) => c.name === 'printf')?.target, undefined);

  const refs = store.referencesOf('g_counter');
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map((r) => r.fromSymbol?.name), ['main', 'helper']);

  assert.deepEqual(store.membersOf('point').map((m) => m.name), ['x', 'y']);
  assert.deepEqual(store.membersOf('size_t2').map((m) => m.qualname), ['size_t2::w', 'size_t2::h'], 'anonymous typedef struct members');
  const rf = store.referenceFiles('helper');
  assert.equal(rf.length, 2);
  assert.equal(rf.find((f) => f.path.endsWith('main.c'))?.calls, 1);
  const inFile = store.referencesInFile('helper', store.getFile('D:/proj/src/main.c')!.id);
  assert.deepEqual(inFile.map((r) => [r.kind, r.from]), [['call', 'main']]);

  // Context renderer (vscode-free): definition + members + per-file uses.
  const sources: Record<string, string> = { 'D:/proj/src/main.c': C_SRC, 'D:/proj/inc/util.h': H_SRC, 'D:/proj/src/foo.cpp': CPP_SRC };
  const renderer = new ContextRenderer(store, async (p) => sources[p]?.split('\n'), (p) => p.replace('D:/proj/', ''));
  let html = await renderer.render('point_t', store.findDefinitions('point_t'));
  assert.match(html, /class="members"/);
  assert.match(html, /<mark>(<span[^>]*>)?point_t/, 'usage row highlights the symbol');
  assert.ok(html.indexOf('class="members"') < html.indexOf('details class="file"'), 'members listed before uses');
  html = await renderer.render('helper', store.findDefinitions('helper'));
  assert.match(html, /1 calls|1 处调用/, 'per-file badge');
  assert.match(html, /class="fn"[^>]*>main</, 'enclosing function shown');
  // Ordering by closeness to the origin: same file first, then by directory distance; hidden ones last.
  renderer.origin = { path: 'D:/proj/src/foo.cpp', fnName: 'ns::Foo::run' };
  html = await renderer.render('helper', store.findDefinitions('helper'));
  const firstGroup = /<details class="file"[^>]*data-path="([^"]+)"/.exec(html)?.[1];
  assert.equal(firstGroup, 'D:/proj/src/foo.cpp', 'origin file group comes first');
  assert.match(html, /本函数|current function/, 'same-function sub-header');
  renderer.origin = { path: 'D:/proj/src/main.c', fnName: 'main' };
  renderer.filter = async (p, refs) => (p.endsWith('foo.cpp') ? [] : refs); // pretend foo.cpp's helper is a different symbol
  html = await renderer.render('helper', store.findDefinitions('helper'));
  assert.equal(/<details class="file"[^>]*data-path="([^"]+)"/.exec(html)?.[1], 'D:/proj/src/main.c');
  assert.ok(html.indexOf('data-key="kept:') < html.indexOf('data-block="hidden"'), 'hidden block after kept groups');
  assert.ok(html.indexOf('data-block="hidden"') < html.indexOf('data-variant="hidden"'), 'rejected occurrences listed inside the hidden block');
  renderer.filter = undefined;
  renderer.origin = undefined;

  let filterCalls = 0;
  renderer.filter = async (_p, refs) => (filterCalls++, refs);
  renderer.shouldAbort = () => filterCalls >= 1; // obsolete after the first file
  html = await renderer.render('helper', store.findDefinitions('helper'));
  assert.ok(filterCalls <= 1, 'aborted render stops analysing files');
  assert.ok(!html.includes('data-block="uses"') || html.length < 400, 'aborted render yields no uses section');
  renderer.shouldAbort = undefined;
  renderer.filter = undefined;

  setLocaleResolver(() => 'zh-cn');
  html = await renderer.render('helper', store.findDefinitions('helper'));
  assert.match(html, /全工程引用/);
  setLocaleResolver(() => 'en');

  // Scope/type-aware resolver on the current file's tree.
  await indexText(parser, store, 'D:/proj/src/res.c', 'c', RES_SRC, 1, RES_SRC.length, opts);
  const resParsed = (await parser.parse('c', RES_SRC))!;
  const resolver = new Resolver(store);
  const at = (needle: string, offset = 0) => {
    const idx = RES_SRC.indexOf(needle) + offset;
    const before = RES_SRC.slice(0, idx);
    return { line: before.split('\n').length - 1, col: idx - before.lastIndexOf('\n') - 1 };
  };
  const r1 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('c += p->c'));
  assert.equal(r1?.kind, 'local');
  if (r1?.kind === 'local') {
    assert.equal(r1.typeText, 'float');
    assert.equal(r1.scopeName, 'work');
    assert.equal(r1.refs.length, 4, 'float c: declaration + c += + g_pkt.c = c + c = 0');
    assert.equal(r1.decl.start.line, 6);
  }
  const r2 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('p->c', 3));
  assert.equal(r2?.kind, 'member');
  if (r2?.kind === 'member') assert.equal(r2.symbol.qualname, 'pkt::c');
  const r3 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('sp->c', 4));
  assert.equal(r3?.kind, 'member');
  if (r3?.kind === 'member') assert.equal(r3.symbol.qualname, 's2_t::c', 'typedef anonymous struct member');
  const r4 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('((s2_t *)p)->c', 13));
  assert.equal(r4?.kind, 'member');
  if (r4?.kind === 'member') assert.equal(r4.symbol.qualname, 's2_t::c', 'cast expression type');
  const r5 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('g_pkt.c', 6));
  if (r5?.kind === 'member') assert.equal(r5.symbol.qualname, 'pkt::c', 'global variable type');
  else assert.fail('g_pkt.c should resolve via the global variable type');
  const r6 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('get_pkt()->size', 11));
  if (r6?.kind === 'member') assert.equal(r6.symbol.qualname, 'pkt::size', 'call return type');
  else assert.fail('get_pkt()->size should resolve via the return type');
  const r7 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('i < n', 4));
  assert.equal(r7?.kind, 'local');
  if (r7?.kind === 'local') assert.ok(r7.isParam && r7.typeText === 'int');
  const r8 = resolver.resolve(resParsed.tree, 'D:/proj/src/res.c', at('c = 5'));
  assert.equal(r8?.kind, 'symbols', 'global int c, not the float local');
  if (r8?.kind === 'symbols') assert.equal(r8.symbols[0].signature, 'int c;');
  resParsed.tree.delete();
  store.removeFile('D:/proj/src/res.c');

  const enclosing = store.enclosingFunction('D:/proj/src/main.c', 15);
  assert.equal(enclosing?.name, 'main');

  const graph = buildCallGraph(store, main[0], 'both', 2, 100);
  const labels = graph.nodes.map((n) => n.label).sort();
  assert.deepEqual(labels, ['SQUARE', 'helper', 'main', 'printf']);
  assert.equal(graph.edges.length, 3);

  const mainFile = store.getFile('D:/proj/src/main.c')!;
  const incs = store.includesOf(mainFile.id);
  assert.equal(incs[0].resolved?.path, 'D:/proj/inc/util.h');
  assert.equal(incs[1].resolved, undefined);
  const by = store.includedBy('D:/proj/inc/util.h');
  assert.deepEqual(by.map((b) => b.file.path).sort(), ['D:/proj/src/foo.cpp', 'D:/proj/src/main.c']);
  const ig = buildIncludeGraph(store, store.getFile('D:/proj/inc/util.h')!, 'both', 1, 50);
  assert.equal(ig.nodes.length, 3);

  // Re-index replaces rows instead of duplicating.
  await indexText(parser, store, 'D:/proj/src/main.c', 'c', C_SRC, 2, C_SRC.length, opts);
  assert.equal(store.findDefinitions('main').length, 1);
  store.removeFile('D:/proj/src/main.c');
  assert.equal(store.findSymbols('main').length, 0);

  const s = store.searchSymbols('inl');
  assert.equal(s[0].name, 'inlineOne');

  console.log('stats', store.stats());
  console.log('core test OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
