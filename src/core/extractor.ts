import type { Node, Query, Tree } from 'web-tree-sitter';
import type { Lang, SymbolKind } from './languages';

export interface SymbolRec {
  name: string;
  qualname: string;
  kind: SymbolKind;
  line: number;
  col: number;
  startLine: number;
  endLine: number;
  signature: string;
  startIdx: number;
  endIdx: number;
}

export interface RefRec {
  name: string;
  kind: 'call' | 'ref';
  line: number;
  col: number;
  /** Index into FileIndex.symbols of the enclosing function, or -1. */
  fromSymbol: number;
}

export interface IncludeRec {
  path: string;
  line: number;
  isSystem: boolean;
}

export interface FileIndex {
  symbols: SymbolRec[];
  refs: RefRec[];
  includes: IncludeRec[];
  /** (index into symbols, base class name) for class/struct definitions with a base clause. */
  bases: Array<{ symbol: number; base: string }>;
}

export interface ExtractOptions {
  indexReferences: boolean;
  /** Identifiers blanked out before parsing (decorator macros such as av_cold or __init). */
  ignoreMacros?: string[];
}

const TOP_LEVEL_PARENTS = new Set([
  'translation_unit',
  'declaration_list',
  'linkage_specification',
  'preproc_if',
  'preproc_ifdef',
  'preproc_else',
  'preproc_elif',
  'preproc_elifdef',
  'template_declaration',
  'export_declaration',
]);

const SCOPE_NODES = new Set([
  'namespace_definition',
  'class_specifier',
  'struct_specifier',
  'union_specifier',
]);

const NAME_TYPES = new Set([
  'identifier',
  'field_identifier',
  'type_identifier',
  'qualified_identifier',
  'destructor_name',
  'operator_name',
  'template_function',
]);

function collapse(text: string, max = 240): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function firstLine(text: string, max = 200): string {
  const nl = text.indexOf('\n');
  return collapse(nl < 0 ? text : text.slice(0, nl), max);
}

interface Unwrapped {
  nameNode?: Node;
  isFunction: boolean;
  isFnPointer: boolean;
}

/** Peel declarator wrappers to reach the declared name and classify it. */
function unwrapDeclarator(start: Node | null): Unwrapped {
  let n: Node | null = start;
  let sawFunction = false;
  let parenAfterFunction = false;
  while (n) {
    switch (n.type) {
      case 'init_declarator':
      case 'pointer_declarator':
      case 'array_declarator':
      case 'attributed_declarator':
        n = n.childForFieldName('declarator') ?? n.firstNamedChild;
        continue;
      case 'reference_declarator':
        n = n.namedChildren[n.namedChildren.length - 1] ?? null;
        continue;
      case 'parenthesized_declarator':
        if (sawFunction) parenAfterFunction = true;
        n = n.firstNamedChild;
        continue;
      case 'function_declarator':
        if (sawFunction && parenAfterFunction) parenAfterFunction = false; // e.g. void (*signal(int))(int)
        sawFunction = true;
        n = n.childForFieldName('declarator');
        continue;
      default:
        return {
          nameNode: NAME_TYPES.has(n.type) ? n : undefined,
          isFunction: sawFunction && !parenAfterFunction,
          isFnPointer: sawFunction && parenAfterFunction,
        };
    }
  }
  return { isFunction: false, isFnPointer: false };
}

function shortName(nameNode: Node): string {
  let n: Node = nameNode;
  for (;;) {
    if (n.type === 'qualified_identifier') {
      const inner = n.childForFieldName('name');
      if (!inner) break;
      n = inner;
      continue;
    }
    if (n.type === 'template_function' || n.type === 'template_method') {
      const inner = n.childForFieldName('name');
      if (!inner) break;
      n = inner;
      continue;
    }
    break;
  }
  return n.text;
}

