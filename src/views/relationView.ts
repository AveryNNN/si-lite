import * as vscode from 'vscode';
import { buildCallGraph, buildClassGraph, buildIncludeGraph, isCallable, type CallMode, type ClassMode, type GraphData } from '../core/graph';
import type { Store, SymbolRow } from '../core/store';
import { relationStrings, t } from '../i18n';
import { config, debounce, fsPathOf, isCFamily, nonce, openLocation, relPath, wordAt } from '../util';

export type RelationMode = 'callees' | 'callers' | 'both' | 'includes' | 'includedBy' | 'includesBoth' | 'bases' | 'derived' | 'classBoth';

type Center = { type: 'symbol'; id: number } | { type: 'file'; id: number };

interface Options {
  mode: RelationMode;
  depth: number;
  follow: boolean;
}

export class RelationViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'siLite.relations';
  private view?: vscode.WebviewView;
  private center?: Center;
  private readonly _onPreview = new vscode.EventEmitter<{ path: string; line: number; col: number }>();
  /** Single click on a node or edge: the Context view shows the code without navigating. */
  readonly onPreview = this._onPreview.event;
  private opts: Options;
  private lastWord?: string;

  constructor(private readonly store: Store, private readonly extensionUri: vscode.Uri) {
    const c = config();
    this.opts = { mode: 'both', depth: c.relationDepth, follow: c.relationFollowCursor };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
  }

  private onMessage(m: { type: string; [k: string]: unknown }): void {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'strings', strings: relationStrings() });
        this.post({ type: 'options', ...this.opts });
        this.refresh();
        break;
      case 'open':
        void openLocation(m.path as string, m.line as number, (m.col as number) ?? 0, false);
        break;
      case 'preview':
        this._onPreview.fire({ path: m.path as string, line: m.line as number, col: (m.col as number) ?? 0 });
        break;
      case 'recenter': {
        const id = m.id as string;
        if (id.startsWith('sym:')) this.center = { type: 'symbol', id: Number(id.slice(4)) };
        else if (id.startsWith('file:')) this.center = { type: 'file', id: Number(id.slice(5)) };
        else break;
        this.refresh();
        break;
      }
      case 'options': {
        const next = { ...this.opts, ...(m.options as Partial<Options>) };
        const switchedFamily = isIncludeMode(next.mode) !== isIncludeMode(this.opts.mode);
        this.opts = next;
        const switchedClass = isClassMode(next.mode) !== isClassMode(this.opts.mode);
        if (switchedFamily || switchedClass) {
          // Move the center to the matching entity of the active editor.
          const editor = vscode.window.activeTextEditor;
          if (isIncludeMode(next.mode) && editor) this.showIncludesFor(editor.document);
          else if (editor) this.showSymbolAtCursor(editor, true);
          else this.refresh();
        } else this.refresh();
        break;
      }
    }
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  readonly onCursorMoved = debounce((editor: vscode.TextEditor) => {
    if (!this.opts.follow || !this.view?.visible) return;
    if (isIncludeMode(this.opts.mode)) {
      this.showIncludesFor(editor.document);
      return;
    }
    this.showSymbolAtCursor(editor, false);
  }, 200);

  showSymbolAtCursor(editor: vscode.TextEditor, force: boolean): void {
    if (!isCFamily(editor.document)) return;
    const word = wordAt(editor.document, editor.selection.active);
    if (!word) return;
    if (!force && word === this.lastWord) return;
    this.lastWord = word;
    let syms = this.store.findDefinitions(word);
    if (!syms.length) {
      // Fall back to the function enclosing the cursor.
      const enclosing = this.store.enclosingFunction(fsPathOf(editor.document.uri), editor.selection.active.line);
      if (enclosing) syms = [enclosing];
    }
    if (!syms.length) return;
    const isClass = (s: SymbolRow) => s.kind === 'class' || s.kind === 'struct';
    const pick = isClassMode(this.opts.mode) ? (syms.find(isClass) ?? syms[0]) : (syms.find(isCallable) ?? syms[0]);
    if (isIncludeMode(this.opts.mode)) this.opts.mode = 'both';
    if (isClassMode(this.opts.mode) && !isClass(pick)) this.opts.mode = 'both';
    this.setCenter({ type: 'symbol', id: pick.id });
  }

  showSymbol(sym: SymbolRow): void {
    if (isIncludeMode(this.opts.mode)) this.opts.mode = 'both';
    this.lastWord = sym.name;
    this.setCenter({ type: 'symbol', id: sym.id });
  }

  showIncludesFor(doc: vscode.TextDocument): void {
    const f = this.store.getFile(fsPathOf(doc.uri));
    if (!f) return;
    if (!isIncludeMode(this.opts.mode)) this.opts.mode = 'includesBoth';
    if (this.center?.type === 'file' && this.center.id === f.id) return;
    this.setCenter({ type: 'file', id: f.id });
  }

  private setCenter(c: Center): void {
    this.center = c;
    this.post({ type: 'options', ...this.opts });
    this.refresh();
  }

  invalidate(): void {
    this.lastWord = undefined;
    this.refresh();
  }

  refresh(): void {
    if (!this.view || !this.center) return;
    const max = config().maxGraphNodes;
    let graph: GraphData | undefined;
    let title = '';
    if (this.center.type === 'symbol') {
      const s = this.store.getSymbol(this.center.id);
      if (!s) return;
      if (isClassMode(this.opts.mode)) {
        const mode: ClassMode = this.opts.mode === 'bases' ? 'bases' : this.opts.mode === 'derived' ? 'derived' : 'both';
        graph = buildClassGraph(this.store, s, mode, this.opts.depth, max);
      } else {
        const mode: CallMode = isIncludeMode(this.opts.mode) ? 'both' : (this.opts.mode as CallMode);
        graph = buildCallGraph(this.store, s, mode, this.opts.depth, max);
      }
      title = `${s.qualname}  ·  ${relPath(s.path)}:${s.line + 1}`;
    } else {
      const f = this.store.getFileById(this.center.id);
      if (!f) return;
      const mode = this.opts.mode === 'includes' ? 'includes' : this.opts.mode === 'includedBy' ? 'includedBy' : 'both';
      graph = buildIncludeGraph(this.store, f, mode, this.opts.depth, max);
      title = relPath(f.path);
    }
    this.post({ type: 'graph', graph, title, family: this.center.type });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'relation.js'));
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${n}' ${webview.cspSource};">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  #bar { display: flex; gap: 8px; align-items: center; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); white-space: nowrap; }
  #bar select, #bar button { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 1px 4px; font-size: 11px; }
  #bar button { cursor: pointer; }
  #bar label { display: flex; align-items: center; gap: 3px; font-size: 11px; opacity: .9; }
  #title { overflow: hidden; text-overflow: ellipsis; opacity: .85; font-size: 11px; margin-left: auto; }
  .hint { font-size: 10px; opacity: .55; white-space: nowrap; }
  #cy { position: absolute; top: 28px; bottom: 0; left: 0; right: 0; }
  #empty { position: absolute; top: 40%; width: 100%; text-align: center; opacity: .6; }
  #note { position: absolute; right: 8px; bottom: 6px; font-size: 10px; opacity: .6; }
