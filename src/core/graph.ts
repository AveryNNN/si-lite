import type { FileRow, Store, SymbolRow } from './store';

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  qualname?: string;
  file?: string;
  line?: number;
  center?: boolean;
  external?: boolean;
  depth: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  count?: number;
  file?: string;
  line?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export type CallMode = 'callees' | 'callers' | 'both';
export type ClassMode = 'bases' | 'derived' | 'both';
export type IncludeMode = 'includes' | 'includedBy' | 'both';

export function isCallable(s: SymbolRow): boolean {
  return s.kind === 'function' || s.kind === 'method' || s.kind === 'macro';
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function buildCallGraph(store: Store, center: SymbolRow, mode: CallMode, depth: number, maxNodes: number): GraphData {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;

  const symId = (s: SymbolRow) => 'sym:' + s.id;
  const addSym = (s: SymbolRow, d: number, isCenter = false): string => {
    const id = symId(s);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: s.name,
        qualname: s.qualname,
        kind: s.kind,
        file: s.path,
        line: s.line,
        center: isCenter,
        depth: d,
      });
    }
    return id;
  };
  const addEdge = (e: GraphEdge) => {
    const key = e.source + '->' + e.target;
    const prev = edges.get(key);
    if (prev) prev.count = (prev.count ?? 1) + (e.count ?? 1);
    else edges.set(key, e);
  };
  const full = () => {
    if (nodes.size >= maxNodes) {
      truncated = true;
      return true;
    }
    return false;
  };

  addSym(center, 0, true);

  if (mode === 'callees' || mode === 'both') {
    let frontier: SymbolRow[] = [center];
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: SymbolRow[] = [];
      for (const s of frontier) {
        for (const c of store.calleesOf(s.id)) {
          if (full()) break;
          let tid: string;
          if (c.target) {
            const fresh = !nodes.has(symId(c.target));
            tid = addSym(c.target, d);
            if (fresh && (c.target.kind === 'function' || c.target.kind === 'method')) next.push(c.target);
          } else {
            tid = 'ext:' + c.name;
            if (!nodes.has(tid)) nodes.set(tid, { id: tid, label: c.name, kind: 'external', external: true, depth: d });
          }
          addEdge({ source: symId(s), target: tid, count: c.count, file: s.path, line: c.line });
        }
      }
      frontier = next;
    }
  }

  if (mode === 'callers' || mode === 'both') {
    let frontier: SymbolRow[] = [center];
    const seen = new Set<number>([center.id]);
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: SymbolRow[] = [];
      for (const s of frontier) {
        // Functions and macros are "called"; anything else (types, globals) is "referenced from".
        const limit = maxNodes * 4;
        const incoming = isCallable(s) ? store.callersOf(s.name, limit) : store.referencesOf(s.name, limit);
        if (incoming.length >= limit) truncated = true;
        for (const r of incoming) {
          if (full()) break;
          if (!r.fromSymbol) continue; // use at file scope (initializer), skip in graph
          const from = r.fromSymbol;
          if (from.id === s.id) {
            addEdge({ source: symId(s), target: symId(s), file: r.path, line: r.line });
            continue;
          }
          addSym(from, -d);
          addEdge({ source: symId(from), target: symId(s), file: r.path, line: r.line });
          if (!seen.has(from.id)) {
            seen.add(from.id);
            next.push(from);
          }
        }
      }
      frontier = next;
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

export function buildClassGraph(store: Store, center: SymbolRow, mode: ClassMode, depth: number, maxNodes: number): GraphData {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;
  const id = (s: SymbolRow) => 'sym:' + s.id;
  const add = (s: SymbolRow, d: number, isCenter = false) => {
    const k = id(s);
    if (!nodes.has(k)) nodes.set(k, { id: k, label: s.name, qualname: s.qualname, kind: s.kind, file: s.path, line: s.line, center: isCenter, depth: d });
    return k;
  };
  const edge = (from: string, to: string, file?: string, line?: number) => {
    const key = from + '->' + to;
    if (!edges.has(key)) edges.set(key, { source: from, target: to, file, line });
  };
  const full = () => (nodes.size >= maxNodes ? ((truncated = true), true) : false);
  add(center, 0, true);
  // Edges point from derived class to base class.
  if (mode === 'bases' || mode === 'both') {
    let frontier = [center];
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: SymbolRow[] = [];
      for (const s of frontier) {
        for (const b of store.basesOf(s.id)) {
          if (full()) break;
          let tid: string;
          if (b.symbol) {
            const fresh = !nodes.has(id(b.symbol));
            tid = add(b.symbol, d);
            if (fresh) next.push(b.symbol);
          } else {
            tid = 'ext:' + b.name;
            if (!nodes.has(tid)) nodes.set(tid, { id: tid, label: b.name, kind: 'external', external: true, depth: d });
          }
          edge(id(s), tid, s.path, s.line);
        }
      }
      frontier = next;
    }
  }
  if (mode === 'derived' || mode === 'both') {
    let frontier = [center];
    const seen = new Set([center.id]);
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: SymbolRow[] = [];
      for (const s of frontier) {
        for (const sub of store.derivedOf(s.name)) {
          if (full()) break;
          add(sub, -d);
          edge(id(sub), id(s), sub.path, sub.line);
          if (!seen.has(sub.id)) {
            seen.add(sub.id);
            next.push(sub);
          }
        }
      }
      frontier = next;
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

export function buildIncludeGraph(store: Store, center: FileRow, mode: IncludeMode, depth: number, maxNodes: number): GraphData {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;
  const fid = (f: FileRow) => 'file:' + f.id;
  const addFile = (f: FileRow, d: number, isCenter = false) => {
    const id = fid(f);
    if (!nodes.has(id)) nodes.set(id, { id, label: baseName(f.path), qualname: f.path, kind: 'file', file: f.path, line: 0, center: isCenter, depth: d });
    return id;
  };
  const addEdge = (e: GraphEdge) => {
    const key = e.source + '->' + e.target;
    if (!edges.has(key)) edges.set(key, e);
  };
  const full = () => {
    if (nodes.size >= maxNodes) {
      truncated = true;
      return true;
    }
    return false;
  };

  addFile(center, 0, true);

  if (mode === 'includes' || mode === 'both') {
    let frontier = [center];
    const seen = new Set<number>([center.id]);
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: FileRow[] = [];
      for (const f of frontier) {
        for (const inc of store.includesOf(f.id)) {
          if (full()) break;
          let tid: string;
          if (inc.resolved) {
            tid = addFile(inc.resolved, d);
            if (!seen.has(inc.resolved.id)) {
              seen.add(inc.resolved.id);
              next.push(inc.resolved);
            }
          } else {
            tid = 'ext:' + inc.path;
            if (!nodes.has(tid)) nodes.set(tid, { id: tid, label: inc.path, kind: inc.isSystem ? 'system' : 'external', external: true, depth: d });
          }
          addEdge({ source: fid(f), target: tid, file: f.path, line: inc.line });
        }
      }
      frontier = next;
    }
  }

  if (mode === 'includedBy' || mode === 'both') {
    let frontier = [center];
    const seen = new Set<number>([center.id]);
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: FileRow[] = [];
      for (const f of frontier) {
        for (const by of store.includedBy(f.path)) {
          if (full()) break;
          addFile(by.file, -d);
          addEdge({ source: fid(by.file), target: fid(f), file: by.file.path, line: by.line });
          if (!seen.has(by.file.id)) {
            seen.add(by.file.id);
            next.push(by.file);
          }
        }
      }
      frontier = next;
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}
