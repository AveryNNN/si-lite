import * as path from 'node:path';
import * as vscode from 'vscode';
import { ParserService } from './core/parser';
import { Store } from './core/store';
import { Resolver } from './core/resolver';
import { DocTrees } from './docTree';
import { Indexer } from './indexer';
import { registerEditorFeatures } from './editorFeatures';
import { StickyHighlight } from './highlight';
import { SEMANTIC_LEGEND, SemanticProvider } from './semanticTokens';
import { SymbolService, registerProviders, showReferences } from './providers';
import { kindWord, setLocaleResolver, t } from './i18n';
import { KIND_ICON, config, isCFamily, openLocation, relPath, wordAt } from './util';
import { ContextViewProvider } from './views/contextView';
import { RelationViewProvider } from './views/relationView';
import { SymbolTreeProvider } from './views/symbolTree';

let lastTreeClick: { key: string; at: number } | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setLocaleResolver(() => {
    const pref = vscode.workspace.getConfiguration('siLite').get<string>('language', 'auto');
    if (pref === 'zh-cn' || pref === 'en') return pref;
    return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
  });
  const output = vscode.window.createOutputChannel('Source Insight Lite');
  context.subscriptions.push(output);

  const wasmDir = path.join(context.extensionPath, 'dist', 'wasm');
  const parser = new ParserService(wasmDir);
  await parser.init();

  const dbPath = context.storageUri ? path.join(context.storageUri.fsPath, 'project.sqlite') : undefined;
  const store = await Store.open(wasmDir, dbPath);
  context.subscriptions.push({ dispose: () => store.close() });
  output.appendLine(`db: ${dbPath ?? '(memory)'}  ${JSON.stringify(store.stats())}`);

  const indexer = new Indexer(parser, store, output, context.extensionPath, dbPath);
  context.subscriptions.push(indexer);

  const trees = new DocTrees(parser);
  const resolver = new Resolver(store);
  const service = new SymbolService(store, resolver, trees, parser);
  context.subscriptions.push(trees);

  const symbolTree = new SymbolTreeProvider(store);
  const contextView = new ContextViewProvider(store, service, context.extensionUri);
  const relationView = new RelationViewProvider(store, context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('siLite.symbols', symbolTree),
    vscode.window.registerWebviewViewProvider(ContextViewProvider.viewType, contextView),
    vscode.window.registerWebviewViewProvider(RelationViewProvider.viewType, relationView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    ...registerProviders(store, service),
    ...registerEditorFeatures(store, service, resolver, trees),
  );
  const sticky = new StickyHighlight(service, trees);
  context.subscriptions.push(
    sticky,
    vscode.commands.registerCommand('siLite.toggleHighlight', () => {
      const ed = vscode.window.activeTextEditor;
      if (ed && isCFamily(ed.document)) return sticky.toggle(ed);
    }),
    vscode.commands.registerCommand('siLite.clearHighlights', () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) sticky.clear(ed.document);
    }),
  );
  const semantic = new SemanticProvider(store, trees);
  if (config().semanticHighlighting) {
    context.subscriptions.push(
      vscode.languages.registerDocumentSemanticTokensProvider(
        [{ language: 'c', scheme: 'file' }, { language: 'cpp', scheme: 'file' }],
        semantic,
        SEMANTIC_LEGEND,
      ),
    );
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'siLite.searchSymbol';
  const updateStatus = () => {
    const s = store.stats();
    status.text = `$(database) SI ${s.symbols}`;
    status.tooltip = t('statusTooltip', s.files, s.symbols, s.refs);
    status.show();
  };
  updateStatus();
  context.subscriptions.push(status);

  context.subscriptions.push(
    relationView.onPreview((loc) => void contextView.showPreview(loc.path, loc.line, loc.col)),
    relationView.onSelect((id) => void contextView.showSymbol(id)),
    indexer.onDidChange(() => {
      semantic.invalidate();
      symbolTree.refresh();
      contextView.invalidate();
      relationView.invalidate();
      updateStatus();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isCFamily(e.textEditor.document)) return;
      contextView.onCursorMoved();
      relationView.onCursorMoved(e.textEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && isCFamily(editor.document)) {
        contextView.onCursorMoved();
        relationView.onCursorMoved(editor);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('siLite.buildProject', () => indexer.buildProject(false)),
    vscode.commands.registerCommand('siLite.rebuildProject', () => indexer.buildProject(true)),
    vscode.commands.registerCommand('siLite.syncFile', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) return indexer.indexFile(doc.uri, true);
    }),
    vscode.commands.registerCommand('siLite.refreshSymbols', () => symbolTree.refresh()),
    vscode.commands.registerCommand('siLite.openSymbol', (p: string, line: number, col: number, id?: number) => {
      // Tree items fire on every click: first click shows the symbol in the Context view, a second
      // click on the same item within 350ms opens the file (Source Insight's single/double click).
      const key = `${p}:${line}`;
      const now = Date.now();
      if (lastTreeClick && lastTreeClick.key === key && now - lastTreeClick.at < 350) {
        lastTreeClick = undefined;
        return openLocation(p, line, col);
      }
      lastTreeClick = { key, at: now };
      if (id != null) return contextView.showSymbol(id);
      return contextView.showPreview(p, line, col);
    }),
    vscode.commands.registerCommand('siLite.showRelations', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      void vscode.commands.executeCommand('siLite.relations.focus');
      relationView.showSymbolAtCursor(editor, true);
    }),
    vscode.commands.registerCommand('siLite.showIncludes', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      void vscode.commands.executeCommand('siLite.relations.focus');
      relationView.showIncludesFor(editor.document);
    }),
    vscode.commands.registerCommand('siLite.searchSymbol', () => searchSymbol(store, relationView)),
    vscode.commands.registerCommand('siLite.searchProject', () => searchProject(store)),
    vscode.commands.registerCommand('siLite.previewLocation', (p: string, line: number, col: number) => contextView.showPreview(p, line, col)),
    vscode.commands.registerCommand('siLite.addToProject', async (uri?: vscode.Uri) => {
      const target = uri ?? (await pickPath(t('pickAddTitle')));
      if (target) await indexer.addToProject(target);
    }),
    vscode.commands.registerCommand('siLite.removeFromProject', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) await indexer.removeFromProject(target);
    }),
    vscode.commands.registerCommand('siLite.findReferences', () => showReferences(service, false)),
    vscode.commands.registerCommand('siLite.findReferencesInFile', () => showReferences(service, true)),
  );

  const st = store.stats();
  if (st.files === 0 && vscode.workspace.workspaceFolders?.length) {
    if (config().autoBuildOnOpen) void indexer.buildProject(false);
    else {
      void vscode.window
        .showInformationMessage(t('noDatabase'), t('buildNow'))
        .then((choice) => {
          if (choice) void indexer.buildProject(false);
        });
    }
  } else if (st.files > 0) {
    // Source Insight synchronizes on open; the incremental pass is cheap (mtime/size compare in a worker).
    void indexer.buildProject(false, true);
  }
}