/** Name of an aggregate; `typedef struct { ... } foo_t;` borrows the typedef name so members become foo_t::x. */
function aggregateName(spec: Node): string | undefined {
  const nameNode = spec.childForFieldName('name');
  if (nameNode) return nameNode.text;
  const parent = spec.parent;
  if (parent?.type === 'type_definition') {
    for (const d of parent.childrenForFieldName('declarator')) {
      const u = unwrapDeclarator(d);
      if (u.nameNode) return u.nameNode.text;
    }
  }
  return undefined;
}

function scopeOf(node: Node): { qual: string; inClass: boolean } {
  const parts: string[] = [];
  let inClass = false;
  let p = node.parent;
  while (p) {
    if (SCOPE_NODES.has(p.type)) {
      const name = p.type === 'namespace_definition' ? p.childForFieldName('name')?.text : aggregateName(p);
      if (name) {
        parts.unshift(name);
        if (p.type !== 'namespace_definition') inClass = true;
      }
    }
    p = p.parent;
  }
  return { qual: parts.join('::'), inClass };
}

function qualify(scope: string, name: string): string {
  if (!scope || name.includes('::')) return name;
  return scope + '::' + name;
}

function normalizeInclude(raw: string): { path: string; isSystem: boolean } {
  const isSystem = raw.startsWith('<');
  let p = raw.replace(/^[<"]|[>"]$/g, '').replace(/\\/g, '/');
  while (p.startsWith('./') || p.startsWith('../')) p = p.replace(/^\.\.?\//, '');
  return { path: p, isSystem };
}

export function extract(tree: Tree, query: Query, _lang: Lang, opts: ExtractOptions): FileIndex {
  const symbols: SymbolRec[] = [];
  const includes: IncludeRec[] = [];
  const bases: Array<{ symbol: number; base: string }> = [];
  const calls: Array<{ node: Node; name: string; idx: number }> = [];
  const idents: Node[] = [];
  const namePositions = new Set<number>();

  const push = (kind: SymbolKind, nameNode: Node, outer: Node, qual: string, signature: string) => {
    namePositions.add(nameNode.startIndex);
    symbols.push({
      name: shortName(nameNode),
      qualname: qual,
      kind,
      line: nameNode.startPosition.row,
      col: nameNode.startPosition.column,
      startLine: outer.startPosition.row,
      endLine: outer.endPosition.row,
      signature,
      startIdx: outer.startIndex,
      endIdx: outer.endIndex,
    });
  };

  const patternNames = query.captureNames;
  for (const m of query.matches(tree.rootNode)) {
    const caps = new Map<string, Node>();
    for (const c of m.captures) caps.set(c.name, c.node);
    const outerName = patternOuter(m.captures.map((c) => c.name), patternNames);
    const outer = caps.get(outerName);
    if (!outer) continue;

    switch (outerName) {
      case 'fn': {
        const { nameNode } = unwrapDeclarator(outer.childForFieldName('declarator'));
        if (!nameNode) break;
        const { qual, inClass } = scopeOf(outer);
        const body = outer.childForFieldName('body');
        const sig = collapse(outer.text.slice(0, body ? body.startIndex - outer.startIndex : undefined));
        push(inClass ? 'method' : 'function', nameNode, outer, qualify(qual, nameNode.text), sig);
        break;
      }
      case 'decl': {
        if (!outer.parent || !TOP_LEVEL_PARENTS.has(outer.parent.type)) break;
        const { qual } = scopeOf(outer);
        for (const d of outer.childrenForFieldName('declarator')) {
          const u = unwrapDeclarator(d);
          if (!u.nameNode) continue;
          push(u.isFunction ? 'prototype' : 'variable', u.nameNode, outer, qualify(qual, u.nameNode.text), collapse(outer.text));
        }
        break;
      }
      case 'field': {
        const { qual } = scopeOf(outer);
        for (const d of outer.childrenForFieldName('declarator')) {
          const u = unwrapDeclarator(d);
          if (!u.nameNode) continue;
          push(u.isFunction ? 'prototype' : 'field', u.nameNode, outer, qualify(qual, u.nameNode.text), collapse(outer.text, 160));
        }
        break;
      }
      case 'struct':
      case 'class':
      case 'union':
      case 'enum': {
        const nameNode = caps.get('name');
        if (!nameNode) break;
        const { qual } = scopeOf(outer);
        push(outerName, nameNode, outer, qualify(qual, nameNode.text), firstLine(outer.text));
        const clause = outer.namedChildren.find((c) => c.type === 'base_class_clause');
        if (clause) {
          for (const b of clause.namedChildren) {
            if (b.type === 'type_identifier' || b.type === 'qualified_identifier' || b.type === 'template_type') {
              const text = b.type === 'template_type' ? (b.childForFieldName('name')?.text ?? b.text) : b.text;
              bases.push({ symbol: symbols.length - 1, base: text.split('::').pop()! });
            }
          }
        }
        break;
      }
      case 'enumerator': {
        const nameNode = caps.get('name');
        if (nameNode) push('enumerator', nameNode, outer, nameNode.text, firstLine(outer.text));
        break;
      }
      case 'typedef': {
        const { qual } = scopeOf(outer);
        for (const d of outer.childrenForFieldName('declarator')) {
          const u = unwrapDeclarator(d);
          if (u.nameNode) push('typedef', u.nameNode, outer, qualify(qual, u.nameNode.text), firstLine(outer.text));
        }
        break;
      }
      case 'macro': {
        const nameNode = caps.get('name');
        if (nameNode) push('macro', nameNode, outer, nameNode.text, firstLine(outer.text));
        break;
      }
      case 'namespace': {
        const nameNode = caps.get('name');
        if (!nameNode) break;
        const { qual } = scopeOf(outer);
        push('namespace', nameNode, outer, qualify(qual, nameNode.text), 'namespace ' + nameNode.text);
        break;
      }
      case 'include': {
        const pathNode = caps.get('path');
        if (!pathNode) break;
        const { path, isSystem } = normalizeInclude(pathNode.text);
        includes.push({ path, line: outer.startPosition.row, isSystem });
        break;
      }
      case 'call': {
        const nameNode = caps.get('name');
        if (nameNode) calls.push({ node: nameNode, name: nameNode.text, idx: nameNode.startIndex });
        break;
      }
      case 'ident':
        if (opts.indexReferences) idents.push(outer);
        break;
    }
  }

  // Enclosing-function lookup for references.
  const fnRanges = symbols
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === 'function' || s.kind === 'method')
    .sort((a, b) => a.s.startIdx - b.s.startIdx);
  const maxEndPrefix: number[] = [];
  let running = -1;
  for (const r of fnRanges) {
    running = Math.max(running, r.s.endIdx);
    maxEndPrefix.push(running);
  }
  const enclosing = (idx: number): number => {
    let lo = 0;
    let hi = fnRanges.length - 1;
    let j = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fnRanges[mid].s.startIdx <= idx) {
        j = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (; j >= 0; j--) {
      if (maxEndPrefix[j] < idx) break;
      if (fnRanges[j].s.endIdx >= idx) return fnRanges[j].i;
    }
    return -1;
  };

  const refs: RefRec[] = [];
  const callPositions = new Set<number>();
  for (const c of calls) {
    callPositions.add(c.idx);
    refs.push({
      name: c.name,
      kind: 'call',
      line: c.node.startPosition.row,
      col: c.node.startPosition.column,
      fromSymbol: enclosing(c.idx),
    });
  }
  for (const n of idents) {
    const idx = n.startIndex;
    if (namePositions.has(idx) || callPositions.has(idx)) continue;
    refs.push({
      name: n.text,
      kind: 'ref',
      line: n.startPosition.row,
      col: n.startPosition.column,
      fromSymbol: enclosing(idx),
    });
  }

  return { symbols, refs, includes, bases };
}

const OUTER_NAMES = new Set([
  'fn', 'decl', 'field', 'struct', 'class', 'union', 'enum', 'enumerator',
  'typedef', 'macro', 'namespace', 'include', 'call', 'ident',
]);

function patternOuter(captureNames: string[], _all: string[]): string {
  for (const n of captureNames) if (OUTER_NAMES.has(n)) return n;
  return '';
}
