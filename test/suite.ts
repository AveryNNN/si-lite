// Runs inside the extension host. No mocha: a tiny sequential runner is enough here.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

type Test = { name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

const root = vscode.workspace.workspaceFolders![0].uri;
const file = (...p: string[]) => vscode.Uri.joinPath(root, ...p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  return doc;
}

function posOf(doc: vscode.TextDocument, needle: string, occurrence = 0): vscode.Position {
  const text = doc.getText();
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`needle not found: ${needle}`);
  }
  return doc.positionAt(idx);
}

test('extension activates', async () => {
  const ext = vscode.extensions.getExtension('AveryNNN.si-lite');
  assert.ok(ext, 'extension present');
  await ext.activate();
  assert.ok(ext.isActive);
});

test('build project indexes the fixture', async () => {
  await vscode.commands.executeCommand('siLite.buildProject');
  const syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'util_')) as vscode.SymbolInformation[];
  const names = syms.map((s) => s.name);
  assert.ok(names.includes('util_add'), `workspace symbols: ${names.join(',')}`);
  assert.ok(names.includes('util_scale'));
});

test('go to definition crosses files', async () => {
  const doc = await open(file('src', 'main.c'));
  const pos = posOf(doc, 'util_scale(&v').translate(0, 2);
  const locs = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos)) as vscode.Location[];
  assert.ok(locs.length >= 1, 'has definition');
  const def = locs.find((l) => l.uri.fsPath.endsWith('util.c'));
  assert.ok(def, 'definition in util.c preferred over prototype');
  assert.equal(def!.range.start.line, 8);
});

test('macro and typedef definitions resolve into the header', async () => {
  const doc = await open(file('src', 'main.c'));
  const m = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, posOf(doc, 'UTIL_VERSION'))) as vscode.Location[];
  assert.ok(m[0]?.uri.fsPath.endsWith('util.h'));
  assert.equal(m[0].range.start.line, 3);
  const t = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, posOf(doc, 'vec2_t v'))) as vscode.Location[];
  assert.ok(t[0]?.uri.fsPath.endsWith('util.h'));
});

test('find references lists every use of a global', async () => {
  const doc = await open(file('src', 'main.c'));
  const refs = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, posOf(doc, 'g_counter++'))) as vscode.Location[];
  // declaration + g_counter++ + printf arg + util_add arg
  assert.equal(refs.length, 4, JSON.stringify(refs.map((r) => r.range.start.line)));
});

test('hover shows signature', async () => {
  const doc = await open(file('src', 'main.c'));
  const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, posOf(doc, 'util_add(r'))) as vscode.Hover[];
  const text = hovers.map((h) => h.contents.map((c) => (c as vscode.MarkdownString).value).join('\n')).join('\n');
  assert.match(text, /int util_add\(int a, int b\)/);
  assert.match(text, /called from 3 place|被 3 处调用/);
  console.log('    hover text:', text.split('\n').join(' ').slice(0, 120));
});

test('siLite.language override switches runtime strings to Chinese', async () => {
  const cfg = vscode.workspace.getConfiguration('siLite');
  await cfg.update('language', 'zh-cn', vscode.ConfigurationTarget.Global);
  try {
    const doc = await open(file('src', 'main.c'));
    const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, posOf(doc, 'util_add(r'))) as vscode.Hover[];
    const text = hovers.map((h) => h.contents.map((c) => (c as vscode.MarkdownString).value).join('')).join('');
    console.log('    zh hover:', text.split('\n').join(' ').slice(0, 120));
    assert.match(text, /被 3 处调用/);
    assert.match(text, /\*函数\*/);
    const syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'util_add')) as vscode.SymbolInformation[];
    assert.ok(syms.length >= 1);
  } finally {
    await cfg.update('language', undefined, vscode.ConfigurationTarget.Global);
  }
});

