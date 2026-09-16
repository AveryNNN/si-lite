// Source Insight "Highlight Word" (F8): a sticky, scope-aware highlight of every occurrence of the
// symbol at the cursor in the current file. Toggle again on the same symbol to remove it.
import * as vscode from 'vscode';
import { occurrencesInTree } from './core/resolver';
import type { DocTrees } from './docTree';
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
    const res = await this.service.resolveAt(doc, editor.selection.active);
    if (!res) return;
    const key = res.kind === 'local' ? `${res.name}@${res.decl.start.line}:${res.decl.start.col}` : res.name;
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
      list.push({ key, name: res.name, local: res.kind === 'local' ? { line: res.decl.start.line, col: res.decl.start.col } : undefined, decoration });
    }
    this.byDoc.set(doc.uri.toString(), list);
    await this.refresh(doc);
  }

  clear(doc: vscode.TextDocument): void {
    const list = this.byDoc.get(doc.uri.toString());
    if (!list) return;
    for (const e of list) e.decoration.dispose();
    this.byDoc.delete(doc.uri.toString());
  }

  private async refresh(doc: vscode.TextDocument): Promise<void> {
    const list = this.byDoc.get(doc.uri.toString());
    if (!list?.length) return;
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === doc);
    if (!editors.length) return;
    const tree = await this.trees.get(doc);
    if (!tree) return;
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
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const list of this.byDoc.values()) for (const e of list) e.decoration.dispose();
    this.byDoc.clear();
  }
}
