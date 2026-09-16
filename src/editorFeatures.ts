// Editor-side features that Source Insight users expect and VS Code only gets from a language server:
// file outline (Symbol Window), scope-aware reference highlighting, symbolic completion and smart rename.
import * as vscode from 'vscode';
import type { Node } from 'web-tree-sitter';
import { extract, type SymbolRec } from './core/extractor';
import { langForPath, type SymbolKind } from './core/languages';
import { occurrencesInTree, type Resolver } from './core/resolver';
import type { Store, SymbolRow } from './core/store';
import type { DocTrees } from './docTree';
import { kindWord, t } from './i18n';
import type { SymbolService } from './providers';
import { KIND_TO_VSCODE, config, fsPathOf, relPath } from './util';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'c', scheme: 'file' },
  { language: 'cpp', scheme: 'file' },
];

const CONTAINER_KINDS = new Set<SymbolKind>(['struct', 'class', 'union', 'enum', 'namespace', 'function', 'method']);

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

function toDocumentSymbols(symbols: SymbolRec[], doc: vscode.TextDocument): vscode.DocumentSymbol[] {
  const sorted = [...symbols].sort((a, b) => a.startIdx - b.startIdx || b.endIdx - a.endIdx);
  const roots: vscode.DocumentSymbol[] = [];
  const stack: Array<{ sym: SymbolRec; ds: vscode.DocumentSymbol }> = [];
  for (const s of sorted) {
    const full = new vscode.Range(s.startLine, 0, s.endLine, doc.lineAt(Math.min(s.endLine, doc.lineCount - 1)).text.length);
    const sel = new vscode.Range(s.line, s.col, s.line, s.col + s.name.length);
    const ds = new vscode.DocumentSymbol(s.name, s.kind === 'function' || s.kind === 'method' || s.kind === 'prototype' ? s.signature : kindWord(s.kind), KIND_TO_VSCODE[s.kind], full, sel);
    while (stack.length && !(stack[stack.length - 1].sym.startIdx <= s.startIdx && stack[stack.length - 1].sym.endIdx >= s.endIdx)) stack.pop();
    // A typedef wrapping an anonymous struct shares the struct's range; keep them siblings.
    const parent = stack.length ? stack[stack.length - 1] : undefined;
    if (parent && parent.sym.startIdx === s.startIdx && parent.sym.endIdx === s.endIdx) {
      (stack.length > 1 ? stack[stack.length - 2].ds.children : roots).push(ds);
    } else if (parent) parent.ds.children.push(ds);
    else roots.push(ds);
    if (CONTAINER_KINDS.has(s.kind)) stack.push({ sym: s, ds });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

const KIND_TO_COMPLETION: Record<SymbolKind, vscode.CompletionItemKind> = {
  function: vscode.CompletionItemKind.Function,
  method: vscode.CompletionItemKind.Method,
  prototype: vscode.CompletionItemKind.Function,
  variable: vscode.CompletionItemKind.Variable,
  field: vscode.CompletionItemKind.Field,
  struct: vscode.CompletionItemKind.Struct,
  class: vscode.CompletionItemKind.Class,
  union: vscode.CompletionItemKind.Struct,
  enum: vscode.CompletionItemKind.Enum,
  enumerator: vscode.CompletionItemKind.EnumMember,
  typedef: vscode.CompletionItemKind.Interface,
  macro: vscode.CompletionItemKind.Constant,
  namespace: vscode.CompletionItemKind.Module,
};

/** The expression that ends right before `->` / `.` at the cursor, e.g. `pkt` in `pkt->|` or `a->b` in `a->b.|`. */
function objectBefore(root: Node, doc: vscode.TextDocument, pos: vscode.Position): Node | undefined {
  const line = doc.lineAt(pos.line).text.slice(0, pos.character);
  const m = /(->|\.)\s*[A-Za-z_]\w*$/.exec(line) ?? /(->|\.)$/.exec(line);
  if (!m) return undefined;
  const opCol = m.index;
  if (opCol === 0) return undefined;
  let n: Node | null = root.descendantForPosition({ row: pos.line, column: opCol - 1 });
  if (!n) return undefined;
  const endIdx = n.endIndex;
  // Climb while the parent still ends at the same place and is an expression we can type.
  while (n.parent && n.parent.endIndex === endIdx && /expression|identifier|this/.test(n.parent.type) && n.parent.type !== 'assignment_expression' && n.parent.type !== 'binary_expression') n = n.parent;
  return n;
}

function localDeclarations(root: Node, pos: vscode.Position): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  let n: Node | null = root.descendantForPosition({ row: pos.line, column: Math.max(0, pos.character - 1) });
  const seen = new Set<string>();
  const add = (decl: Node) => {
    for (const d of decl.childrenForFieldName('declarator')) {
      let inner: Node | null = d;
      while (inner && !/^(identifier|field_identifier)$/.test(inner.type)) inner = inner.childForFieldName('declarator') ?? inner.firstNamedChild;
      if (inner && !seen.has(inner.text)) {
        seen.add(inner.text);
        out.push({ name: inner.text, type: decl.childForFieldName('type')?.text ?? '' });
      }
    }
  };
  while (n) {
    if (n.type === 'compound_statement') for (const c of n.namedChildren) if (c.type === 'declaration' && c.startIndex < (root.descendantForPosition({ row: pos.line, column: pos.character })?.startIndex ?? Infinity)) add(c);
    if (n.type === 'for_statement') {
      const init = n.childForFieldName('initializer');
      if (init?.type === 'declaration') add(init);
    }
    if (n.type === 'function_definition') {
      const fn = n.descendantsOfType('function_declarator')[0];
      for (const p of fn?.childForFieldName('parameters')?.namedChildren ?? []) if (p.type.includes('parameter_declaration')) add(p);
    }
    n = n.parent;
  }
  return out;
}

/** Scan backwards from the cursor for the call this position is inside of, counting commas at depth 0. */
function enclosingCall(doc: vscode.TextDocument, pos: vscode.Position): { name: string; argIndex: number } | undefined {
  const startLine = Math.max(0, pos.line - 20);
  const text = doc.getText(new vscode.Range(startLine, 0, pos.line, pos.character));
  let depth = 0;
  let commas = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') {
      if (depth === 0) {
        if (ch === '[') return undefined;
        const m = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, i));
        if (!m || /^(if|while|for|switch|return|sizeof)$/.test(m[1])) return undefined;
        return { name: m[1], argIndex: commas };
      }
      depth--;
    } else if (ch === ',' && depth === 0) commas++;
    else if (ch === ';' || ch === '{' || ch === '}') return undefined;
  }
  return undefined;
}

