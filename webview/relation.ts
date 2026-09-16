import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

cytoscape.use(dagre);

interface GraphNode {
  id: string;
  label: string;
  kind: string;
  qualname?: string;
  file?: string;
  fileLabel?: string;
  line?: number;
  center?: boolean;
  external?: boolean;
  depth: number;
  expandable?: string[];
  expandedDir?: string;
}
interface GraphEdge {
  source: string;
  target: string;
  count?: number;
  file?: string;
  line?: number;
}
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modeEl = $<HTMLSelectElement>('mode');
const depthEl = $<HTMLSelectElement>('depth');
const followBtn = $<HTMLButtonElement>('follow');
const viewGraphBtn = $<HTMLButtonElement>('viewGraph');
const viewListBtn = $<HTMLButtonElement>('viewList');
const titleEl = $<HTMLDivElement>('title');
const emptyEl = $<HTMLDivElement>('empty');
const noteEl = $<HTMLDivElement>('note');
const listEl = $<HTMLDivElement>('list');
const cyEl = $<HTMLDivElement>('cy');

let strings: Record<string, string> = {
  noRelations: 'No relations found for {0}',
  nothingToShow: 'Nothing to show.',
  truncated: 'Graph truncated (siLite.maxGraphNodes)',
  nodesEdges: '{0} nodes, {1} edges',
  expandMore: 'expand',
  collapse: 'collapse',
  listCallers: 'Called by / used by',
  listCallees: 'Calls',
};
const fmt = (key: string, ...args: Array<string | number>) => (strings[key] ?? key).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

const KIND_COLOR: Record<string, string> = {
  function: '--vscode-symbolIcon-functionForeground',
  method: '--vscode-symbolIcon-methodForeground',
  macro: '--vscode-symbolIcon-constantForeground',
  struct: '--vscode-symbolIcon-structForeground',
  class: '--vscode-symbolIcon-classForeground',
  union: '--vscode-symbolIcon-structForeground',
  enum: '--vscode-symbolIcon-enumeratorForeground',
  typedef: '--vscode-symbolIcon-typeParameterForeground',
  variable: '--vscode-symbolIcon-variableForeground',
  field: '--vscode-symbolIcon-fieldForeground',
  prototype: '--vscode-symbolIcon-interfaceForeground',
  file: '--vscode-symbolIcon-fileForeground',
  group: '--vscode-symbolIcon-folderForeground',
  external: '--vscode-descriptionForeground',
  system: '--vscode-descriptionForeground',
};

const HANDLE = '⊕';
const HANDLE_OPEN = '⊖';

function nodeLabel(n: GraphNode): string {
  const handle = n.expandedDir ? ` ${HANDLE_OPEN}` : n.expandable?.length ? ` ${HANDLE}` : '';
  const second = n.kind === 'group' || n.external ? '' : n.fileLabel ? `\n${shortFile(n.fileLabel)}${n.line != null ? ':' + (n.line + 1) : ''}` : '';
  return n.label + handle + second;
}

function shortFile(p: string): string {
  const parts = p.split('/');
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

function buildStyle(): cytoscape.StylesheetJson {
  const fg = cssVar('--vscode-foreground', '#ccc');
  const bg = cssVar('--vscode-editor-background', '#1e1e1e');
  const edge = cssVar('--vscode-editorIndentGuide-activeBackground', '#888');
  const accent = cssVar('--vscode-focusBorder', '#007fd4');
  const accentFg = cssVar('--vscode-button-foreground', '#fff');
  const font = cssVar('--vscode-font-family', 'sans-serif');
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'background-color': bg,
        'border-width': 1.5,
        'border-color': (ele: cytoscape.NodeSingular) => cssVar(KIND_COLOR[ele.data('kind')] ?? '--vscode-foreground', fg),
        label: (ele: cytoscape.NodeSingular) => nodeLabel(ele.data() as GraphNode),
        color: fg,
        'font-family': font,
        'font-size': 11,
        'line-height': 1.25,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '260px',
        width: 'label',
        height: 'label',
        padding: '7px',
        'text-justification': 'left',
      } as cytoscape.Css.Node,
    },
    { selector: 'node[?center]', style: { 'background-color': accent, color: accentFg, 'border-color': accent, 'border-width': 2, 'font-weight': 'bold' } },
    { selector: 'node[?external]', style: { 'border-style': 'dashed', opacity: 0.7 } },
    { selector: 'node[kind = "group"]', style: { 'border-style': 'double', 'border-width': 3, 'font-style': 'italic' } },
    { selector: 'node.selected', style: { 'border-width': 3, 'border-color': accent } },
    {
      selector: 'edge',
      style: {
        width: (ele: cytoscape.EdgeSingular) => Math.min(4, 1 + Math.log2(ele.data('count') ?? 1)),
        'line-color': edge,
        'target-arrow-color': edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'curve-style': 'bezier',
        label: (ele: cytoscape.EdgeSingular) => ((ele.data('count') ?? 1) > 1 ? '×' + ele.data('count') : ''),
        'font-size': 9,
        color: fg,
        'text-background-color': bg,
        'text-background-opacity': 1,
        'text-background-padding': '1px',
        'text-rotation': 'autorotate',
      } as cytoscape.Css.Edge,
    },
    { selector: 'edge:loop', style: { 'loop-direction': '0deg', 'loop-sweep': '45deg' } },
  ];
}

