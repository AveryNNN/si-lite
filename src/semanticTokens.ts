// Source Insight style "contextual syntax formatting": colour identifiers by what the project
// database and the local syntax tree say they are, not by regex guesses.
import * as vscode from 'vscode';
import type { Node } from 'web-tree-sitter';
import type { Store } from './core/store';
import type { DocTrees } from './docTree';

const TOKEN_TYPES = ['function', 'macro', 'parameter', 'variable', 'property', 'type', 'struct', 'class', 'enum', 'enumMember', 'namespace'] as const;
const TOKEN_MODIFIERS = ['declaration', 'readonly', 'static', 'defaultLibrary'] as const;
export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

type TokenType = (typeof TOKEN_TYPES)[number];
const T: Record<TokenType, number> = Object.fromEntries(TOKEN_TYPES.map((t, i) => [t, i])) as Record<TokenType, number>;
const M_DECL = 1 << 0;
const M_STATIC = 1 << 2;

interface NameSets {
  macros: Set<string>;
  enumerators: Set<string>;
  globals: Set<string>;
  functions: Set<string>;
  structs: Set<string>;
  classes: Set<string>;
  enums: Set<string>;
  typedefs: Set<string>;
  namespaces: Set<string>;
}

/** Names of locals and parameters visible in a function body (shadowing across blocks is ignored). */
function collectLocals(fn: Node): { params: Set<string>; locals: Set<string> } {
  const params = new Set<string>();
  const locals = new Set<string>();
  const nameOf = (d: Node | null): string | undefined => {
    let n = d;
    while (n && n.type !== 'identifier' && n.type !== 'field_identifier') n = n.childForFieldName('declarator') ?? n.firstNamedChild;
    return n?.text;
  };
  const decl = fn.childForFieldName('declarator');
  const fd = decl?.type === 'function_declarator' ? decl : decl?.descendantsOfType('function_declarator')[0];
  for (const p of fd?.childForFieldName('parameters')?.namedChildren ?? []) {
    if (p.type.includes('parameter_declaration')) {
      for (const d of p.childrenForFieldName('declarator')) {
        const n = nameOf(d);
        if (n) params.add(n);
      }
    }
  }
  const body = fn.childForFieldName('body');
  if (body) {
    for (const d of body.descendantsOfType('declaration')) {
      for (const dd of d.childrenForFieldName('declarator')) {
        const n = nameOf(dd);
        if (n) locals.add(n);
      }
    }
  }
  return { params, locals };
}

export class SemanticProvider implements vscode.DocumentSemanticTokensProvider {
  private sets?: NameSets;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this._onDidChange.event;

  constructor(private readonly store: Store, private readonly trees: DocTrees) {}

  /** Call when the symbol database changed. */
  invalidate(): void {
    this.sets = undefined;
    this._onDidChange.fire();
  }

  private names(): NameSets {
    if (!this.sets) {
      this.sets = {
        macros: this.store.namesOfKind(['macro']),
        enumerators: this.store.namesOfKind(['enumerator']),
        globals: this.store.namesOfKind(['variable']),
        functions: this.store.namesOfKind(['function', 'prototype', 'method']),
        structs: this.store.namesOfKind(['struct', 'union']),
        classes: this.store.namesOfKind(['class']),
        enums: this.store.namesOfKind(['enum']),
        typedefs: this.store.namesOfKind(['typedef']),
        namespaces: this.store.namesOfKind(['namespace']),
      };
    }
    return this.sets;
  }

  async provideDocumentSemanticTokens(doc: vscode.TextDocument): Promise<vscode.SemanticTokens | undefined> {
    const tree = await this.trees.get(doc);
    if (!tree) return undefined;
    const sets = this.names();
    const b = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
    const push = (n: Node, type: TokenType, mods = 0) => {
      const s = n.startPosition;
      const e = n.endPosition;
      if (s.row !== e.row) return;
      b.push(s.row, s.column, e.column - s.column, T[type], mods);
    };

    type Scope = { params: Set<string>; locals: Set<string> } | undefined;
    const walk = (node: Node, scope: Scope) => {
      const visit = (n: Node, sc: Scope) => {
        let inner = sc;
        if (n.type === 'function_definition') inner = collectLocals(n);
        switch (n.type) {
          case 'identifier': {
            const name = n.text;
            const parent = n.parent;
            const isCallee = parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === n.id;
            const isDeclName = parent?.type === 'init_declarator' || parent?.type === 'function_declarator' || parent?.type === 'declaration' || parent?.type === 'parameter_declaration' || parent?.type === 'pointer_declarator' || parent?.type === 'array_declarator';
            if (isCallee) push(n, sets.macros.has(name) && !sets.functions.has(name) ? 'macro' : 'function');
            else if (inner?.params.has(name)) push(n, 'parameter', isDeclName ? M_DECL : 0);
            else if (inner?.locals.has(name)) push(n, 'variable', isDeclName ? M_DECL : 0);
            else if (sets.macros.has(name)) push(n, 'macro');
            else if (sets.enumerators.has(name)) push(n, 'enumMember');
            else if (sets.functions.has(name)) push(n, 'function', isDeclName ? M_DECL : 0);
            else if (sets.globals.has(name)) push(n, 'variable', M_STATIC | (isDeclName ? M_DECL : 0));
            else if (sets.namespaces.has(name)) push(n, 'namespace');
            return;
          }
          case 'field_identifier':
            push(n, 'property');
            return;
          case 'type_identifier': {
            const name = n.text;
            if (sets.classes.has(name)) push(n, 'class');
            else if (sets.structs.has(name)) push(n, 'struct');
            else if (sets.enums.has(name)) push(n, 'enum');
            else push(n, 'type');
            return;
          }
          case 'namespace_identifier':
            push(n, 'namespace');
            return;
          case 'preproc_def':
          case 'preproc_function_def': {
            const nm = n.childForFieldName('name');
            if (nm) push(nm, 'macro', M_DECL);
            return;
          }
          case 'enumerator': {
            const nm = n.childForFieldName('name');
            if (nm) push(nm, 'enumMember', M_DECL);
            return;
          }
          case 'comment':
          case 'string_literal':
          case 'preproc_include':
            return;
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c) visit(c, inner);
        }
      };
      visit(node, scope);
    };
    walk(tree.rootNode, undefined);
    return b.build();
  }
}
