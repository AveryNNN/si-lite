import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { blankMacros } from './core/indexText';
import { langForPath } from './core/languages';
import type { ParserService } from './core/parser';
import type { Resolution, Resolver } from './core/resolver';
import type { Store, SymbolRow } from './core/store';
import type { DocTrees } from './docTree';
import { kindWord, t } from './i18n';
import { KIND_TO_VSCODE, config, fsPathOf, makeDecoder, relPath, uriOf, wordAt } from './util';

/** Above this many files, references stay name-based (parsing every file would take too long). */
const CONTEXT_FILTER_MAX_FILES = 250;

const SELECTOR: vscode.DocumentSelector = [
  { language: 'c', scheme: 'file' },
  { language: 'cpp', scheme: 'file' },
];

function toLocation(s: SymbolRow): vscode.Location {
  const pos = new vscode.Position(s.line, s.col);
  return new vscode.Location(uriOf(s.path), new vscode.Range(pos, pos.translate(0, s.name.length)));
}

function toItem(s: SymbolRow): vscode.CallHierarchyItem {
  const start = new vscode.Position(s.line, s.col);
  const item = new vscode.CallHierarchyItem(
    KIND_TO_VSCODE[s.kind],
    s.qualname,
    relPath(s.path),
    uriOf(s.path),
    new vscode.Range(start, new vscode.Position(s.endLine, 0)),
    new vscode.Range(start, start.translate(0, s.name.length)),
  );
  (item as vscode.CallHierarchyItem & { siId: number }).siId = s.id;
  return item;
}

const INCLUDE_RE = /^\s*#\s*include\s*[<"]([^">]+)[">]/;

/** Comment block directly above a definition, for hovers (Source Insight shows it in the Context window). */
async function commentAbove(s: SymbolRow): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uriOf(s.path));
    const lines: string[] = [];
    let i = s.line - 1;
    while (i >= 0 && lines.length < 12) {
      const tl = doc.lineAt(i).text.trim();
      if (tl === '' && lines.length === 0) break;
      const isComment = tl.startsWith('//') || tl.startsWith('/*') || tl.startsWith('*') || tl.endsWith('*/');
      if (!isComment) break;
      lines.unshift(tl.replace(/^\/\*+\s?|^\*+\/?\s?|^\/\/\s?|\*\/$/g, '').trimEnd());
      if (tl.startsWith('/*')) break;
      i--;
    }
    const text = lines.join('\n').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Shared by the providers, the commands and the Context view. */
export class SymbolService {
  constructor(
    private readonly store: Store,
    private readonly resolver: Resolver,
    private readonly trees: DocTrees,
    private readonly parser: ParserService,
  ) {}