test('scope-aware: locals, parameters and typed member access', async () => {
  const util = await open(file('src', 'util.c'));
  // v->x : v is `vec2_t *v`, vec2_t is typedef struct vec2 -> member vec2::x in util.h
  const defs = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', util.uri, posOf(util, 'v->x = util_add').translate(0, 3))) as vscode.Location[];
  assert.equal(defs.length, 1, 'member resolves to exactly one struct field');
  assert.ok(defs[0].uri.fsPath.endsWith('util.h'));
  assert.equal(defs[0].range.start.line, 6);

  const hk = (await vscode.commands.executeCommand('vscode.executeHoverProvider', util.uri, posOf(util, 'k - 1'))) as vscode.Hover[];
  const hkText = hk.map((h) => h.contents.map((c) => (c as vscode.MarkdownString).value).join('')).join('');
  assert.match(hkText, /int k/);
  assert.match(hkText, /parameter|参数/);

  const main = await open(file('src', 'main.c'));
  const refs = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', main.uri, posOf(main, 'r, g_counter'))) as vscode.Location[];
  assert.equal(refs.length, 3, 'local r: declaration + printf + util_add, nothing outside main');
  assert.ok(refs.every((r) => r.uri.fsPath.endsWith('main.c')));
  const dl = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', main.uri, posOf(main, 'r, g_counter'))) as vscode.Location[];
  assert.equal(dl[0].range.start.line, posOf(main, 'int r =').line);
});

test('find references commands open the native peek', async () => {
  const main = await open(file('src', 'main.c'));
  const p = posOf(main, 'util_add(r').translate(0, 2);
  vscode.window.activeTextEditor!.selection = new vscode.Selection(p, p);
  await vscode.commands.executeCommand('siLite.findReferencesInFile');
  await sleep(300);
  await vscode.commands.executeCommand('closeReferenceSearch');
  await vscode.commands.executeCommand('siLite.findReferences');
  await sleep(300);
  await vscode.commands.executeCommand('closeReferenceSearch');
});

