import * as vscode from 'vscode';
import type { SymbolKind } from '../core/languages';
import type { Store, SymbolRow } from '../core/store';
import { kindLabel, t } from '../i18n';
import { KIND_ICON, relPath } from '../util';

type Node = { type: 'kind'; kind: SymbolKind; count: number } | { type: 'symbol'; sym: SymbolRow } | { type: 'more'; kind: SymbolKind };

const KIND_ORDER: SymbolKind[] = [
  'function', 'method', 'class', 'struct', 'union', 'enum', 'typedef', 'macro', 'variable', 'namespace', 'enumerator', 'field', 'prototype',
];
const PAGE = 2000;

export class SymbolTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: Store) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.type === 'kind') {
      const item = new vscode.TreeItem(kindLabel(n.kind), vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(n.count);
      item.iconPath = new vscode.ThemeIcon(KIND_ICON[n.kind]);
      item.contextValue = 'kind';
      return item;
    }
    if (n.type === 'more') {
      const item = new vscode.TreeItem(t('moreSymbols', PAGE));
      item.command = { command: 'siLite.searchSymbol', title: t('search') };
      return item;
    }
    const s = n.sym;
    const item = new vscode.TreeItem(s.name);
    item.description = `${s.qualname !== s.name ? s.qualname + '  ' : ''}${relPath(s.path)}:${s.line + 1}`;
    item.tooltip = new vscode.MarkdownString().appendCodeblock(s.signature, 'cpp');
    item.iconPath = new vscode.ThemeIcon(KIND_ICON[s.kind]);
    item.command = { command: 'siLite.openSymbol', title: t('open'), arguments: [s.path, s.line, s.col] };
    item.contextValue = 'symbol';
    return item;
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      const counts = new Map(this.store.kindCounts().map((k) => [k.kind, k.count]));
      return KIND_ORDER.filter((k) => counts.has(k)).map((k) => ({ type: 'kind', kind: k, count: counts.get(k)! }));
    }
    if (n.type === 'kind') {
      const rows = this.store.symbolsByKind(n.kind, PAGE + 1);
      const out: Node[] = rows.slice(0, PAGE).map((sym) => ({ type: 'symbol', sym }));
      if (rows.length > PAGE) out.push({ type: 'more', kind: n.kind });
      return out;
    }
    return [];
  }
}
