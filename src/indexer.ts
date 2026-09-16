import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { ExtractOptions } from './core/extractor';
import { indexText } from './core/indexText';
import { langForPath, type Lang } from './core/languages';
import type { ParserService } from './core/parser';
import type { Store } from './core/store';
import type { StartMessage, WorkerFile } from './core/worker';
import { t } from './i18n';
import { config, debounce, fileEncoding, fsPathOf, makeDecoder } from './util';


const EXTERNAL_MAX_FILES = 50000;

/** Walk an external directory for C/C++ sources (no watcher: these trees rarely change). */
function externalFiles(dir: string, headerLang: Lang): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  const walk = (d: string) => {
    if (out.length >= EXTERNAL_MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(p);
      } else if (e.isFile() && langForPath(p, headerLang)) out.push(vscode.Uri.file(p));
    }
  };
  walk(dir);
  return out;
}

export class Indexer implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private building = false;
  private pendingWhileBuilding = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private readonly scheduleSave = debounce(() => this.save(), 3000);

  constructor(
    private readonly parser: ParserService,
    private readonly store: Store,
    private readonly output: vscode.OutputChannel,
    private readonly extensionPath: string,
    private readonly dbPath: string | undefined,
  ) {
    this.createWatcher();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('siLite.include')) this.createWatcher();
      }),
    );
  }

  private watcherDisposables: vscode.Disposable[] = [];

  private createWatcher(): void {
    for (const d of this.watcherDisposables) d.dispose();
    const watcher = vscode.workspace.createFileSystemWatcher(config().include);
    // The watcher also sees editor saves, so no separate onDidSaveTextDocument hook is needed;
    // indexFile() skips files whose mtime/size are unchanged, which de-duplicates paired events.
    this.watcherDisposables = [
      watcher,
      watcher.onDidDelete((uri) => this.removeFile(uri)),
      watcher.onDidCreate((uri) => void this.indexFile(uri)),
      watcher.onDidChange((uri) => void this.indexFile(uri)),
    ];
  }

  get isBuilding(): boolean {
    return this.building;
  }

  /** Scan the workspace and (re)index files whose mtime/size changed, in a worker thread. */
  async buildProject(force: boolean, silent = false): Promise<void> {
    if (this.building) {
      vscode.window.showInformationMessage(t('buildRunning'));
      return;
    }
    this.building = true;
    const cfg = config();
    const started = Date.now();
    try {
      await vscode.window.withProgress(
        { location: silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: t('buildTitle'), cancellable: !silent },
        async (progress, token) => {
          progress.report({ message: t('scanning') });
          if (force) this.store.clear();
          const uris = await vscode.workspace.findFiles(cfg.include, cfg.exclude);
          // Source Insight's "external libraries": SDK / HAL / toolchain trees outside the workspace.
          for (const dir of cfg.externalPaths) {
            const extra = externalFiles(dir, cfg.headerLanguage);
            this.output.appendLine(`[build] external ${dir}: ${extra.length} files`);
            uris.push(...extra);
          }
          // Files and folders the user removed from the project explicitly.
          const excluded = cfg.excludePaths.map((p) => fsPathOf(vscode.Uri.file(p)).toLowerCase());
          const isExcluded = (p: string) => {
            const lp = p.toLowerCase();
            return excluded.some((x) => lp === x || lp.startsWith(x + '/'));
          };
          if (excluded.length) {
            const before = uris.length;
            const kept = uris.filter((u) => !isExcluded(fsPathOf(u)));
            uris.length = 0;
            uris.push(...kept);
            this.output.appendLine(`[build] excluded by siLite.excludePaths: ${before - uris.length} files`);
          }

          // Drop rows for files that disappeared, then decide what needs (re)parsing.
          const present = new Set(uris.map(fsPathOf));
          for (const f of this.store.allFiles()) if (!present.has(f.path)) this.store.removeFile(f.path);

          const work: WorkerFile[] = [];
          let unchanged = 0;
          const tScan = Date.now();
          const known = new Map(force ? [] : this.store.allFiles().map((f) => [f.path, f]));
          for (const uri of uris) {
            const p = fsPathOf(uri);
            const lang = langForPath(p, cfg.headerLanguage);
            if (!lang) continue;
            // Direct fs.statSync: one RPC per file through workspace.fs costs seconds on big trees.
            let mtime: number;
            let size: number;
            try {
              const st = fs.statSync(uri.fsPath);
              mtime = Math.floor(st.mtimeMs);
              size = st.size;
            } catch {
              continue;
            }
            const k = known.get(p);
            if (k && k.mtime === mtime && k.size === size) {
              unchanged++;
              continue;
            }
            work.push({ path: p, lang, mtime, size });
          }
          this.output.appendLine(
            `[build] ${uris.length} files, ${work.length} to index, ${unchanged} unchanged (force=${force}, scan ${Date.now() - tScan}ms)`,
          );
          if (!work.length) {
            this.save();
            return;
          }

          if (this.dbPath) {
            // Worker loads the on-disk database, so flush ours first.
            this.store.save();
            const result = await this.runWorker(work, cfg, progress, token);
            this.store.reloadFromDisk();
            this.output.appendLine(
              `[build] indexed=${result.indexed}${result.cancelled ? ' (cancelled)' : ''} ${JSON.stringify(result.stats)} in ${Date.now() - started}ms (worker ${result.timing})`,
            );
            console.log(`[siLite build] worker ${result.timing}, total ${Date.now() - started}ms`);
          } else {
            await this.indexInline(work, cfg, progress, token);
            this.output.appendLine(`[build] ${JSON.stringify(this.store.stats())} in ${Date.now() - started}ms`);
          }
        },
      );
    } finally {
      this.building = false;
    }
    this._onDidChange.fire();
    // Files that changed while the worker ran.
    const pending = [...this.pendingWhileBuilding];
    this.pendingWhileBuilding.clear();
    for (const p of pending) await this.indexFile(vscode.Uri.file(p));
  }

  private runWorker(
    files: WorkerFile[],
    cfg: { indexReferences: boolean; ignoreMacros: string[]; parallelism: number },
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<{ indexed: number; cancelled: boolean; stats: unknown; timing: string }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(this.extensionPath, 'dist', 'worker.js'));
      const cancel = token.onCancellationRequested(() => worker.postMessage({ type: 'cancel' }));
      let lastDone = 0;
      const total = files.length;
      worker.on('message', (m: { type: string; [k: string]: unknown }) => {
        switch (m.type) {
          case 'progress': {
            const done = m.done as number;
            progress.report({ message: t('progressFiles', done, total), increment: ((done - lastDone) / total) * 100 });
            lastDone = done;
            break;
          }
          case 'fileError':
            this.output.appendLine(`[error] ${m.path}: ${m.message}`);
            break;
          case 'done':
            cancel.dispose();
            void worker.terminate();
            resolve({ indexed: m.indexed as number, cancelled: m.cancelled as boolean, stats: m.stats, timing: String(m.timing) });
            break;
          case 'error':
            cancel.dispose();
            void worker.terminate();
            reject(new Error(String(m.message)));
            break;
        }
      });
      worker.on('error', (e) => {
        cancel.dispose();
        reject(e);
      });
      const msg: StartMessage = {
        type: 'start',
        wasmDir: path.join(this.extensionPath, 'dist', 'wasm'),
        dbPath: this.dbPath!,
        files,
        indexReferences: cfg.indexReferences,
        ignoreMacros: cfg.ignoreMacros,
        encoding: fileEncoding(),
        parallelism: cfg.parallelism,
      };
      worker.postMessage(msg);
    });
  }

  /** Fallback when there is no workspace storage (no worker hand-off possible). */
  private async indexInline(
    files: WorkerFile[],
    cfg: { indexReferences: boolean; ignoreMacros: string[] },
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let done = 0;
    for (const f of files) {
      if (token.isCancellationRequested) break;
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(f.path));
        await indexText(this.parser, this.store, f.path, f.lang, makeDecoder().decode(bytes), f.mtime, f.size, {
          indexReferences: cfg.indexReferences,
          ignoreMacros: cfg.ignoreMacros,
        });
      } catch (e) {
        this.output.appendLine(`[error] ${f.path}: ${(e as Error).message}`);
      }
      done++;
      if (done % 10 === 0 || done === files.length) {
        progress.report({ message: t('progressFiles', done, files.length), increment: (10 / files.length) * 100 });
        await new Promise<void>((r) => setImmediate(r));
      }
    }
  }

  /** Is this path outside the project by explicit removal? */
  private isExcludedPath(p: string): boolean {
    const lp = p.toLowerCase();
    return config().excludePaths.some((x) => {
      const lx = fsPathOf(vscode.Uri.file(x)).toLowerCase();
      return lp === lx || lp.startsWith(lx + '/');
    });
  }

  async indexFile(uri: vscode.Uri, force = false): Promise<void> {
    if (uri.scheme !== 'file') return;
    const p = fsPathOf(uri);
    if (this.isExcludedPath(p)) return;
    if (this.building) {
      this.pendingWhileBuilding.add(p);
      return;
    }
    const cfg = config();
    try {
      const r = await this.indexUri(uri, force, cfg.headerLanguage, { indexReferences: cfg.indexReferences, ignoreMacros: cfg.ignoreMacros });
      if (r === 'indexed') {
        this._onDidChange.fire();
        this.scheduleSave();
      }
    } catch (e) {
      this.output.appendLine(`[error] ${uri.fsPath}: ${(e as Error).message}`);
    }
  }

  removeFile(uri: vscode.Uri): void {
    if (this.building) return; // the build's stale-file sweep or a later sync handles it
    this.store.removeFile(fsPathOf(uri));
    this._onDidChange.fire();
    this.scheduleSave();
  }

  /** "Add to project": a folder or file, inside or outside the workspace. */
  async addToProject(uri: vscode.Uri): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('siLite');
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const p = uri.fsPath;
    const excluded = (cfg.get<string[]>('excludePaths') ?? []).filter((x) => x.toLowerCase() !== p.toLowerCase());
    await cfg.update('excludePaths', excluded.length ? excluded : undefined, target);
    const inWorkspace = !!vscode.workspace.getWorkspaceFolder(uri);
    if (!inWorkspace) {
      const ext = cfg.get<string[]>('externalPaths') ?? [];
      const dir = fs.statSync(p).isDirectory() ? p : path.dirname(p);
      if (!ext.some((x) => x.toLowerCase() === dir.toLowerCase())) await cfg.update('externalPaths', [...ext, dir], target);
    }
    await this.buildProject(false, true);
  }

  /** "Remove from project": stop indexing a folder or file and drop its symbols. */
  async removeFromProject(uri: vscode.Uri): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('siLite');
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const p = uri.fsPath;
    const ext = cfg.get<string[]>('externalPaths') ?? [];
    if (ext.some((x) => x.toLowerCase() === p.toLowerCase())) {
      await cfg.update('externalPaths', ext.filter((x) => x.toLowerCase() !== p.toLowerCase()), target);
    } else {
      const excluded = cfg.get<string[]>('excludePaths') ?? [];
      if (!excluded.some((x) => x.toLowerCase() === p.toLowerCase())) await cfg.update('excludePaths', [...excluded, p], target);
    }
    const prefix = fsPathOf(uri).toLowerCase();
    for (const f of this.store.allFiles()) {
      const lp = f.path.toLowerCase();
      if (lp === prefix || lp.startsWith(prefix + '/')) this.store.removeFile(f.path);
    }
    this.save();
    this._onDidChange.fire();
  }

  private async indexUri(uri: vscode.Uri, force: boolean, headerLang: Lang, opts: ExtractOptions): Promise<'indexed' | 'skipped'> {
    const p = fsPathOf(uri);
    const lang = langForPath(p, headerLang);
    if (!lang) return 'skipped';
    const st = fs.statSync(uri.fsPath);
    const mtime = Math.floor(st.mtimeMs);
    if (!force) {
      const known = this.store.getFile(p);
      if (known && known.mtime === mtime && known.size === st.size) return 'skipped';
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    await indexText(this.parser, this.store, p, lang, makeDecoder().decode(bytes), mtime, st.size, opts);
    return 'indexed';
  }

  save(): void {
    if (!this.store.isDirty) return;
    try {
      this.store.save();
    } catch (e) {
      this.output.appendLine(`[save] failed: ${(e as Error).message}`);
    }
  }

  dispose(): void {
    for (const d of this.watcherDisposables) d.dispose();
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}
