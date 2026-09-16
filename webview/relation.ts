import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

cytoscape.use(dagre);

interface GraphNode {
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
const followEl = $<HTMLInputElement>('follow');
const titleEl = $<HTMLSpanElement>('title');
const emptyEl = $<HTMLDivElement>('empty');
const noteEl = $<HTMLDivElement>('note');

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
  external: '--vscode-descriptionForeground',
  system: '--vscode-descriptionForeground',
};

function buildStyle(): cytoscape.StylesheetJson {
  const fg = cssVar('--vscode-foreground', '#ccc');
  const bg = cssVar('--vscode-editor-background', '#1e1e1e');
  const edge = cssVar('--vscode-editorIndentGuide-activeBackground', '#888');
  const accent = cssVar('--vscode-focusBorder', '#007fd4');
  const font = cssVar('--vscode-font-family', 'sans-serif');
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'background-color': bg,
        'border-width': 1.5,
        'border-color': (ele: cytoscape.NodeSingular) => cssVar(KIND_COLOR[ele.data('kind')] ?? '--vscode-foreground', fg),
        label: 'data(label)',
        color: fg,
        'font-family': font,
        'font-size': 11,
        'text-valign': 'center',
        'text-halign': 'center',
        width: 'label',
        height: 22,
        padding: '6px',
        'text-max-width': '220px',
        'text-wrap': 'ellipsis',
      } as cytoscape.Css.Node,
    },
    { selector: 'node[?center]', style: { 'border-width': 3, 'border-color': accent, 'font-weight': 'bold' } },
    { selector: 'node[?external]', style: { 'border-style': 'dashed', opacity: 0.7 } },
    {
      selector: 'edge',
      style: {
        width: 1.2,
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
      } as cytoscape.Css.Edge,
    },
    { selector: 'edge:loop', style: { 'loop-direction': '0deg', 'loop-sweep': '45deg' } },
    { selector: ':selected', style: { 'line-color': accent, 'target-arrow-color': accent, 'border-color': accent } },
  ];
}

const cy = cytoscape({
  container: $('cy'),
  style: buildStyle(),
  wheelSensitivity: 0.25,
  minZoom: 0.2,
  maxZoom: 3,
});

let currentFamily = 'symbol';
let strings: Record<string, string> = {
  noRelations: 'No relations found for {0}',
  nothingToShow: 'Nothing to show.',
  truncated: 'Graph truncated (siLite.maxGraphNodes)',
  nodesEdges: '{0} nodes, {1} edges',
};
const fmt = (key: string, ...args: Array<string | number>) =>
  (strings[key] ?? key).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));

function render(graph: GraphData, title: string, family: string): void {
  currentFamily = family;
  titleEl.textContent = title;
  titleEl.title = title;
  emptyEl.style.display = graph.nodes.length <= 1 && graph.edges.length === 0 ? 'block' : 'none';
  emptyEl.textContent = graph.nodes.length ? fmt('noRelations', graph.nodes[0].label) : fmt('nothingToShow');
  noteEl.textContent = graph.truncated ? fmt('truncated') : fmt('nodesEdges', graph.nodes.length, graph.edges.length);

  cy.startBatch();
  cy.elements().remove();
  cy.add(graph.nodes.map((n) => ({ group: 'nodes' as const, data: { ...n } })));
  cy.add(
    graph.edges.map((e, i) => ({
      group: 'edges' as const,
      data: { id: 'e' + i, source: e.source, target: e.target, count: e.count, file: e.file, line: e.line },
    })),
  );
  cy.endBatch();
  cy.layout({
    name: 'dagre',
    rankDir: 'LR',
    nodeSep: 14,
    rankSep: 70,
    edgeSep: 8,
    animate: false,
    fit: true,
    padding: 24,
  } as cytoscape.LayoutOptions).run();
  // Big fan-in/fan-out graphs fit only at unreadable zoom levels: keep labels legible and
  // start from the centre node instead; the user pans to the rest.
  const MIN_READABLE_ZOOM = 0.75;
  if (cy.zoom() < MIN_READABLE_ZOOM) {
    cy.zoom(MIN_READABLE_ZOOM);
    const c = cy.nodes('[?center]');
    if (c.length) cy.center(c);
  }
}

// Source Insight style: single click previews in the Context view, double click opens the file,
// right click makes the node the new centre.
let tapTimer: ReturnType<typeof setTimeout> | undefined;
cy.on('tap', 'node', (evt) => {
  const d = evt.target.data() as GraphNode;
  if (d.file == null) return;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => vscode.postMessage({ type: 'preview', path: d.file, line: d.line ?? 0, col: 0 }), 220);
});
cy.on('dbltap', 'node', (evt) => {
  const d = evt.target.data() as GraphNode;
  clearTimeout(tapTimer);
  if (d.file != null) vscode.postMessage({ type: 'open', path: d.file, line: d.line ?? 0, col: 0 });
});
cy.on('cxttap', 'node', (evt) => {
  const d = evt.target.data() as GraphNode;
  if (!d.external) vscode.postMessage({ type: 'recenter', id: d.id });
});
cy.on('tap', 'edge', (evt) => {
  const d = evt.target.data() as GraphEdge;
  if (!d.file) return;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => vscode.postMessage({ type: 'preview', path: d.file, line: d.line ?? 0, col: 0 }), 220);
});
cy.on('dbltap', 'edge', (evt) => {
  const d = evt.target.data() as GraphEdge;
  clearTimeout(tapTimer);
  if (d.file) vscode.postMessage({ type: 'open', path: d.file, line: d.line ?? 0, col: 0 });
});
cy.on('mouseover', 'node', (evt) => {
  const d = evt.target.data() as GraphNode;
  $('cy').title = (d.qualname ?? d.label) + (d.file ? `\n${d.file}:${(d.line ?? 0) + 1}` : '');
});
cy.on('mouseout', 'node', () => ($('cy').title = ''));

function sendOptions(): void {
  vscode.postMessage({
    type: 'options',
    options: { mode: modeEl.value, depth: Number(depthEl.value), follow: followEl.checked },
  });
}
modeEl.addEventListener('change', sendOptions);
depthEl.addEventListener('change', sendOptions);
followEl.addEventListener('change', sendOptions);
$('fit').addEventListener('click', () => cy.fit(undefined, 24));

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'graph') render(m.graph, m.title, m.family);
  else if (m.type === 'strings') strings = m.strings;
  else if (m.type === 'options') {
    modeEl.value = m.mode;
    depthEl.value = String(m.depth);
    followEl.checked = !!m.follow;
  }
});
window.addEventListener('resize', () => cy.resize());

// Re-read theme colours when VS Code swaps themes.
new MutationObserver(() => cy.style(buildStyle() as never)).observe(document.body, { attributes: true, attributeFilter: ['class'] });

vscode.postMessage({ type: 'ready' });
void currentFamily;