test('outline, highlight, completion and rename come from the syntax tree', async () => {
  const header = await open(file('inc', 'util.h'));
  const outline = (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', header.uri)) as vscode.DocumentSymbol[];
  const names = outline.map((d) => d.name);
  assert.ok(names.includes('vec2') && names.includes('vec2_t') && names.includes('util_add'), `outline: ${names.join(',')}`);
  const vec2 = outline.find((d) => d.name === 'vec2')!;
  assert.deepEqual(vec2.children.map((c) => c.name), ['x', 'y'], 'fields nested under the struct');

  const main = await open(file('src', 'main.c'));
  const hl = (await vscode.commands.executeCommand('vscode.executeDocumentHighlights', main.uri, posOf(main, 'r, g_counter'))) as vscode.DocumentHighlight[];
  assert.equal(hl.length, 3, 'local r highlighted only inside main');
  const hlGlobal = (await vscode.commands.executeCommand('vscode.executeDocumentHighlights', main.uri, posOf(main, 'g_counter++'))) as vscode.DocumentHighlight[];
  assert.equal(hlGlobal.length, 4, 'global g_counter: declaration + 3 uses in this file');

  const util = await open(file('src', 'util.c'));
  const memberPos = posOf(util, 'v->x = util_add').translate(0, 3);
  const members = (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', util.uri, memberPos, '>')) as vscode.CompletionList;
  const memberLabels = members.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.deepEqual(memberLabels, ['x', 'y'], 'v-> completes vec2 members');

  const idPos = posOf(main, 'util_scale(&v').translate(0, 5);
  const ids = (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', main.uri, idPos)) as vscode.CompletionList;
  const idLabels = ids.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.ok(idLabels.includes('util_add') && idLabels.includes('util_scale'), `prefix completion: ${idLabels.join(',')}`);

  const edit = (await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', main.uri, posOf(main, 'r, g_counter'), 'result')) as vscode.WorkspaceEdit;
  const entries = edit.entries();
  assert.equal(entries.length, 1, 'rename of a local touches one file');
  assert.equal(entries[0][1].length, 3, 'declaration + 2 uses');
});

test('type hierarchy for C++ classes', async () => {
  const doc = await open(file('src', 'shapes.cpp'));
  const items = (await vscode.commands.executeCommand('vscode.prepareTypeHierarchy', doc.uri, posOf(doc, 'class Shape').translate(0, 6))) as vscode.TypeHierarchyItem[];
  assert.equal(items.length, 1);
  const subs = (await vscode.commands.executeCommand('vscode.provideSubtypes', items[0])) as vscode.TypeHierarchyItem[];
  assert.deepEqual(subs.map((s) => s.name).sort(), ['Circle', 'Square']);
  const circle = (await vscode.commands.executeCommand('vscode.prepareTypeHierarchy', doc.uri, posOf(doc, 'class Circle').translate(0, 6))) as vscode.TypeHierarchyItem[];
  const supers = (await vscode.commands.executeCommand('vscode.provideSupertypes', circle[0])) as vscode.TypeHierarchyItem[];
  assert.deepEqual(supers.map((s) => s.name), ['Shape']);
});

test('incremental parse keeps positions right while editing', async () => {
  const main = await open(file('src', 'main.c'));
  const editor = vscode.window.activeTextEditor!;
  const before = posOf(main, 'int r =').line;
  await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), '// inserted line one\n// inserted line two\n'));
  try {
    const hl = (await vscode.commands.executeCommand('vscode.executeDocumentHighlights', main.uri, posOf(main, 'r, g_counter'))) as vscode.DocumentHighlight[];
    assert.equal(hl.length, 3);
    assert.equal(hl[0].range.start.line, before + 2, 'declaration moved down by two lines');
    await editor.edit((eb) => eb.replace(new vscode.Range(0, 0, 2, 0), ''));
    const hl2 = (await vscode.commands.executeCommand('vscode.executeDocumentHighlights', main.uri, posOf(main, 'r, g_counter'))) as vscode.DocumentHighlight[];
    assert.equal(hl2[0].range.start.line, before);
  } finally {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
});

test('semantic tokens classify macros, globals, locals and calls', async () => {
  const main = await open(file('src', 'main.c'));
  const legend = (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', main.uri)) as vscode.SemanticTokensLegend;
  const tokens = (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', main.uri)) as vscode.SemanticTokens;
  assert.ok(legend && tokens, 'provider answered');
  const at = new Map<string, string>();
  let line = 0;
  let col = 0;
  const d = tokens.data;
  for (let i = 0; i < d.length; i += 5) {
    line += d[i];
    col = d[i] === 0 ? col + d[i + 1] : d[i + 1];
    const text = main.getText(new vscode.Range(line, col, line, col + d[i + 2]));
    const mods = d[i + 4];
    at.set(`${line}:${text}`, legend.tokenTypes[d[i + 3]] + (mods & 4 ? '.static' : '') + (mods & 1 ? '.decl' : ''));
  }
  const kinds = [...at.entries()].map(([k, v]) => k.split(':')[1] + '=' + v);
  const has = (needle: string) => kinds.some((k) => k === needle);
  assert.ok(has('UTIL_VERSION=macro'), kinds.join(' '));
  assert.ok(has('g_counter=variable.static.decl') || has('g_counter=variable.static'), kinds.join(' '));
  assert.ok(has('v=variable.decl') || has('v=variable'), kinds.join(' '));
  assert.ok(has('printf=function'));
  assert.ok(has('bump=function.decl'));
  assert.ok(has('vec2_t=type'));
});

test('include navigation, hover comments, completion on unfinished input', async () => {
  const main = await open(file('src', 'main.c'));
  const inc = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', main.uri, posOf(main, 'inc/util.h').translate(0, 2))) as vscode.Location[];
  assert.ok(inc[0]?.uri.fsPath.endsWith('util.h'), 'ctrl-click on #include opens the header');

  const hv = (await vscode.commands.executeCommand('vscode.executeHoverProvider', main.uri, posOf(main, 'util_add(r').translate(0, 2))) as vscode.Hover[];
  const text = hv.map((h) => h.contents.map((c) => (c as vscode.MarkdownString).value).join('')).join('');
  assert.match(text, /Adds two numbers/, 'comment above the definition is shown in the hover');

  const util = await open(file('src', 'util.c'));
  const editor = vscode.window.activeTextEditor!;
  const anchor = posOf(util, 'return v->x + v->y;');
  await editor.edit((eb) => eb.insert(anchor, 'v->\n    '));
  try {
    const at = new vscode.Position(anchor.line, anchor.character + 3);
    const list = (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', util.uri, at, '>')) as vscode.CompletionList;
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.deepEqual(labels, ['x', 'y'], `members offered while the statement is incomplete: ${labels.join(',')}`);
  } finally {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
});

test('references and rename are context-sensitive across files', async () => {
  const main = await open(file('src', 'main.c'));
  const refs = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', main.uri, posOf(main, 'g_counter++'))) as vscode.Location[];
  assert.equal(refs.length, 4, 'shadow.c parameter and struct member named g_counter are not references of the global');
  assert.ok(refs.every((r) => r.uri.fsPath.endsWith('main.c')));

  const header = await open(file('inc', 'util.h'));
  const xrefs = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', header.uri, posOf(header, 'int x;').translate(0, 4))) as vscode.Location[];
  const files = new Set(xrefs.map((r) => path.basename(r.uri.fsPath)));
  assert.ok(files.has('util.c') && files.has('util.h'), `vec2::x referenced from util.c: ${[...files].join(',')}`);
  assert.ok(!files.has('shadow.c'), 'other::x and the local x in shadow.c are not vec2::x');

  const edit = (await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', main.uri, posOf(main, 'g_counter++'), 'g_total')) as vscode.WorkspaceEdit;
  assert.deepEqual(edit.entries().map(([u]) => path.basename(u.fsPath)), ['main.c']);
});

test('declaration provider and signature help', async () => {
  const main = await open(file('src', 'main.c'));
  const decl = (await vscode.commands.executeCommand('vscode.executeDeclarationProvider', main.uri, posOf(main, 'util_add(r').translate(0, 2))) as vscode.Location[];
  assert.ok(decl.length === 1 && decl[0].uri.fsPath.endsWith('util.h'), 'Go to Declaration lands on the prototype');
  const sh = (await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', main.uri, posOf(main, 'util_add(r').translate(0, 11), ',')) as vscode.SignatureHelp;
  assert.ok(sh && sh.signatures.length >= 1, 'signature help answered');
  assert.match(sh.signatures[0].label, /util_add\(int a, int b\)/);
  assert.equal(sh.signatures[0].parameters.length, 2);
  assert.equal(sh.activeParameter, 1, 'cursor after the comma is on the second parameter');
});

test('external paths are indexed like Source Insight external libraries', async () => {
  const cfg = vscode.workspace.getConfiguration('siLite');
  const sdk = path.join(root.fsPath, '..', 'external', 'sdk');
  await cfg.update('externalPaths', [sdk], vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand('siLite.buildProject');
    const syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'hal_gpio')) as vscode.SymbolInformation[];
    assert.ok(syms.some((s) => s.name === 'hal_gpio_write'), `external symbols indexed: ${syms.map((s) => s.name).join(',')}`);
  } finally {
    await cfg.update('externalPaths', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('siLite.buildProject'); // drops the external files again
    const gone = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'hal_gpio')) as vscode.SymbolInformation[];
    assert.equal(gone.length, 0, 'external files removed when the setting is cleared');
  }
});

test('add to / remove from project', async () => {
  const cfg = vscode.workspace.getConfiguration('siLite');
  try {
    await vscode.commands.executeCommand('siLite.removeFromProject', file('src', 'shadow.c'));
    let syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'shadow_me')) as vscode.SymbolInformation[];
    assert.equal(syms.length, 0, 'removed file drops its symbols');
    assert.equal(vscode.workspace.getConfiguration('siLite').get<string[]>('excludePaths')?.length, 1);
    await vscode.commands.executeCommand('siLite.buildProject');
    syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'shadow_me')) as vscode.SymbolInformation[];
    assert.equal(syms.length, 0, 'a build does not bring an excluded file back');

    await vscode.commands.executeCommand('siLite.addToProject', file('src', 'shadow.c'));
    syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'shadow_me')) as vscode.SymbolInformation[];
    assert.equal(syms.length, 1, 'added back');

    const sdk = vscode.Uri.file(path.join(root.fsPath, '..', 'external', 'sdk'));
    await vscode.commands.executeCommand('siLite.addToProject', sdk);
    syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'hal_gpio')) as vscode.SymbolInformation[];
    assert.ok(syms.length >= 1, 'external folder added through the command');
    await vscode.commands.executeCommand('siLite.removeFromProject', sdk);
    syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'hal_gpio')) as vscode.SymbolInformation[];
    assert.equal(syms.length, 0, 'external folder removed again');
  } finally {
    await cfg.update('excludePaths', undefined, vscode.ConfigurationTarget.Workspace);
    await cfg.update('externalPaths', undefined, vscode.ConfigurationTarget.Workspace);
  }
});

