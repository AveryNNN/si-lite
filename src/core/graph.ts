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
  /** Directions that can still be expanded from this node ('callees' | 'callers' | 'group'). */
  expandable?: string[];
  expandedDir?: 'callees' | 'callers';
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

export interface CallGraphOptions {
  /** When one side of the centre has more direct neighbours than this, they are grouped by folder. */
  groupThreshold?: number;
  /** Folder groups the user opened ("side:dir"). */
  expandedGroups?: Set<string>;
  /** Nodes the user expanded further with the ⊕ handle: symbol id -> direction. */
  expanded?: Map<number, 'callees' | 'callers'>;
  /** Root used to shorten folder labels. */
  relRoot?: string;
}

function dirOf(p: string, relRoot?: string): string {
  let d = p.slice(0, Math.max(0, p.lastIndexOf('/')));
  if (relRoot && d.toLowerCase().startsWith(relRoot.toLowerCase())) d = d.slice(relRoot.length).replace(/^\//, '');
  return d || '/';
}

export function buildCallGraph(store: Store, center: SymbolRow, mode: CallMode, depth: number, maxNodes: number, opts: CallGraphOptions = {}): GraphData {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;
  const threshold = opts.groupThreshold ?? 24;
  const expandedGroups = opts.expandedGroups ?? new Set<string>();
  const expanded = opts.expanded ?? new Map<number, 'callees' | 'callers'>();

  const symId = (s: SymbolRow) => 'sym:' + s.id;
  const addSym = (s: SymbolRow, d: number, isCenter = false): string => {
    const id = symId(s);
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: s.name, qualname: s.qualname, kind: s.kind, file: s.path, line: s.line, center: isCenter, depth: d });
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

  /** Direct callees of s: resolved symbols plus external names. */
  const calleesOf = (s: SymbolRow) => store.calleesOf(s.id);
  /** Direct callers (or referencing functions for non-callables), deduplicated by function. */
  const callersOf = (s: SymbolRow) => {
    const limit = maxNodes * 4;
    const incoming = isCallable(s) ? store.callersOf(s.name, limit) : store.referencesOf(s.name, limit);
    if (incoming.length >= limit) truncated = true;
    const byFn = new Map<number, { from: SymbolRow; path: string; line: number; count: number }>();
    for (const r of incoming) {
      if (!r.fromSymbol) continue;
      const e = byFn.get(r.fromSymbol.id);
      if (e) e.count++;
      else byFn.set(r.fromSymbol.id, { from: r.fromSymbol, path: r.path, line: r.line, count: 1 });
    }
    return [...byFn.values()];
  };

  /** Add one level of callees below `s` (depth d). Returns the symbols to continue from. */
  const expandCallees = (s: SymbolRow, d: number, allowGrouping: boolean): SymbolRow[] => {
    const list = calleesOf(s);
    const next: SymbolRow[] = [];
    if (allowGrouping && list.length > threshold) {
      // Fold by folder; open folders contribute their members.
      const groups = new Map<string, typeof list>();
      for (const c of list) {
        const dir = c.target ? dirOf(c.target.path, opts.relRoot) : '(external)';
        (groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(c);
      }
      for (const [dir, members] of groups) {
        const gid = `grp:callees:${s.id}:${dir}`;
        if (expandedGroups.has(gid)) {
          for (const c of members) {
            if (full()) break;
            next.push(...addCallee(s, c, d));
          }
        } else {
          if (full()) break;
          nodes.set(gid, { id: gid, label: `${dir}/ (${members.length})`, kind: 'group', depth: d, qualname: dir });
          addEdge({ source: symId(s), target: gid, count: members.reduce((a, c) => a + c.count, 0) });
        }
      }
      return next;
    }
    for (const c of list) {
      if (full()) break;
      next.push(...addCallee(s, c, d));
    }
    return next;
  };
  const addCallee = (s: SymbolRow, c: ReturnType<typeof calleesOf>[number], d: number): SymbolRow[] => {
    let tid: string;
    const out: SymbolRow[] = [];
    if (c.target) {
      const fresh = !nodes.has(symId(c.target));
      tid = addSym(c.target, d);
      if (fresh && (c.target.kind === 'function' || c.target.kind === 'method')) out.push(c.target);
    } else {
      tid = 'ext:' + c.name;
      if (!nodes.has(tid)) nodes.set(tid, { id: tid, label: c.name, kind: 'external', external: true, depth: d });
    }
    addEdge({ source: symId(s), target: tid, count: c.count, file: s.path, line: c.line });
    return out;
  };

  const expandCallers = (s: SymbolRow, d: number, allowGrouping: boolean, seen: Set<number>): SymbolRow[] => {
    const list = callersOf(s);
    const next: SymbolRow[] = [];
    const add = (r: ReturnType<typeof callersOf>[number]) => {
      if (r.from.id === s.id) {
        addEdge({ source: symId(s), target: symId(s), file: r.path, line: r.line });
        return;
      }
      addSym(r.from, -d);
      addEdge({ source: symId(r.from), target: symId(s), file: r.path, line: r.line, count: r.count });
      if (!seen.has(r.from.id)) {
        seen.add(r.from.id);
        next.push(r.from);
      }
    };
    if (allowGrouping && list.length > threshold) {
      const groups = new Map<string, typeof list>();
      for (const r of list) {
        const dir = dirOf(r.from.path, opts.relRoot);
        (groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(r);
      }
      for (const [dir, members] of groups) {
        const gid = `grp:callers:${s.id}:${dir}`;
        if (expandedGroups.has(gid)) {
          for (const r of members) {
            if (full()) break;
            add(r);
          }
        } else {
          if (full()) break;
          nodes.set(gid, { id: gid, label: `${dir}/ (${members.length})`, kind: 'group', depth: -d, qualname: dir });
          addEdge({ source: gid, target: symId(s), count: members.reduce((a, r) => a + r.count, 0) });
        }
      }
      return next;
    }
    for (const r of list) {
      if (full()) break;
      add(r);
    }
    return next;
  };

  addSym(center, 0, true);
  const seenCallers = new Set<number>([center.id]);

  if (mode === 'callees' || mode === 'both') {
    let frontier: SymbolRow[] = [center];
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: SymbolRow[] = [];
      for (const s of frontier) next.push(...expandCallees(s, d, d === 1));
      frontier = next;
    }
  }
  if (mode === 'callers' || mode === 'both') {
    let frontier: SymbolRow[] = [center];
    for (let d = 1; d <= depth && frontier.length && !full(); d++) {
      const next: SymbolRow[] = [];
      for (const s of frontier) next.push(...expandCallers(s, d, d === 1, seenCallers));
      frontier = next;
    }
  }

  // User-driven expansion beyond the depth limit (the ⊕ handle on a node); repeat until stable so
  // chains of expanded nodes all appear.
  const done = new Set<string>();
  let progress = true;
  while (progress && !full()) {
    progress = false;
    for (const [id, dir] of expanded) {
      const key = `${id}:${dir}`;
      const node = nodes.get('sym:' + id);
      if (!node || done.has(key)) continue;
      done.add(key);
      progress = true;
      const s = store.getSymbol(id);
      if (!s) continue;
      const level = Math.abs(node.depth) + 1;
      if (dir === 'callees') expandCallees(s, level, false);
      else expandCallers(s, level, false, seenCallers);
    }
  }

  // Which leaves can still be expanded? (cheap counts; only for symbol nodes without children on that side)
  const hasOut = new Set<string>();
  const hasIn = new Set<string>();
  for (const e of edges.values()) {
    hasOut.add(e.source);
    hasIn.add(e.target);
  }
  for (const n of nodes.values()) {
    if (!n.id.startsWith('sym:') || n.center) continue;
    const sid = Number(n.id.slice(4));
    const expandable: string[] = [];
    if (n.depth > 0 && !hasOut.has(n.id) && (n.kind === 'function' || n.kind === 'method') && store.calleesOf(sid).length) expandable.push('callees');
    if (n.depth < 0 && !hasIn.has(n.id) && store.callerCount(n.label) > 0) expandable.push('callers');
    if (expandable.length) n.expandable = expandable;
    if (expanded.has(sid)) n.expandedDir = expanded.get(sid);
  }
  for (const n of nodes.values()) if (n.kind === 'group') n.expandable = ['group'];

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