</style></head><body>
<div id="bar">
  <select id="mode">
    <optgroup label="${t('modeSymbol')}">
      <option value="callees">${t('calls')}</option>
      <option value="callers">${t('callers')}</option>
      <option value="both">${t('both')}</option>
    </optgroup>
    <optgroup label="${t('modeClass')}">
      <option value="bases">${t('bases')}</option>
      <option value="derived">${t('derived')}</option>
      <option value="classBoth">${t('both')}</option>
    </optgroup>
    <optgroup label="${t('modeFile')}">
      <option value="includes">${t('includes')}</option>
      <option value="includedBy">${t('includedBy')}</option>
      <option value="includesBoth">${t('both')}</option>
    </optgroup>
  </select>
  <label>${t('depth')} <select id="depth"><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
  <label><input type="checkbox" id="follow"> ${t('followCursor')}</label>
  <button id="fit" title="${t('fitTitle')}">${t('fit')}</button>
  <span id="title"></span><span class="hint">${t('graphHint')}</span>
</div>
<div id="cy"></div>
<div id="empty">${t('relationsEmpty')}</div>
<div id="note"></div>
<script nonce="${n}" src="${script}"></script>
</body></html>`;
  }
}

function isIncludeMode(m: RelationMode): boolean {
  return m === 'includes' || m === 'includedBy' || m === 'includesBoth';
}

function isClassMode(m: RelationMode): boolean {
  return m === 'bases' || m === 'derived' || m === 'classBoth';
}