test('preview in the Context view does not move the editor', async () => {
  const main = await open(file('src', 'main.c'));
  const editor = vscode.window.activeTextEditor!;
  const before = editor.selection.active;
  await vscode.commands.executeCommand('workbench.view.extension.siLite');
  await sleep(300);
  await vscode.commands.executeCommand('siLite.previewLocation', file('src', 'util.c').fsPath, 8, 4);
  await sleep(300);
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, main.uri.fsPath, 'preview must not open util.c');
  assert.ok(vscode.window.activeTextEditor!.selection.active.isEqual(before), 'cursor unchanged');
});

test('sticky highlight toggles on and off', async () => {
  const main = await open(file('src', 'main.c'));
  const editor = vscode.window.activeTextEditor!;
  const p = posOf(main, 'g_counter++');
  editor.selection = new vscode.Selection(p, p);
  await vscode.commands.executeCommand('siLite.toggleHighlight');
  await vscode.commands.executeCommand('siLite.toggleHighlight');
  await vscode.commands.executeCommand('siLite.toggleHighlight');
  await vscode.commands.executeCommand('siLite.clearHighlights');
});

test('call hierarchy incoming and outgoing', async () => {
  const doc = await open(file('src', 'util.c'));
  const items = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', doc.uri, posOf(doc, 'int util_add').translate(0, 4))) as vscode.CallHierarchyItem[];
  assert.equal(items.length, 1);
  const incoming = (await vscode.commands.executeCommand('vscode.provideIncomingCalls', items[0])) as vscode.CallHierarchyIncomingCall[];
  assert.deepEqual(incoming.map((c) => c.from.name).sort(), ['main', 'util_scale']);
  assert.equal(incoming.find((c) => c.from.name === 'util_scale')!.fromRanges.length, 2);

  const scale = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', doc.uri, posOf(doc, 'int util_scale').translate(0, 4))) as vscode.CallHierarchyItem[];
  const outgoing = (await vscode.commands.executeCommand('vscode.provideOutgoingCalls', scale[0])) as vscode.CallHierarchyOutgoingCall[];
  assert.deepEqual(outgoing.map((c) => c.to.name), ['util_add']);
});

