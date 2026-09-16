// Stress run against a real tree (FFmpeg). Launch: node test/runTest.mjs --suite=ffmpeg --workspace=bench/ffmpeg
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (n: number) => (n / 1048576).toFixed(0) + 'MB';
const mem = () => {
  const m = process.memoryUsage();
  return `rss=${mb(m.rss)} heap=${mb(m.heapUsed)}`;
};
const root = vscode.workspace.workspaceFolders![0].uri;
const file = (...p: string[]) => vscode.Uri.joinPath(root, ...p);

function posOf(doc: vscode.TextDocument, needle: string): vscode.Position {
  const idx = doc.getText().indexOf(needle);
  if (idx < 0) throw new Error('needle not found: ' + needle);
  return doc.positionAt(idx);
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('AveryNNN.si-lite')!;
  await ext.activate();
  console.log(`activated ${mem()}`);

  // Responsiveness probe: how long do timers stall while the build runs?
  let maxStall = 0;
  let last = Date.now();
  const probe = setInterval(() => {
    const now = Date.now();
    maxStall = Math.max(maxStall, now - last - 50);
    last = now;
  }, 50);

  let t = Date.now();
  await vscode.commands.executeCommand('siLite.rebuildProject');
  const buildMs = Date.now() - t;
  clearInterval(probe);
  console.log(`rebuild: ${buildMs}ms  max main-thread stall during build: ${maxStall}ms  ${mem()}`);

  t = Date.now();
  const syms = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'avcodec_open')) as vscode.SymbolInformation[];
  console.log(`workspace symbols 'avcodec_open': ${syms.length} in ${Date.now() - t}ms`);
  assert.ok(syms.some((s) => s.name === 'avcodec_open2'));

  const doc = await vscode.workspace.openTextDocument(file('libavcodec', 'decode.c'));
  await vscode.window.showTextDocument(doc);

  t = Date.now();
  const defs = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, posOf(doc, 'ff_get_buffer(').translate(0, 3))) as vscode.Location[];
  console.log(`definition ff_get_buffer: ${defs.length} in ${Date.now() - t}ms -> ${defs.map((d) => d.uri.fsPath.split(/[\\/]/).slice(-2).join('/') + ':' + (d.range.start.line + 1)).join(', ')}`);
  assert.ok(defs.length >= 1);

  t = Date.now();
  const hover = (await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, posOf(doc, 'av_log(').translate(0, 2))) as vscode.Hover[];
  const hoverText = hover.map((h) => h.contents.map((c) => (c as vscode.MarkdownString).value).join('')).join('');
  console.log(`hover av_log: ${Date.now() - t}ms -> ${hoverText.replace(/\n/g, ' ').slice(0, 160)}`);
  assert.match(hoverText, /called from \d+ place/);

  t = Date.now();
  const refs = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, posOf(doc, 'AVCodecContext').translate(0, 2))) as vscode.Location[];
  console.log(`references AVCodecContext: ${refs.length} in ${Date.now() - t}ms`);
  assert.ok(refs.length > 1000);

  t = Date.now();
  const fgb = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, posOf(doc, 'ff_get_buffer(').translate(0, 3))) as vscode.Location[];
  console.log(`references ff_get_buffer (context-filtered across ${new Set(fgb.map((l) => l.uri.fsPath)).size} files): ${fgb.length} in ${Date.now() - t}ms`);

  t = Date.now();
  const items = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', doc.uri, posOf(doc, 'int ff_decode_get_packet').translate(0, 6))) as vscode.CallHierarchyItem[];
  const incoming = (await vscode.commands.executeCommand('vscode.provideIncomingCalls', items[0])) as vscode.CallHierarchyIncomingCall[];
  const outgoing = (await vscode.commands.executeCommand('vscode.provideOutgoingCalls', items[0])) as vscode.CallHierarchyOutgoingCall[];
  console.log(`call hierarchy ff_decode_get_packet: in=${incoming.map((c) => c.from.name).join(',')} out=${outgoing.map((c) => c.to.name).join(',')} (${Date.now() - t}ms)`);
  assert.ok(incoming.length >= 1 && outgoing.length >= 1);

  vscode.window.activeTextEditor!.selection = new vscode.Selection(posOf(doc, 'ff_get_buffer('), posOf(doc, 'ff_get_buffer('));
  t = Date.now();
  await vscode.commands.executeCommand('siLite.showRelations');
  await sleep(500);
  console.log(`showRelations issued (${Date.now() - t}ms incl. 500ms settle) ${mem()}`);

  // Incremental: touch one file and make sure a second build is cheap.
  t = Date.now();
  await vscode.commands.executeCommand('siLite.buildProject');
  console.log(`incremental build (nothing changed): ${Date.now() - t}ms`);

  console.log('ffmpeg suite OK');
}