function splitParams(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === ')' || ch === '>' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.filter((p) => p.trim() && p.trim() !== 'void');
}

// ---------------------------------------------------------------------------

export function registerEditorFeatures(store: Store, service: SymbolService, resolver: Resolver, trees: DocTrees): vscode.Disposable[] {
  const outline: vscode.DocumentSymbolProvider = {
    async provideDocumentSymbols(doc) {
      const parsed = await trees.getParsed(doc);
      if (!parsed) return [];
      const lang = langForPath(fsPathOf(doc.uri), config().headerLanguage) ?? 'cpp';
      const index = extract(parsed.tree, parsed.query, lang, { indexReferences: false });
      return toDocumentSymbols(index.symbols, doc);
    },
  };

  const highlight: vscode.DocumentHighlightProvider = {
    async provideDocumentHighlights(doc, pos) {
      const res = await service.resolveAt(doc, pos);
      const tree = await trees.get(doc);
      if (!res || !tree) return;
      const ranges = res.kind === 'local' ? res.refs : occurrencesInTree(tree, res.name);
      return ranges.map((r) => new vscode.DocumentHighlight(new vscode.Range(r.start.line, r.start.col, r.end.line, r.end.col), vscode.DocumentHighlightKind.Text));
    },
  };

  const completion: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, pos) {
      const tree = await trees.get(doc);
      if (!tree) return;
      const obj = objectBefore(tree.rootNode, doc, pos);
      if (obj) {
        const typeName = resolver.expressionType(obj, fsPathOf(doc.uri));
        if (!typeName) return;
        const members = resolver.membersOfType(typeName);
        return members.map((m, i) => {
          const item = new vscode.CompletionItem({ label: m.name, description: m.signature }, KIND_TO_COMPLETION[m.kind]);
          item.detail = `${kindWord(m.kind)} ${m.qualname}`;
          item.sortText = String(i).padStart(4, '0'); // declaration order, like the struct itself
          return item;
        });
      }
      const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
      const prefix = wordRange ? doc.getText(new vscode.Range(wordRange.start, pos)) : '';
      if (prefix.length < 2) return;
      const items: vscode.CompletionItem[] = [];
      const seen = new Set<string>();
      for (const l of localDeclarations(tree.rootNode, pos)) {
        if (!l.name.startsWith(prefix)) continue;
        seen.add(l.name);
        const item = new vscode.CompletionItem({ label: l.name, description: l.type }, vscode.CompletionItemKind.Variable);
        item.detail = t('kindLocal');
        item.sortText = '0' + l.name;
        items.push(item);
      }
      for (const s of store.symbolsWithPrefix(prefix, 150)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        const item = new vscode.CompletionItem({ label: s.name, description: s.kind === 'function' || s.kind === 'prototype' || s.kind === 'method' ? s.signature : undefined }, KIND_TO_COMPLETION[s.kind]);
        item.detail = `${kindWord(s.kind)} · ${relPath(s.path)}`;
        item.sortText = '1' + s.name;
        items.push(item);
      }
      return new vscode.CompletionList(items, true);
    },
  };

  const rename: vscode.RenameProvider = {
    async prepareRename(doc, pos) {
      const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
      if (!range) throw new Error(t('noSymbolHere'));
      const res = await service.resolveAt(doc, pos);
      if (!res) throw new Error(t('noSymbolHere'));
      return { range, placeholder: doc.getText(range) };
    },
    async provideRenameEdits(doc, pos, newName) {
      const res = await service.resolveAt(doc, pos);
      if (!res) return;
      const edit = new vscode.WorkspaceEdit();
      const locations = await service.references(res, doc, true, false);
      for (const l of locations) edit.replace(l.uri, l.range, newName);
      return edit;
    },
  };

  const toTypeItem = (s: SymbolRow) => {
    const start = new vscode.Position(s.line, s.col);
    const item = new vscode.TypeHierarchyItem(KIND_TO_VSCODE[s.kind], s.qualname, relPath(s.path), vscode.Uri.file(s.path), new vscode.Range(start, new vscode.Position(s.endLine, 0)), new vscode.Range(start, start.translate(0, s.name.length)));
    (item as vscode.TypeHierarchyItem & { siId: number }).siId = s.id;
    return item;
  };
  const typeHierarchy: vscode.TypeHierarchyProvider = {
    async prepareTypeHierarchy(doc, pos) {
      const res = await service.resolveAt(doc, pos);
      const syms = res?.kind === 'symbols' ? res.symbols : res?.kind === 'member' ? [res.symbol] : [];
      const cls = syms.find((s) => s.kind === 'class' || s.kind === 'struct')
        ?? (res && 'name' in res ? store.findDefinitions(res.name).find((s) => s.kind === 'class' || s.kind === 'struct') : undefined);
      return cls ? toTypeItem(cls) : undefined;
    },
    provideTypeHierarchySupertypes(item) {
      const id = (item as vscode.TypeHierarchyItem & { siId?: number }).siId;
      if (id == null) return [];
      return store.basesOf(id).filter((b) => b.symbol).map((b) => toTypeItem(b.symbol!));
    },
    provideTypeHierarchySubtypes(item) {
      return store.derivedOf(item.name.split('::').pop() ?? item.name).map(toTypeItem);
    },
  };

  // Declaration = prototypes (Go to Declaration), the counterpart of Go to Definition.
  const declaration: vscode.DeclarationProvider = {
    async provideDeclaration(doc, pos) {
      const res = await service.resolveAt(doc, pos);
      if (!res || res.kind !== 'symbols') return;
      const protos = store.findSymbols(res.name).filter((s) => s.kind === 'prototype');
      return protos.map((s) => new vscode.Location(vscode.Uri.file(s.path), new vscode.Range(s.line, s.col, s.line, s.col + s.name.length)));
    },
  };

  // Signature help from the indexed prototype/definition: `name(` and `,` show the parameter list.
  const signatureHelp: vscode.SignatureHelpProvider = {
    provideSignatureHelp(doc, pos) {
      const call = enclosingCall(doc, pos);
      if (!call) return;
      const defs = store.findSymbols(call.name).filter((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'prototype' || s.kind === 'macro');
      if (!defs.length) return;
      const seen = new Set<string>();
      const help = new vscode.SignatureHelp();
      for (const d of defs) {
        const sig = d.signature.replace(/\s*[{;]\s*$/, '');
        if (seen.has(sig)) continue;
        seen.add(sig);
        const info = new vscode.SignatureInformation(sig, `${kindWord(d.kind)} · ${relPath(d.path)}:${d.line + 1}`);
        const open = sig.indexOf('(');
        const close = sig.lastIndexOf(')');
        if (open >= 0 && close > open) {
          for (const p of splitParams(sig.slice(open + 1, close))) info.parameters.push(new vscode.ParameterInformation(p.trim()));
        }
        help.signatures.push(info);
      }
      help.activeSignature = 0;
      help.activeParameter = Math.min(call.argIndex, Math.max(0, (help.signatures[0]?.parameters.length ?? 1) - 1));
      return help;
    },
  };

  return [
    vscode.languages.registerDeclarationProvider(SELECTOR, declaration),
    vscode.languages.registerSignatureHelpProvider(SELECTOR, signatureHelp, '(', ','),
    vscode.languages.registerTypeHierarchyProvider(SELECTOR, typeHierarchy),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, outline, { label: 'Source Insight Lite' }),
    vscode.languages.registerDocumentHighlightProvider(SELECTOR, highlight),
    vscode.languages.registerCompletionItemProvider(SELECTOR, completion, '.', '>', ':'),
    vscode.languages.registerRenameProvider(SELECTOR, rename),
  ];
}

export type { SymbolRow };