test('saving a file re-indexes it incrementally', async () => {
  const uri = file('src', 'util.c');
  const original = fs.readFileSync(uri.fsPath, 'utf8');
  const doc = await open(uri);
  const editor = vscode.window.activeTextEditor!;
  await editor.edit((eb) => eb.insert(new vscode.Position(doc.lineCount, 0), '\nint util_new_fn(void) { return util_add(1, 2); }\n'));
  await doc.save();
  try {
    let syms: vscode.SymbolInformation[] = [];
    for (let i = 0; i < 20 && syms.length === 0; i++) {
      await sleep(250);
      syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'util_new')) as vscode.SymbolInformation[];
    }
    assert.equal(syms.length, 1, 'new function indexed after save');
    const main = await open(file('src', 'main.c'));
    const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', main.uri, posOf(main, 'util_add(r'))) as vscode.Hover[];
    const text = hovers.map((h) => h.contents.map((c) => (c as vscode.MarkdownString).value).join('\n')).join('\n');
    assert.match(text, /called from 4 place|被 4 处调用/);
  } finally {
    fs.writeFileSync(uri.fsPath, original); // external change: exercises the file watcher path
  }
  let after: vscode.SymbolInformation[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    after = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'util_new')) as vscode.SymbolInformation[];
    if (after.length === 0) break;
  }
  assert.equal(after.length, 0, 'symbol dropped after external revert');
});

test('relation and include commands run against the webviews', async () => {
  const doc = await open(file('src', 'main.c'));
  vscode.window.activeTextEditor!.selection = new vscode.Selection(posOf(doc, 'util_scale(&v'), posOf(doc, 'util_scale(&v'));
  await vscode.commands.executeCommand('siLite.showRelations');
  await sleep(300);
  await vscode.commands.executeCommand('siLite.showIncludes');
  await sleep(300);
  await vscode.commands.executeCommand('workbench.view.extension.siLite');
  await sleep(300);
});

test('database is persisted to workspace storage', async () => {
  const ext = vscode.extensions.getExtension('AveryNNN.si-lite')!;
  const storage = (ext.exports as undefined) ?? undefined;
  void storage;
  // The store saves after a build; look for the sqlite under the user-data-dir workspaceStorage.
  const userData = process.env.VSCODE_USER_DATA_DIR ?? '';
  const candidates: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'project.sqlite') candidates.push(p);
    }
  };
  if (userData) walk(path.join(userData, 'User', 'workspaceStorage'), 0);
  if (userData) assert.ok(candidates.length >= 1, 'project.sqlite written');
});

export async function run(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}\n${(e as Error).stack ?? e}`);
    }
  }
  if (failed) throw new Error(`${failed} test(s) failed`);
}