const cy = cytoscape({ container: cyEl, style: buildStyle(), wheelSensitivity: 0.25, minZoom: 0.2, maxZoom: 3 });

let current: GraphData | undefined;
let currentFamily = 'symbol';
let viewMode: 'graph' | 'list' = 'graph';
let selectedId: string | undefined;

function render(graph: GraphData, title: string, family: string): void {
  current = graph;
  currentFamily = family;
  const [name, loc] = title.split('  ·  ');
  titleEl.innerHTML = `<b>${escapeHtml(name ?? '')}</b>${loc ? ' <span>' + escapeHtml(loc) + '</span>' : ''}`;
  titleEl.title = title;
  const isEmpty = graph.nodes.length <= 1 && graph.edges.length === 0;
  emptyEl.style.display = isEmpty ? 'block' : 'none';
  emptyEl.textContent = graph.nodes.length ? fmt('noRelations', graph.nodes[0].label) : fmt('nothingToShow');
  noteEl.textContent = graph.truncated ? fmt('truncated') : fmt('nodesEdges', graph.nodes.length, graph.edges.length);

  cy.startBatch();
  cy.elements().remove();
  cy.add(graph.nodes.map((n) => ({ group: 'nodes' as const, data: { ...n } })));
  cy.add(graph.edges.map((e, i) => ({ group: 'edges' as const, data: { id: 'e' + i, source: e.source, target: e.target, count: e.count, file: e.file, line: e.line } })));
  cy.endBatch();
  cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 12, rankSep: 60, edgeSep: 8, animate: false, fit: true, padding: 20 } as cytoscape.LayoutOptions).run();
  const MIN_READABLE_ZOOM = 0.7;
  if (cy.zoom() < MIN_READABLE_ZOOM) {
    cy.zoom(MIN_READABLE_ZOOM);
    const c = cy.nodes('[?center]');
    if (c.length) cy.center(c);
  }
  if (selectedId) cy.$id(selectedId).addClass('selected');
  renderList(graph);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Outline (list) form of the same graph
// ---------------------------------------------------------------------------

