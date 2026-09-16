// Source Insight "Highlight Word" (F8): a sticky, scope-aware highlight of every occurrence of the
// symbol at the cursor in the current file. Toggle again on the same symbol to remove it.
import * as vscode from 'vscode';
import { occurrencesInTree } from './core/resolver';
import type { DocTrees } from './docTree';
import { t } from './i18n';
import type { SymbolService } from './providers';

interface Entry {
  key: string; // name, or name@declLine:col for locals
  name: string;
  local?: { line: number; col: number };
  decoration: vscode.TextEditorDecorationType;
}

const PALETTE = [
  'rgba(255, 213, 79, 0.40)',
  'rgba(129, 199, 132, 0.40)',
  'rgba(100, 181, 246, 0.40)',
  'rgba(240, 98, 146, 0.40)',
  'rgba(186, 104, 200, 0.40)',
  'rgba(255, 138, 101, 0.40)',
];

export class StickyHighlight implements vscode.Disposable {
  private byDoc = new Map<string, Entry[]>();
  private disposables: vscode.Disposable[] = [];
  private colourIndex = 0;

  constructor(private readonly service: SymbolService, private readonly trees: DocTrees) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => void this.refresh(e.document)),
      vscode.window.onDidChangeActiveTextEditor((ed) => ed && void this.refresh(ed.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.clear(d)),
    );
  }

  async toggle(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const wordRange = doc.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_]\w*/);
    if (!wordRange) {
      void vscode.window.showInformationMessage(t('noSymbolHere'));
      return;
    }
    // Scope-aware when the resolver knows the symbol; plain word highlight otherwise (e.g. no database yet).
    const res = await this.service.resolveAt(doc, editor.selection.active);
    const name = res?.name ?? doc.getText(wordRange);
    const key = res?.kind === 'local' ? `${res.name}@${res.decl.start.line}:${res.decl.start.col}` : name;
    const list = this.byDoc.get(doc.uri.toString()) ?? [];
    const existing = list.findIndex((e) => e.key === key);
    if (existing >= 0) {
      list[existing].decoration.dispose();
      list.splice(existing, 1);
    } else {
      const colour = PALETTE[this.colourIndex++ % PALETTE.length];
      const decoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: colour,
        borderRadius: '2px',
        overviewRulerColor: colour,
        overviewRulerLane: vscode.OverviewRulerLane.Center,
      });
      list.push({ key, name, local: res?.kind === 'local' ? { line: res.decl.start.line, col: res.decl.start.col } : undefined, decoration });
    }
    this.byDoc.set(doc.uri.toString(), list);
    const count = await this.refresh(doc);
    vscode.window.setStatusBarMessage(existing >= 0 ? t('highlightOff', name) : t('highlightOn', name, count), 3000);
  }

  clear(doc: vscode.TextDocument): void {
    const list = this.byDoc.get(doc.uri.toString());
    if (!list) return;
    for (const e of list) e.decoration.dispose();
    this.byDoc.delete(doc.uri.toString());
  }

  private async refresh(doc: vscode.TextDocument): Promise<number> {
    const list = this.byDoc.get(doc.uri.toString());
    if (!list?.length) return 0;
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === doc.uri.toString());
    if (!editors.length) return 0;
    const tree = await this.trees.get(doc);
    if (!tree) return 0;
    let last = 0;
    for (const e of list) {
      let ranges: vscode.Range[];
      if (e.local) {
        // Re-resolve from the declaration so the highlight survives edits above it.
        const res = await this.service.resolveAt(doc, new vscode.Position(e.local.line, e.local.col));
        ranges = res?.kind === 'local' ? res.refs.map((r) => new vscode.Range(r.start.line, r.start.col, r.end.line, r.end.col)) : [];
      } else {
        ranges = occurrencesInTree(tree, e.name).map((r) => new vscode.Range(r.start.line, r.start.col, r.end.line, r.end.col));
      }
      for (const ed of editors) ed.setDecorations(e.decoration, ranges);
      last = ranges.length;
    }
    return last;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const list of this.byDoc.values()) for (const e of list) e.decoration.dispose();
    this.byDoc.clear();
  }
}