  /** `#include "x.h"` under the cursor -> the file in the project, if any. */
  includeTarget(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location | undefined {
    const m = INCLUDE_RE.exec(doc.lineAt(pos.line).text);
    if (!m) return undefined;
    const raw = m[1].replace(/\\/g, '/');
    let p = raw;
    while (p.startsWith('./') || p.startsWith('../')) p = p.replace(/^\.\.?\//, '');
    const f = this.store.resolveInclude(p);
    return f ? new vscode.Location(uriOf(f.path), new vscode.Position(0, 0)) : undefined;
  }

  async resolveAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<Resolution | undefined> {
    const word = wordAt(doc, pos);
    if (!word) return undefined;
    const tree = await this.trees.get(doc);
    const res = tree ? this.resolver.resolve(tree, fsPathOf(doc.uri), { line: pos.line, col: pos.character }) : undefined;
    if (res) return res;
    const symbols = this.store.findDefinitions(word);
    return symbols.length ? { kind: 'symbols', name: word, symbols, isCall: false } : undefined;
  }

  definitions(res: Resolution, doc: vscode.TextDocument): vscode.Location[] {
    switch (res.kind) {
      case 'local': {
        const p = new vscode.Position(res.decl.start.line, res.decl.start.col);
        return [new vscode.Location(doc.uri, new vscode.Range(p, p.translate(0, res.name.length)))];
      }
      case 'member':
        return [toLocation(res.symbol)];
      case 'symbols':
        return res.symbols.map(toLocation);
    }
  }

  /**
   * All references. Locals stay inside their scope. Globals and members start from the name index and
   * are then filtered per file with the syntax tree (Source Insight's "context-sensitive" results):
   * a local or parameter that merely shares the name is dropped, and `x->c` only counts when x's type
   * owns this member.
   */
  async references(res: Resolution, doc: vscode.TextDocument, includeDeclaration: boolean, fileOnly: boolean): Promise<vscode.Location[]> {
    const out: vscode.Location[] = [];
    if (res.kind === 'local') {
      for (const r of res.refs) {
        const p = new vscode.Position(r.start.line, r.start.col);
        if (!includeDeclaration && r.start.line === res.decl.start.line && r.start.col === res.decl.start.col) continue;
        out.push(new vscode.Location(doc.uri, new vscode.Range(p, p.translate(0, res.name.length))));
      }
      return out;
    }
    const here = fsPathOf(doc.uri).toLowerCase();
    const inScope = (p: string) => !fileOnly || p.toLowerCase() === here;
    if (includeDeclaration) {
      // A plain identifier is not a struct member: leave same-named fields of other types out.
      const decls = res.kind === 'member' ? [res.symbol] : res.symbols.filter((s) => s.kind !== 'field');
      for (const s of decls) if (inScope(s.path)) out.push(toLocation(s));
    }
    const byFile = new Map<string, Array<{ line: number; col: number }>>();
    for (const r of this.store.referencesOf(res.name)) {
      if (!inScope(r.path)) continue;
      const list = byFile.get(r.path) ?? [];
      list.push({ line: r.line, col: r.col });
      byFile.set(r.path, list);
    }
    const filter = byFile.size <= CONTEXT_FILTER_MAX_FILES;
    for (const [path, refs] of byFile) {
      const keep = filter ? await this.filterOccurrences(path, res, refs) : refs;
      for (const r of keep) {
        const p = new vscode.Position(r.line, r.col);
        out.push(new vscode.Location(uriOf(path), new vscode.Range(p, p.translate(0, res.name.length))));
      }
    }
    return out;
  }

  async filterOccurrences(path: string, target: Resolution, refs: Array<{ line: number; col: number }>): Promise<Array<{ line: number; col: number }>> {
    const cfg = config();
    const lang = langForPath(path, cfg.headerLanguage);
    if (!lang) return refs;
    let tree;
    let owned = false;
    try {
      const open = vscode.workspace.textDocuments.find((d) => fsPathOf(d.uri).toLowerCase() === path.toLowerCase());
      if (open) tree = await this.trees.get(open);
      else {
        const text = makeDecoder().decode(fs.readFileSync(path));
        tree = (await this.parser.parse(lang, blankMacros(text, cfg.ignoreMacros)))?.tree;
        owned = true;
      }
    } catch {
      return refs;
    }
    if (!tree) return refs;
    try {
      const keep: Array<{ line: number; col: number }> = [];
      for (const r of refs) {
        const res = this.resolver.resolve(tree, path, r);
        if (!res) {
          keep.push(r);
          continue;
        }
        if (res.kind === 'local') continue; // a local/parameter that only shares the name
        if (target.kind === 'member') {
          // Keep unresolved field accesses (unknown object type) and exact matches; drop other owners.
          if (res.kind === 'member' && res.symbol.qualname !== target.symbol.qualname) continue;
          if (res.kind === 'symbols' && res.symbols.some((s) => s.kind === 'field' || s.kind === 'method') && !res.symbols.some((s) => s.qualname === target.symbol.qualname)) continue;
        } else if (res.kind === 'member') {
          // Looking for a global/function but this occurrence is a struct member of that name.
          continue;
        }
        keep.push(r);
      }
      return keep;
    } finally {
      if (owned) tree.delete();
    }
  }

  async hover(res: Resolution, doc: vscode.TextDocument): Promise<vscode.Hover> {
    const md = new vscode.MarkdownString();
    switch (res.kind) {
      case 'local':
        md.appendCodeblock(`${res.typeText} ${res.name}`, doc.languageId);
        md.appendMarkdown(`*${t(res.isParam ? 'kindParam' : 'kindLocal')}*${res.scopeName ? ` · ${t('inFunction', res.scopeName)}` : ''} · ${t('refsInScope', res.refs.length)}`);
        break;
      case 'member': {
        md.appendCodeblock(res.symbol.signature, doc.languageId);
        const c = await commentAbove(res.symbol);
        if (c) md.appendMarkdown(c.replace(/\n/g, '  \n') + '\n\n');
        md.appendMarkdown(`*${kindWord(res.symbol.kind)}* ${res.symbol.qualname} · ${relPath(res.symbol.path)}:${res.symbol.line + 1}`);
        break;
      }
      case 'symbols':
        for (const s of res.symbols.slice(0, 3)) {
          md.appendCodeblock(s.signature, doc.languageId);
          const c = s.kind !== 'prototype' ? await commentAbove(s) : undefined;
          if (c) md.appendMarkdown(c.replace(/\n/g, '  \n') + '\n\n');
          const callers = s.kind === 'function' || s.kind === 'method' || s.kind === 'macro' ? this.store.callerCount(s.name) : 0;
          md.appendMarkdown(`*${kindWord(s.kind)}* · ${relPath(s.path)}:${s.line + 1}${callers ? ` · ${t('calledFrom', callers)}` : ''}\n\n`);
        }
        break;
    }
    return new vscode.Hover(md);
  }
}

export function registerProviders(store: Store, service: SymbolService): vscode.Disposable[] {
  const definition: vscode.DefinitionProvider = {
    async provideDefinition(doc, pos) {
      const inc = service.includeTarget(doc, pos);
      if (inc) return inc;
      const res = await service.resolveAt(doc, pos);
      if (!res) return;
      const here = fsPathOf(doc.uri);
      return service.definitions(res, doc).filter((l) => !(fsPathOf(l.uri) === here && l.range.start.line === pos.line));
    },
  };

  const references: vscode.ReferenceProvider = {
    async provideReferences(doc, pos, ctx) {
      const res = await service.resolveAt(doc, pos);
      if (!res) return;
      return await service.references(res, doc, ctx.includeDeclaration, false);
    },
  };

  const hover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      if (!config().provideHover) return;
      const res = await service.resolveAt(doc, pos);
      return res ? await service.hover(res, doc) : undefined;
    },
  };