function renderList(graph: GraphData): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e);
    (inn.get(e.target) ?? inn.set(e.target, []).get(e.target)!).push(e);
  }
  const center = graph.nodes.find((n) => n.center);
  if (!center) {
    listEl.innerHTML = '';
    return;
  }
  const item = (n: GraphNode, edge: GraphEdge | undefined, dir: 'out' | 'in', seen: Set<string>): string => {
    const children = (dir === 'out' ? out.get(n.id) : inn.get(n.id)) ?? [];
    const kids = children
      .map((e) => ({ e, node: byId.get(dir === 'out' ? e.target : e.source) }))
      .filter((k): k is { e: GraphEdge; node: GraphNode } => !!k.node && !seen.has(k.node.id));
    const canExpand = n.expandable?.length ? n.expandable[0] : undefined;
    const tw = kids.length
      ? `<span class="tw codicon codicon-chevron-down" data-toggle="1"></span>`
      : canExpand
        ? `<span class="tw codicon codicon-add" data-expand="${n.id}" data-direction="${canExpand === 'group' ? '' : canExpand}" title="${fmt('expandMore')}"></span>`
        : `<span class="tw"></span>`;
    const cnt = edge?.count && edge.count > 1 ? `<span class="cnt">×${edge.count}</span>` : '';
    const file = n.fileLabel && n.kind !== 'group' ? `<span class="f">${escapeHtml(shortFile(n.fileLabel))}${n.line != null ? ':' + (n.line + 1) : ''}</span>` : '';
    const cls = `n${n.center ? ' center' : ''}${n.kind === 'group' ? ' grp' : ''}${n.id === selectedId ? ' selected' : ''}`;
    const sub = kids.length ? `<ul>${kids.map((k) => item(k.node, k.e, dir, new Set([...seen, n.id]))).join('')}</ul>` : '';
    return `<li>${tw}<span class="${cls}" data-id="${n.id}" data-path="${escapeHtml(n.file ?? '')}" data-line="${n.line ?? 0}"><i class="codicon codicon-${iconFor(n.kind)}"></i>${escapeHtml(n.label)}${cnt}${file}</span>${sub}</li>`;
  };
  const callees = (out.get(center.id) ?? []).map((e) => byId.get(e.target)).filter((n): n is GraphNode => !!n);
  const callers = (inn.get(center.id) ?? []).map((e) => byId.get(e.source)).filter((n): n is GraphNode => !!n);
  let html = `<ul><li><span class="n center" data-id="${center.id}" data-path="${escapeHtml(center.file ?? '')}" data-line="${center.line ?? 0}"><i class="codicon codicon-${iconFor(center.kind)}"></i>${escapeHtml(center.label)}</span></li></ul>`;
  if (callers.length) html += `<div class="grp">${fmt('listCallers')}</div><ul>${callers.map((n) => item(n, (inn.get(center.id) ?? []).find((e) => e.source === n.id), 'in', new Set([center.id]))).join('')}</ul>`;
  if (callees.length) html += `<div class="grp">${fmt('listCallees')}</div><ul>${callees.map((n) => item(n, (out.get(center.id) ?? []).find((e) => e.target === n.id), 'out', new Set([center.id]))).join('')}</ul>`;
  listEl.innerHTML = html;
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'function': case 'method': case 'prototype': return 'symbol-method';
    case 'macro': return 'symbol-constant';
    case 'struct': case 'union': return 'symbol-structure';
    case 'class': return 'symbol-class';
    case 'enum': return 'symbol-enum';
    case 'typedef': return 'symbol-interface';
    case 'variable': return 'symbol-variable';
    case 'field': return 'symbol-field';
    case 'file': return 'file-code';
    case 'group': return 'folder';
    default: return 'circle-outline';
  }
}

listEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const tw = target.closest('.tw') as HTMLElement | null;
  if (tw) {
    if (tw.dataset.expand) vscode.postMessage({ type: 'expand', id: tw.dataset.expand, direction: tw.dataset.direction || undefined });
    else if (tw.dataset.toggle) {
      const ul = tw.parentElement?.querySelector(':scope > ul') as HTMLElement | null;
      if (ul) {
        const hidden = ul.style.display === 'none';
        ul.style.display = hidden ? '' : 'none';
        tw.classList.toggle('codicon-chevron-down', hidden);
        tw.classList.toggle('codicon-chevron-right', !hidden);
      }
    }
    return;
  }
  const n = target.closest('.n') as HTMLElement | null;
  if (n) select(n.dataset.id!, n.dataset.path, Number(n.dataset.line));
});
listEl.addEventListener('dblclick', (e) => {
  const n = (e.target as HTMLElement).closest('.n') as HTMLElement | null;
  if (n?.dataset.path) vscode.postMessage({ type: 'open', path: n.dataset.path, line: Number(n.dataset.line), col: 0 });
});

function select(id: string, path?: string, line?: number): void {
  selectedId = id;
  cy.nodes().removeClass('selected');
  cy.$id(id).addClass('selected');
  listEl.querySelectorAll('.n.selected').forEach((el) => el.classList.remove('selected'));
  listEl.querySelector(`.n[data-id="${CSS.escape(id)}"]`)?.classList.add('selected');
  vscode.postMessage({ type: 'select', id, path, line });
}

