// Render the Relations webview for a symbol from the bench database into a standalone HTML page.
// Usage: node dist/relation-preview.js <root> <symbol> <out.html> [mode] [depth] [zh-cn] [--expand-first] [--open-group]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocaleResolver } from '../i18n';
import { relationPageHtml } from '../views/relationPage';
import { buildCallGraph, type CallMode } from './graph';
import { Store, normalizePath } from './store';

async function main() {
  const [root, name, out, modeArg, depthArg, locale] = process.argv.slice(2);
  setLocaleResolver(() => (locale === 'zh-cn' ? 'zh-cn' : 'en'));
  const store = await Store.open(path.join(__dirname, 'wasm'), path.join(__dirname, 'bench.sqlite'));
  const rootNorm = normalizePath(path.resolve(root));
  const sym = store.findDefinitions(name).find((s) => s.kind === 'function') ?? store.findDefinitions(name)[0];
  if (!sym) throw new Error('symbol not found: ' + name);
  const mode = (modeArg as CallMode) || 'both';
  const depth = Number(depthArg ?? 1);
  const expanded = new Map<number, 'callees' | 'callers'>();
  const expandedGroups = new Set<string>();
  let graph = buildCallGraph(store, sym, mode, depth, 150, { relRoot: rootNorm });
  if (process.argv.includes('--expand-first')) {
    const first = graph.nodes.find((n) => n.expandable?.length && n.expandable[0] !== 'group');
    if (first) expanded.set(Number(first.id.slice(4)), first.expandable![0] as 'callees' | 'callers');
  }
  if (process.argv.includes('--open-group')) {
    const g = graph.nodes.find((n) => n.kind === 'group');
    if (g) expandedGroups.add(g.id);
  }
  graph = buildCallGraph(store, sym, mode, depth, 150, { relRoot: rootNorm, expanded, expandedGroups });
  const rel = (p: string) => (p.toLowerCase().startsWith(rootNorm.toLowerCase() + '/') ? p.slice(rootNorm.length + 1) : p);
  for (const n of graph.nodes) if (n.file) (n as { fileLabel?: string }).fileLabel = rel(n.file);
  const title = `${sym.qualname}  ·  ${rel(sym.path)}:${sym.line + 1}`;
  console.log(`${name}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, groups=${graph.nodes.filter((n) => n.kind === 'group').length}`);
  const page = relationPageHtml('x', "'self'", 'relation.js', 'codicons/codicon.css')
    .replace('<script nonce="x" src="relation.js"></script>',
      `<script nonce="x">window.acquireVsCodeApi = () => ({ postMessage(m) { if (m.type === 'ready') { setTimeout(() => window.postMessage({ type: 'options', mode: ${JSON.stringify(mode)}, depth: ${depth}, follow: true, view: ${JSON.stringify(process.argv.includes('--list') ? 'list' : 'graph')} }, '*'), 10); setTimeout(() => window.postMessage({ type: 'graph', graph: ${JSON.stringify(graph)}, title: ${JSON.stringify(title)}, family: 'symbol' }, '*'), 20); } }, getState() { return null; }, setState() {} });</script><script nonce="x" src="relation.js"></script>`)
    .replace('<style>', '<style>body{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-focusBorder:#007fd4;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-symbolIcon-functionForeground:#b180d7;--vscode-symbolIcon-constantForeground:#4fc1ff;--vscode-symbolIcon-folderForeground:#dcb67a;--vscode-list-hoverBackground:#2a2d2e;background:#1e1e1e}');
  fs.writeFileSync(out, page);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
