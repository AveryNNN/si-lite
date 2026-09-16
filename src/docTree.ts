import * as vscode from 'vscode';
import type { Query, Tree } from 'web-tree-sitter';
import { blankMacros } from './core/indexText';
import { langForPath, type Lang } from './core/languages';
import { TreeSitter, type ParserService } from './core/parser';
import { config, fsPathOf } from './util';

interface Entry {
  version: number;
  tree: Tree;
  query: Query;
  lang: Lang;
  /** Edits applied to `tree` since it was produced; lets tree-sitter re-parse incrementally. */
  pendingEdits: number;
}

/**
 * Syntax trees of open documents. Edits are fed to tree-sitter so a keystroke in a large file
 * costs a few milliseconds instead of a full parse; trees are warmed in the background on open.
 */
export class DocTrees implements vscode.Disposable {
  private cache = new Map<string, Entry>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly parser: ParserService) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.applyEdits(e)),
      vscode.workspace.onDidCloseTextDocument((d) => this.drop(d)),
      vscode.workspace.onDidOpenTextDocument((d) => void this.warm(d)),
      vscode.window.onDidChangeActiveTextEditor((ed) => ed && void this.warm(ed.document)),
    );
    if (vscode.window.activeTextEditor) void this.warm(vscode.window.activeTextEditor.document);
  }

  private isCFamily(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' && (doc.languageId === 'c' || doc.languageId === 'cpp');
  }

  private async warm(doc: vscode.TextDocument): Promise<void> {
    if (!this.isCFamily(doc)) return;
    try {
      await this.getParsed(doc);
    } catch {
      /* parse errors are not fatal */
    }
  }

  private applyEdits(e: vscode.TextDocumentChangeEvent): void {
    const entry = this.cache.get(e.document.uri.toString());
    if (!entry || !e.contentChanges.length) return;
    // Changes arrive in reverse document order; each carries offsets against the pre-change text.
    for (const c of e.contentChanges) {
      const startIndex = c.rangeOffset;
      const oldEndIndex = c.rangeOffset + c.rangeLength;
      const newEndIndex = c.rangeOffset + c.text.length;
      // Derive the new end from the inserted text itself: offsets of sibling changes must not leak in.
      const lastNl = c.text.lastIndexOf('\n');
      const newEnd =
        lastNl < 0
          ? { line: c.range.start.line, character: c.range.start.character + c.text.length }
          : { line: c.range.start.line + (c.text.match(/\n/g)?.length ?? 0), character: c.text.length - lastNl - 1 };
      entry.tree.edit(new TreeSitter.Edit({
        startIndex,
        oldEndIndex,
        newEndIndex,
        startPosition: { row: c.range.start.line, column: c.range.start.character },
        oldEndPosition: { row: c.range.end.line, column: c.range.end.character },
        newEndPosition: { row: newEnd.line, column: newEnd.character },
      }));
      entry.pendingEdits++;
    }
  }

  async get(doc: vscode.TextDocument): Promise<Tree | undefined> {
    return (await this.getParsed(doc))?.tree;
  }

  async getParsed(doc: vscode.TextDocument): Promise<{ tree: Tree; query: Query } | undefined> {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version) return hit;
    const cfg = config();
    const lang = langForPath(fsPathOf(doc.uri), cfg.headerLanguage) ?? (doc.languageId === 'c' ? 'c' : 'cpp');
    const text = blankMacros(doc.getText(), cfg.ignoreMacros);
    // Reuse the edited old tree when the language is unchanged: tree-sitter only re-parses the changed region.
    const old = hit && hit.lang === lang && hit.pendingEdits > 0 ? hit.tree : undefined;
    const parsed = await this.parser.parse(lang, text, old);
    if (!parsed) return undefined;
    if (hit) hit.tree.delete();
    else if (this.cache.size >= 8) {
      const oldest = this.cache.keys().next().value!;
      this.cache.get(oldest)!.tree.delete();
      this.cache.delete(oldest);
    }
    const entry: Entry = { version: doc.version, tree: parsed.tree, query: parsed.query, lang, pendingEdits: 0 };
    this.cache.set(key, entry);
    return entry;
  }

  drop(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit) {
      hit.tree.delete();
      this.cache.delete(key);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const e of this.cache.values()) e.tree.delete();
    this.cache.clear();
  }
}