// ---------------------------------------------------------------------------
// Graph interaction: click selects (Context view follows), click on the ⊕ handle expands,
// double click opens the file, right click re-centres.
// ---------------------------------------------------------------------------

let tapTimer: ReturnType<typeof setTimeout> | undefined;
cy.on('tap', 'node', (evt) => {
  const node = evt.target as cytoscape.NodeSingular;
  const d = node.data() as GraphNode;
  clearTimeout(tapTimer);
  const bb = node.renderedBoundingBox({ includeLabels: false });
  const rp = (evt as unknown as { renderedPosition: { x: number; y: number } }).renderedPosition;
  const onHandle = (d.expandable?.length || d.expandedDir) && rp.x > bb.x2 - 22 * cy.zoom() - 6;
  if (d.kind === 'group' || onHandle) {
    const direction = d.expandedDir ?? (d.expandable?.[0] === 'group' ? undefined : d.expandable?.[0]);
    tapTimer = setTimeout(() => vscode.postMessage({ type: 'expand', id: d.id, direction }), 200);
    return;
  }
  tapTimer = setTimeout(() => select(d.id, d.file, d.line), 200);
});
cy.on('dbltap', 'node', (evt) => {
  const d = evt.target.data() as GraphNode;
  clearTimeout(tapTimer);
  if (d.file != null) vscode.postMessage({ type: 'open', path: d.file, line: d.line ?? 0, col: 0 });
});
cy.on('cxttap', 'node', (evt) => {
  const d = evt.target.data() as GraphNode;
  if (!d.external && d.kind !== 'group') vscode.postMessage({ type: 'recenter', id: d.id });
});
cy.on('tap', 'edge', (evt) => {
  const d = evt.target.data() as GraphEdge;
  if (!d.file) return;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => vscode.postMessage({ type: 'preview', path: d.file, line: d.line ?? 0, col: 0 }), 200);
});
cy.on('dbltap', 'edge', (evt) => {
  const d = evt.target.data() as GraphEdge;
  clearTimeout(tapTimer);
  if (d.file) vscode.postMessage({ type: 'open', path: d.file, line: d.line ?? 0, col: 0 });
});
cy.on('mouseover', 'node', (evt) => {
  const d = evt.target.data() as GraphNode;
  cyEl.title = (d.qualname ?? d.label) + (d.file ? `\n${d.file}:${(d.line ?? 0) + 1}` : '') + (d.expandable?.length ? `\n${HANDLE} ${fmt('expandMore')}` : '');
});
cy.on('mouseout', 'node', () => (cyEl.title = ''));

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

let follow = true;
function sendOptions(): void {
  vscode.postMessage({ type: 'options', options: { mode: modeEl.value, depth: Number(depthEl.value), follow, view: viewMode } });
}
function applyView(): void {
  cyEl.style.display = viewMode === 'graph' ? '' : 'none';
  listEl.style.display = viewMode === 'list' ? 'block' : 'none';
  viewGraphBtn.classList.toggle('on', viewMode === 'graph');
  viewListBtn.classList.toggle('on', viewMode === 'list');
  if (viewMode === 'graph') cy.resize();
}
modeEl.addEventListener('change', sendOptions);
depthEl.addEventListener('change', sendOptions);
followBtn.addEventListener('click', () => {
  follow = !follow;
  followBtn.classList.toggle('on', follow);
  sendOptions();
});
viewGraphBtn.addEventListener('click', () => {
  viewMode = 'graph';
  applyView();
  sendOptions();
});
viewListBtn.addEventListener('click', () => {
  viewMode = 'list';
  applyView();
  sendOptions();
});
$('fit').addEventListener('click', () => cy.fit(undefined, 20));

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'graph') render(m.graph, m.title, m.family);
  else if (m.type === 'strings') strings = { ...strings, ...m.strings };
  else if (m.type === 'options') {
    modeEl.value = m.mode;
    depthEl.value = String(m.depth);
    follow = !!m.follow;
    followBtn.classList.toggle('on', follow);
    viewMode = m.view === 'list' ? 'list' : 'graph';
    applyView();
  }
});
window.addEventListener('resize', () => cy.resize());
new MutationObserver(() => cy.style(buildStyle() as never)).observe(document.body, { attributes: true, attributeFilter: ['class'] });

vscode.postMessage({ type: 'ready' });
void currentFamily;