  const workspaceSymbols: vscode.WorkspaceSymbolProvider = {
    provideWorkspaceSymbols(query) {
      return store.searchSymbols(query, 300).map(
        (s) => new vscode.SymbolInformation(s.qualname, KIND_TO_VSCODE[s.kind], relPath(s.path), toLocation(s)),
      );
    },
  };

  const callHierarchy: vscode.CallHierarchyProvider = {
    prepareCallHierarchy(doc, pos) {
      const w = wordAt(doc, pos);
      if (!w) return;
      const s = store.findDefinitions(w).find((x) => x.kind === 'function' || x.kind === 'method' || x.kind === 'macro');
      return s ? toItem(s) : undefined;
    },
    provideCallHierarchyIncomingCalls(item) {
      const byCaller = new Map<number, { from: SymbolRow; ranges: vscode.Range[] }>();
      for (const r of store.callersOf(item.name.split('::').pop() ?? item.name)) {
        if (!r.fromSymbol) continue;
        const p = new vscode.Position(r.line, r.col);
        const entry = byCaller.get(r.fromSymbol.id) ?? { from: r.fromSymbol, ranges: [] };
        entry.ranges.push(new vscode.Range(p, p.translate(0, r.name.length)));
        byCaller.set(r.fromSymbol.id, entry);
      }
      return [...byCaller.values()].map((e) => new vscode.CallHierarchyIncomingCall(toItem(e.from), e.ranges));
    },
    provideCallHierarchyOutgoingCalls(item) {
      const id = (item as vscode.CallHierarchyItem & { siId?: number }).siId;
      if (id == null) return [];
      return store
        .calleesOf(id)
        .filter((c) => c.target)
        .map((c) => {
          const p = new vscode.Position(c.line, c.col);
          return new vscode.CallHierarchyOutgoingCall(toItem(c.target!), [new vscode.Range(p, p.translate(0, c.name.length))]);
        });
    },
  };

  return [
    vscode.languages.registerDefinitionProvider(SELECTOR, definition),
    vscode.languages.registerReferenceProvider(SELECTOR, references),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.languages.registerWorkspaceSymbolProvider(workspaceSymbols),
    vscode.languages.registerCallHierarchyProvider(SELECTOR, callHierarchy),
  ];
}

/** Open VS Code's own references peek, restricted to the current file or project wide. */
export async function showReferences(service: SymbolService, fileOnly: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const pos = editor.selection.active;
  const res = await service.resolveAt(editor.document, pos);
  if (!res) {
    void vscode.window.showInformationMessage(t('noSymbolHere'));
    return;
  }
  const locations = await service.references(res, editor.document, true, fileOnly);
  await vscode.commands.executeCommand('editor.action.showReferences', editor.document.uri, pos, locations);
}
