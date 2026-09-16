// Render the Context view for a symbol from a bench database into a standalone HTML page.
// Usage: node dist/context-preview.js <root> <symbol> <out.html> [zh-cn] [--at relfile:needle]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocaleResolver } from '../i18n';
import { ContextRenderer, contextPageHtml } from '../views/contextRender';
import { ParserService } from './parser';
import { Resolver } from './resolver';
import { Store, normalizePath } from './store';

async function main() {
  const [root, name, out, locale] = process.argv.slice(2);
  const atArg = process.argv.find((a) => a.startsWith('--at='))?.slice(5);
  setLocaleResolver(() => (locale === 'zh-cn' ? 'zh-cn' : 'en'));
  const wasmDir = path.join(__dirname, 'wasm');
  const store = await Store.open(wasmDir, path.join(__dirname, 'bench.sqlite'));
  const rootNorm = normalizePath(path.resolve(root));
  const readLines = async (p: string) => {
    try {
      return fs.readFileSync(p, 'utf8').split(/\r?\n/);
    } catch {
      return undefined;
    }
  };
  const relPath = (p: string) => (p.toLowerCase().startsWith(rootNorm.toLowerCase() + '/') ? p.slice(rootNorm.length + 1) : p);
  const renderer = new ContextRenderer(store, readLines, relPath);
  const t0 = Date.now();
  let body: string;
  if (atArg) {
    const [rel, needle] = atArg.split(':');
    const file = normalizePath(path.join(rootNorm, rel));
    const text = fs.readFileSync(file, 'utf8');
    const idx = text.indexOf(needle);
    if (idx < 0) throw new Error('needle not found');
    const before = text.slice(0, idx);
    const pos = { line: before.split('\n').length - 1, col: idx - before.lastIndexOf('\n') - 1 };
    const parser = new ParserService(wasmDir);
    await parser.init();
    const parsed = (await parser.parse(file.endsWith('.c') ? 'c' : 'cpp', text))!;
    const res = new Resolver(store).resolve(parsed.tree, file, pos);
    renderer.origin = { path: file, fnName: store.enclosingFunction(file, pos.line)?.qualname };
    renderer.filter = res && res.kind !== 'local' ? async (_p, refs) => refs : undefined;
    console.log('resolution:', res?.kind, res && 'typeText' in res ? res.typeText : '', res && 'symbol' in res ? res.symbol.qualname : '');
    body = await renderer.renderResolution(res, name, file);
  } else {
    body = await renderer.render(name, store.findDefinitions(name));
  }
  console.log(`${name}: rendered ${body.length} chars in ${Date.now() - t0}ms`);
  // Also exercise the preview pane with the first reference row in the page.
  const m = /class="row[^"]*" data-path="([^"]+)" data-line="(\d+)" data-col="(\d+)"/.exec(body);
  const previewBody = m ? await renderer.previewHtml(m[1].replace(/&#39;/g, "'"), Number(m[2]), Number(m[3]), name) : '';
  const page = contextPageHtml('x', "'self'")
    .replace('<script nonce="x">', '<script nonce="x">window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return null; }, setState() {} });</script><script nonce="x">')
    .replace('<div id="root"><div class="empty">', '<div id="root" hidden><div class="empty">')
    .replace('</script></body></html>', `window.postMessage({ type: 'set', html: ${JSON.stringify(body)}, key: 'x' }, '*'); document.getElementById('root').hidden = false; setTimeout(() => window.postMessage({ type: 'preview', html: ${JSON.stringify(previewBody)} }, '*'), 50);</script></body></html>`);
  const themed = page.replace('<style>', '<style>body{--vscode-foreground:#ccc;--vscode-sideBar-background:#252526;--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;--vscode-editor-font-family:Consolas,monospace;--vscode-editor-font-size:12px;--vscode-font-size:13px;--vscode-font-family:"Segoe UI",sans-serif;--vscode-list-hoverBackground:#2a2d2e;background:#252526;width:420px}');
  fs.writeFileSync(out, themed);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
