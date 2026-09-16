// Scope- and type-aware resolution of the identifier at a position, on top of the name-based store.
// Handles what plain name lookup gets wrong: locals/parameters (`int c` in one function vs `float c`
// in another), field access through a typed object (`pkt->c` picks struct pkt's c), and same-file
// preference for static globals. Works on the current file's syntax tree; no compiler needed.
import type { Node, Tree } from 'web-tree-sitter';
import type { Store, SymbolRow } from './store';

export interface Pos {
  line: number;
  col: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export type Resolution =
  | {
      kind: 'local';
      name: string;
      typeText: string;
      isParam: boolean;
      decl: Range;
      scope: Range;
      scopeName?: string;
      refs: Range[];
    }
  | { kind: 'member'; name: string; symbol: SymbolRow; ownerType: string }
  | { kind: 'symbols'; name: string; symbols: SymbolRow[]; isCall: boolean };

const SCOPE_TYPES = new Set(['compound_statement', 'for_statement', 'function_definition', 'lambda_expression', 'catch_clause']);

function toPos(n: Node, end = false): Pos {
  const p = end ? n.endPosition : n.startPosition;
  return { line: p.row, col: p.column };
}

function rangeOf(n: Node): Range {
  return { start: toPos(n), end: toPos(n, true) };
}

/** Innermost name node of a declarator chain (identifier / field_identifier), plus pointer depth. */
function declaratorName(d: Node | null): { node: Node; stars: number } | undefined {
  let n = d;
  let stars = 0;
  while (n) {
    switch (n.type) {
      case 'init_declarator':
      case 'array_declarator':
      case 'attributed_declarator':
      case 'function_declarator':
        n = n.childForFieldName('declarator') ?? n.firstNamedChild;
        continue;
      case 'pointer_declarator':
        stars++;
        n = n.childForFieldName('declarator') ?? n.firstNamedChild;
        continue;
      case 'reference_declarator':
      case 'parenthesized_declarator':
        n = n.namedChildren[n.namedChildren.length - 1] ?? null;
        continue;
      case 'identifier':
      case 'field_identifier':
        return { node: n, stars };
      default:
        return undefined;
    }
  }
  return undefined;
}

function typeTextOf(decl: Node, stars: number): string {
  // Everything before the declarator: qualifiers, storage class and the type itself.
  const parts: string[] = [];
  for (const c of decl.namedChildren) {
    if (c.type.endsWith('declarator') || c.type === 'identifier' || c.type === 'field_identifier') break;
    if (c.type === 'comment') continue;
    parts.push(c.text);
  }
  const t = parts.length ? parts.join(' ') : (decl.childForFieldName('type')?.text ?? '');
  return (t + (stars ? ' ' + '*'.repeat(stars) : '')).replace(/\s+/g, ' ');
}

/** Base type name: strips qualifiers, struct/union/enum keywords, pointers, arrays, templates. */
export function baseTypeName(typeText: string): string | undefined {
  const cleaned = typeText
    .replace(/\b(const|volatile|static|extern|register|restrict|struct|union|enum|class|unsigned|signed)\b/g, ' ')
    .replace(/[*&\[\]]/g, ' ')
    .replace(/<.*$/, ' ')
    .trim();
  const m = /([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*$/.exec(cleaned);
  return m?.[1];
}

/** Type part of a collapsed declaration such as `static struct pkt *g_pkt = 0;` for `g_pkt`. */
export function typeFromDeclaration(signature: string, name: string): string | undefined {
  const m = new RegExp('^(.*?)\\b' + name + '\\b').exec(signature);
  return baseTypeName(m ? m[1] : signature);
}

interface LocalDecl {
  nameNode: Node;
  decl: Node;
  typeText: string;
  scope: Node;
}

/** Find the declaration of `name` visible at `from`: walks enclosing blocks, for-inits and parameters. */
function findLocalDecl(from: Node, name: string): LocalDecl | undefined {
  let scope: Node | null = from.parent;
  while (scope) {
    if (SCOPE_TYPES.has(scope.type)) {
      const found = declInScope(scope, name, from.startIndex);
      if (found) return found;
    }
    scope = scope.parent;
  }
  return undefined;
}

function declInScope(scope: Node, name: string, beforeIndex: number): LocalDecl | undefined {
  const check = (decl: Node, declScope: Node): LocalDecl | undefined => {
    for (const d of decl.childrenForFieldName('declarator')) {
      const dn = declaratorName(d);
      if (dn && dn.node.text === name) return { nameNode: dn.node, decl, typeText: typeTextOf(decl, dn.stars), scope: declScope };
    }
    return undefined;
  };
  switch (scope.type) {
    case 'compound_statement':
      for (const c of scope.namedChildren) {
        if (c.startIndex >= beforeIndex) break;
        if (c.type === 'declaration') {
          const r = check(c, scope);
          if (r) return r;
        }
      }
      return undefined;
    case 'for_statement': {
      const init = scope.childForFieldName('initializer');
      if (init?.type === 'declaration') return check(init, scope);
      return undefined;
    }
    case 'function_definition':
    case 'lambda_expression': {
      const decl = scope.childForFieldName('declarator');
      const fn = decl?.type === 'function_declarator' ? decl : decl?.descendantsOfType('function_declarator')[0];
      const params = fn?.childForFieldName('parameters');
      for (const p of params?.namedChildren ?? []) {
        if (p.type === 'parameter_declaration' || p.type === 'optional_parameter_declaration') {
          const r = check(p, scope);
          if (r) return r;
        }
      }
      return undefined;
    }
    case 'catch_clause': {
      const params = scope.childForFieldName('parameters');
      for (const p of params?.namedChildren ?? []) {
        const r = check(p, scope);
        if (r) return r;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Name of the struct/class/union whose body contains `n`; anonymous typedef'd structs borrow the typedef name. */
function enclosingAggregateName(n: Node): string | undefined {
  let p: Node | null = n.parent;
  while (p && p.type !== 'struct_specifier' && p.type !== 'class_specifier' && p.type !== 'union_specifier') p = p.parent;
  if (!p) return undefined;
  const nameNode = p.childForFieldName('name');
  if (nameNode) return nameNode.text;
  if (p.parent?.type === 'type_definition') {
    for (const d of p.parent.childrenForFieldName('declarator')) {
      const dn = declaratorName(d);
      if (dn) return dn.node.text;
    }
  }
  return undefined;
}

function enclosingFunctionName(n: Node): string | undefined {
  let p: Node | null = n;
  while (p && p.type !== 'function_definition') p = p.parent;
  if (!p) return undefined;
  return declaratorName(p.childForFieldName('declarator'))?.node.text;
}

/** Every identifier with this name inside the scope subtree (shadowing is ignored). */
function identifierUses(scope: Node, name: string, includeFields = false): Range[] {
  const out: Range[] = [];
  const stack: Node[] = [scope];
  while (stack.length) {
    const n = stack.pop()!;
    if ((n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier') && n.text === name) {
      // For a variable, `x.name` / `x->name` is a field, not this variable.
      const isField = n.type === 'field_identifier';
      if (includeFields || !isField) out.push(rangeOf(n));
      continue;
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  out.sort((a, b) => a.start.line - b.start.line || a.start.col - b.start.col);
  return out;
}

/** All identifier-like nodes with this name in the whole tree (for highlight / rename of non-locals). */
export function occurrencesInTree(tree: Tree, name: string): Range[] {
  return identifierUses(tree.rootNode, name, true);
}

export class Resolver {
  constructor(private readonly store: Store) {}

  /** Resolve the identifier at `pos` in a parsed file. `filePath` is the normalized path of that file. */
  resolve(tree: Tree, filePath: string, pos: Pos): Resolution | undefined {
    const node = tree.rootNode.descendantForPosition({ row: pos.line, column: pos.col });
    if (!node) return undefined;
    const name = node.text;
    if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;

    // pkt->c / pkt.c : resolve through the object's type.
    if (node.type === 'field_identifier' && node.parent?.type === 'field_expression' && node.parent.childForFieldName('field')?.id === node.id) {
      const objType = this.expressionType(node.parent.childForFieldName('argument'), filePath);
      if (objType) {
        const member = this.memberOf(objType, name);
        if (member) return { kind: 'member', name, symbol: member, ownerType: objType };
      }
      return this.byName(name, filePath, false);
    }

    // `int c;` inside a struct body: the member's own declaration.
    if (node.type === 'field_identifier' && node.parent?.type !== 'field_expression') {
      const owner = enclosingAggregateName(node);
      if (owner) {
        const member = this.memberOf(owner, name);
        if (member) return { kind: 'member', name, symbol: member, ownerType: owner };
      }
    }

    if (node.type === 'identifier') {
      const local = findLocalDecl(node, name);
      if (local) {
        return {
          kind: 'local',
          name,
          typeText: local.typeText,
          isParam: local.decl.type.startsWith('parameter') || local.decl.type === 'optional_parameter_declaration',
          decl: rangeOf(local.nameNode),
          scope: rangeOf(local.scope),
          scopeName: enclosingFunctionName(node),
          refs: identifierUses(local.scope, name),
        };
      }
    }

    const isCall = node.parent?.type === 'call_expression';
    return this.byName(name, filePath, isCall);
  }

  private byName(name: string, filePath: string, isCall: boolean): Resolution | undefined {
    const syms = this.store.findDefinitions(name);
    if (!syms.length) return undefined;
    // Same-file definitions first (static globals, file-local helpers), keep the store's order otherwise.
    const here = filePath.toLowerCase();
    const ordered = [...syms.filter((s) => s.path.toLowerCase() === here), ...syms.filter((s) => s.path.toLowerCase() !== here)];
    return { kind: 'symbols', name, symbols: ordered, isCall };
  }

  /** Static type name of an expression, best effort. */
  expressionType(expr: Node | null, filePath: string, depth = 0): string | undefined {
    if (!expr || depth > 4) return undefined;
    switch (expr.type) {
      case 'parenthesized_expression':
        return this.expressionType(expr.namedChildren[0] ?? null, filePath, depth + 1);
      case 'pointer_expression':
      case 'unary_expression':
        return this.expressionType(expr.childForFieldName('argument'), filePath, depth + 1);
      case 'subscript_expression':
        return this.expressionType(expr.childForFieldName('argument'), filePath, depth + 1);
      case 'cast_expression':
        return baseTypeName(expr.childForFieldName('type')?.text ?? '');
      case 'this': {
        let p: Node | null = expr;
        while (p && p.type !== 'class_specifier' && p.type !== 'struct_specifier') p = p.parent;
        return p?.childForFieldName('name')?.text;
      }
      case 'identifier': {
        const name = expr.text;
        const local = findLocalDecl(expr, name);
        if (local) return baseTypeName(local.typeText);
        const g = this.store.findDefinitions(name).find((s) => s.kind === 'variable' || s.kind === 'field');
        return g ? typeFromDeclaration(g.signature, name) : undefined;
      }
      case 'field_expression': {
        const owner = this.expressionType(expr.childForFieldName('argument'), filePath, depth + 1);
        const field = expr.childForFieldName('field')?.text;
        if (!owner || !field) return undefined;
        const m = this.memberOf(owner, field);
        return m ? typeFromDeclaration(m.signature, field) : undefined;
      }
      case 'call_expression': {
        const fn = expr.childForFieldName('function');
        const fname = fn?.type === 'identifier' ? fn.text : undefined;
        if (!fname) return undefined;
        const def = this.store.findDefinitions(fname).find((s) => s.kind === 'function' || s.kind === 'prototype');
        if (!def) return undefined;
        const sig = def.signature.slice(0, def.signature.indexOf(fname));
        return baseTypeName(sig);
      }
    }
    return undefined;
  }

  /** All members of an aggregate, following typedef indirection like memberOf(). */
  membersOfType(typeName: string): SymbolRow[] {
    const direct = this.store.membersOf(typeName);
    if (direct.length) return direct;
    const td = this.store.findDefinitions(typeName).find((s) => s.kind === 'typedef');
    if (!td) return [];
    const tag = /typedef\s+(?:struct|union|class)\s+([A-Za-z_]\w*)/.exec(td.signature);
    if (tag && tag[1] !== typeName) {
      const viaTag = this.store.membersOf(tag[1]);
      if (viaTag.length) return viaTag;
    }
    const alias = /typedef\s+(?:struct\s+|union\s+)?([A-Za-z_]\w*)\s*\*?\s*[A-Za-z_]\w*\s*;/.exec(td.signature);
    return alias && alias[1] !== typeName ? this.store.membersOf(alias[1]) : [];
  }

  /** Member `field` of aggregate `typeName`, following one level of typedef indirection. */
  memberOf(typeName: string, field: string): SymbolRow | undefined {
    const direct = this.store.membersOf(typeName).find((m) => m.name === field);
    if (direct) return direct;
    const td = this.store.findDefinitions(typeName).find((s) => s.kind === 'typedef');
    if (td) {
      const m = /typedef\s+(?:struct|union|class)\s+([A-Za-z_]\w*)/.exec(td.signature);
      if (m && m[1] !== typeName) {
        const viaTag = this.store.membersOf(m[1]).find((x) => x.name === field);
        if (viaTag) return viaTag;
      }
      // typedef Foo Bar;  -> follow the alias
      const alias = /typedef\s+(?:struct\s+|union\s+)?([A-Za-z_]\w*)\s*\*?\s*[A-Za-z_]\w*\s*;/.exec(td.signature);
      if (alias && alias[1] !== typeName) return this.store.membersOf(alias[1]).find((x) => x.name === field);
    }
    return undefined;
  }
}
