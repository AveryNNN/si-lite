import * as vscode from 'vscode';
import { buildCallGraph, buildClassGraph, buildIncludeGraph, isCallable, type CallMode, type ClassMode, type GraphData } from '../core/graph';
import type { Store, SymbolRow } from '../core/store';
import { relationStrings, t } from '../i18n';
import { relationPageHtml } from './relationPage';
import { config, debounce, fsPathOf, isCFamily, nonce, openLocation, relPath, wordAt } from '../util';

export type RelationMode = 'callees' | 'callers' | 'both' | 'includes' | 'includedBy' | 'includesBoth' | 'bases' | 'derived' | 'classBoth';

type Center = { type: 'symbol'; id: number } | { type: 'file'; id: number };

interface Options {
  mode: RelationMode;
  depth: number;
  follow: boolean;
  view: 'graph' | 'list';
}

/**
 * Relation Window. Single click on a node selects it (the Context view follows), the ⊕ handle on a
 * node's right edge expands one more level in that direction, double click opens the code,
 * right click makes the node the new centre. Big fan-in/out is folded by folder.
 */
export class RelationViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'siLite.relations';
  private view?: vscode.WebviewView;
  private center?: Center;
  private readonly _onPreview = new vscode.EventEmitter<{ path: string; line: number; col: number }>();
  /** Preview request for a location (edges, file nodes): the Context view shows the code. */
  readonly onPreview = this._onPreview.event;
  private readonly _onSelect = new vscode.EventEmitter<number>();
  /** A symbol node was clicked: the Context view switches to that symbol. */
  readonly onSelect = this._onSelect.event;
  private opts: Options;
  private lastWord?: string;
  /** Per-centre expansion state so re-renders keep what the user opened. */
  private expanded = new Map<number, 'callees' | 'callers'>();
  private expandedGroups = new Set<string>();

  constructor(private readonly store: Store, private readonly extensionUri: vscode.Uri) {
    const c = config();
    this.opts = { mode: 'both', depth: c.relationDepth, follow: c.relationFollowCursor, view: 'graph' };
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
      case 'select': {
        const id = m.id as string;
        if (id.startsWith('sym:')) this._onSelect.fire(Number(id.slice(4)));
        else if (m.path) this._onPreview.fire({ path: m.path as string, line: (m.line as number) ?? 0, col: 0 });
        break;
      }
      case 'expand': {
        // ⊕ on a node or a folder group.
        const id = m.id as string;
        if (id.startsWith('grp:')) {
          if (this.expandedGroups.has(id)) this.expandedGroups.delete(id);
          else this.expandedGroups.add(id);
        } else if (id.startsWith('sym:')) {
          const sid = Number(id.slice(4));
          const dir = m.direction as 'callees' | 'callers';
          if (this.expanded.get(sid) === dir) this.expanded.delete(sid);
          else this.expanded.set(sid, dir);
        }
        this.refresh();
        break;
      }
      case 'recenter': {
        const id = m.id as string;
        if (id.startsWith('sym:')) this.setCenter({ type: 'symbol', id: Number(id.slice(4)) });
        else if (id.startsWith('file:')) this.setCenter({ type: 'file', id: Number(id.slice(5)) });
        break;
      }
      case 'options': {
        const next = { ...this.opts, ...(m.options as Partial<Options>) };
        const switchedFamily = isIncludeMode(next.mode) !== isIncludeMode(this.opts.mode);
        const switchedClass = isClassMode(next.mode) !== isClassMode(this.opts.mode);
        this.opts = next;
        if (switchedFamily || switchedClass) {
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
    const same = this.center && this.center.type === c.type && this.center.id === c.id;
    this.center = c;
    if (!same) {
      this.expanded.clear();
      this.expandedGroups.clear();
    }
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
    const roots = vscode.workspace.workspaceFolders?.map((f) => fsPathOf(f.uri)) ?? [];
    if (this.center.type === 'symbol') {
      const s = this.store.getSymbol(this.center.id);
      if (!s) return;
      if (isClassMode(this.opts.mode)) {
        const mode: ClassMode = this.opts.mode === 'bases' ? 'bases' : this.opts.mode === 'derived' ? 'derived' : 'both';
        graph = buildClassGraph(this.store, s, mode, this.opts.depth, max);
      } else {
        const mode: CallMode = isIncludeMode(this.opts.mode) ? 'both' : (this.opts.mode as CallMode);
        const relRoot = roots.find((r) => s.path.toLowerCase().startsWith(r.toLowerCase() + '/')) ?? roots[0];
        graph = buildCallGraph(this.store, s, mode, this.opts.depth, max, {
          expanded: this.expanded,
          expandedGroups: this.expandedGroups,
          relRoot,
        });
      }
      title = `${s.qualname}  ·  ${relPath(s.path)}:${s.line + 1}`;
    } else {
      const f = this.store.getFileById(this.center.id);
      if (!f) return;
      const mode = this.opts.mode === 'includes' ? 'includes' : this.opts.mode === 'includedBy' ? 'includedBy' : 'both';
      graph = buildIncludeGraph(this.store, f, mode, this.opts.depth, max);
      title = relPath(f.path);
    }
    for (const n of graph.nodes) if (n.file) (n as { fileLabel?: string }).fileLabel = relPath(n.file);
    this.post({ type: 'graph', graph, title, family: this.center.type });
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'relation.js'));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'));
    return relationPageHtml(nonce(), webview.cspSource, script.toString(), codicons.toString());
  }
}

function isIncludeMode(m: RelationMode): boolean {
  return m === 'includes' || m === 'includedBy' || m === 'includesBoth';
}

function isClassMode(m: RelationMode): boolean {
  return m === 'bases' || m === 'derived' || m === 'classBoth';
}