export function deactivate(): void {
  // Store is closed via context.subscriptions.
}

async function pickPath(title: string): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: false, title });
  return picked?.[0];
}

/** Functions that use all of the given symbols, e.g. "av_log avctx" -> every function mentioning both. */
async function searchProject(store: Store): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const seed = editor && isCFamily(editor.document) ? wordAt(editor.document, editor.selection.active) : undefined;
  const input = await vscode.window.showInputBox({ prompt: t('searchProjectPrompt'), value: seed ?? '', placeHolder: 'sym1 sym2 ...' });
  if (!input) return;
  const names = input.split(/[\s,]+/).filter(Boolean);
  const rows = store.functionsUsingAll(names, 300);
  if (!rows.length) {
    void vscode.window.showInformationMessage(t('searchProjectNone', names.join(' ')));
    return;
  }
  type Item = vscode.QuickPickItem & { path: string; line: number; col: number };
  const pick = await vscode.window.showQuickPick<Item>(
    rows.map((r) => ({
      label: `$(${KIND_ICON[r.symbol.kind]}) ${r.symbol.qualname}`,
      description: t('searchProjectHits', r.hits),
      detail: `${relPath(r.symbol.path)}:${r.symbol.line + 1}   ${r.symbol.signature}`,
      path: r.symbol.path,
      line: r.symbol.line,
      col: r.symbol.col,
    })),
    { matchOnDescription: true, matchOnDetail: true, placeHolder: t('searchProjectResults', rows.length, names.join(' ')) },
  );
  if (pick) void openLocation(pick.path, pick.line, pick.col);
}

async function searchSymbol(store: Store, relationView: RelationViewProvider): Promise<void> {
  type Item = vscode.QuickPickItem & { path: string; line: number; col: number; id: number };
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = t('searchPlaceholder');
  qp.matchOnDescription = true;
  const seed = (() => {
    const editor = vscode.window.activeTextEditor;
    return editor && isCFamily(editor.document) ? wordAt(editor.document, editor.selection.active) : undefined;
  })();
  const fill = (q: string) => {
    qp.items = store.searchSymbols(q, 200).map((s) => ({
      label: `$(${KIND_ICON[s.kind]}) ${s.name}`,
      description: s.qualname !== s.name ? s.qualname : undefined,
      detail: `${kindWord(s.kind)}  ${relPath(s.path)}:${s.line + 1}   ${s.signature}`,
      path: s.path,
      line: s.line,
      col: s.col,
      id: s.id,
    }));
  };
  qp.onDidChangeValue(fill);
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    if (it) {
      void openLocation(it.path, it.line, it.col);
      const sym = store.getSymbol(it.id);
      if (sym) relationView.showSymbol(sym);
    }
    qp.hide();
  });
  qp.onDidHide(() => qp.dispose());
  if (seed) {
    qp.value = seed;
    fill(seed);
  }
  qp.show();
}
