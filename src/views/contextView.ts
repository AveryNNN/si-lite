import * as vscode from 'vscode';
import type { Store, SymbolRow } from '../core/store';
import type { SymbolService } from '../providers';
import { t } from '../i18n';
import { ContextRenderer, contextPageHtml } from './contextRender';
import { debounce, fsPathOf, isCFamily, makeDecoder, nonce, openLocation, relPath, uriOf, wordAt } from '../util';

/**
 * Source Insight style Context window: the definition of the symbol under the cursor,
 * where it is used across the whole project (grouped by file, with the source line and
 * the enclosing function), and for aggregates a member table with usage counts.
 */
export class ContextViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'siLite.context';
  private view?: vscode.WebviewView;
  private lastWord?: string;
  /** Monotonic render id: a slow render (many files to analyse) must not overwrite a newer one. */
  private renderSeq = 0;

  private beginRender(): number {
    const seq = ++this.renderSeq;
    this.renderer.shouldAbort = () => seq !== this.renderSeq;
    return seq;
  }
  private locked = false;
  private fileCache = new Map<string, { mtime: number; lines: string[] }>();
  private readonly renderer: ContextRenderer;

  constructor(private readonly store: Store, private readonly service: SymbolService, private readonly extensionUri: vscode.Uri) {
    this.renderer = new ContextRenderer(store, (p) => this.lines(p), relPath);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.lastWord = undefined;
        this.update();
      }
    });
    this.update();
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    switch (m.type) {
      case 'open':
        void openLocation(m.path as string, m.line as number, (m.col as number) ?? 0, false);
        break;
      case 'preview':
        await this.showPreview(m.path as string, m.line as number, (m.col as number) ?? 0);
        break;
      case 'lock':
        this.locked = !!m.value;
        break;
      case 'expand': {
        // Lazy rows for one file group.
        const rows = await this.renderer.fileRows(m.name as string, m.fileId as number, m.path as string, (m.variant as 'kept' | 'plain' | 'hidden') ?? 'kept');
        this.post({ type: 'rows', key: m.key, html: rows });
        break;
      }
      case 'target':
        await this.showSymbol(m.id as number);
        break;
    }
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private currentName?: string;

  /** Show a symbol chosen elsewhere (Relations panel, member table, symbol tree). */
  async showSymbol(id: number): Promise<void> {
    const sym = this.store.getSymbol(id);
    if (!sym || !this.view) return;
    if (!this.view.visible) await vscode.commands.executeCommand('siLite.context.focus', { preserveFocus: true });
    this.lastWord = sym.name;
    this.renderer.origin = undefined;
    await this.render(sym.name, [sym]);
  }

  /** Show code around a location in the pane at the bottom of the view (no editor navigation). */
  async showPreview(path: string, line: number, col: number): Promise<void> {
    if (!this.view) return;
    if (!this.view.visible) await vscode.commands.executeCommand('siLite.context.focus', { preserveFocus: true });
    const html = await this.renderer.previewHtml(path, line, col, this.currentName);
    this.post({ type: 'preview', html });
  }

  readonly onCursorMoved = debounce(() => this.update(), 120);

  invalidate(): void {
    this.fileCache.clear();
    this.lastWord = undefined;
    this.update();
  }

  private update(): void {
    if (!this.view?.visible || this.locked) return;
    const editor = vscode.window.activeTextEditor;
    if (!isCFamily(editor?.document)) return;
    const word = wordAt(editor.document, editor.selection.active);
    if (!word) return;
    const key = this.keyFor(editor.document, editor.selection.active, word);
    if (key === this.lastWord) return;
    this.lastWord = key;
    void this.renderAt(editor.document, editor.selection.active, word, key);
  }

  /** Locals are keyed by file + name so `int c` in two functions do not share fold state. */
  private keyFor(doc: vscode.TextDocument, pos: vscode.Position, word: string): string {
    return `${word}@${fsPathOf(doc.uri)}:${pos.line}`;
  }

  private async renderAt(doc: vscode.TextDocument, pos: vscode.Position, word: string, key: string): Promise<void> {
    if (!this.view) return;
    const seq = this.beginRender();
    const res = await this.service.resolveAt(doc, pos);
    if (seq !== this.renderSeq) return;
    this.currentName = word;
    const here = fsPathOf(doc.uri);
    this.renderer.origin = { path: here, fnName: this.store.enclosingFunction(here, pos.line)?.qualname };
    this.renderer.filter = res && res.kind !== 'local' ? (p, refs) => this.service.filterOccurrences(p, res, refs) : undefined;
    if (res && res.kind !== 'local' && this.store.referenceFiles(word).length > 20) this.post({ type: 'busy', html: t('analysing', word) });
    const html = await this.renderer.renderResolution(res, word, fsPathOf(doc.uri));
    if (seq !== this.renderSeq) return; // superseded while analysing
    const foldKey = res?.kind === 'local' ? key : word;
    this.post({ type: 'set', html, key: foldKey });
  }

  private async render(word: string, syms: SymbolRow[]): Promise<void> {
    if (!this.view) return;
    const seq = this.beginRender();
    const target = syms[0];
    this.currentName = word;
    this.renderer.filter = target
      ? (p, refs) => this.service.filterOccurrences(p, target.kind === 'field' || target.kind === 'method' ? { kind: 'member', name: word, symbol: target, ownerType: target.qualname.split('::').slice(0, -1).join('::') } : { kind: 'symbols', name: word, symbols: syms, isCall: false }, refs)
      : undefined;
    const html = await this.renderer.render(word, syms);
    if (seq !== this.renderSeq) return;
    this.post({ type: 'set', html, key: word });
  }

  // ---- file access ---------------------------------------------------------

  private async lines(path: string): Promise<string[] | undefined> {
    const uri = uriOf(path);
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
      if (open) return open.getText().split(/\r?\n/);
      const stat = await vscode.workspace.fs.stat(uri);
      const cached = this.fileCache.get(path);
      if (cached && cached.mtime === stat.mtime) return cached.lines;
      const text = makeDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const lines = text.split(/\r?\n/);
      if (this.fileCache.size > 64) this.fileCache.delete(this.fileCache.keys().next().value!);
      this.fileCache.set(path, { mtime: stat.mtime, lines });
      return lines;
    } catch {
      return undefined;
    }
  }

  private html(webview: vscode.Webview): string {
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'));
    return contextPageHtml(nonce(), webview.cspSource, codicons.toString());
  }
}
