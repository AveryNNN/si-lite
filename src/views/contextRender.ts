// vscode-free rendering for the Context view so it can be unit-tested and previewed headless.
import { baseTypeName, typeFromDeclaration, type Resolution } from '../core/resolver';
import type { Store, SymbolRow } from '../core/store';
import { kindWord, t } from '../i18n';
import { escapeHtml } from '../util-core';

const MAX_BODY_LINES = 12;
const MAX_COMMENT_LINES = 6;
const FILES_EXPANDED = 3; // file groups pre-filled with rows
const FILES_LISTED = 60; // file groups shown; the rest is summarised
const ROWS_PER_FILE = 200;
const MEMBER_LIMIT = 300;
/** Files parsed up front to drop same-named locals / other members; the rest stays name-based. */
const FILTER_MAX_FILES = 250;
const PREVIEW_CONTEXT = 6;

interface Snippet {
  startLine: number;
  lines: string[];
  truncated: boolean;
}

export type RefPos = { line: number; col: number };
/** Drops occurrences that are not really this symbol (shadowing locals, other types' members). */
export type OccurrenceFilter = (path: string, refs: RefPos[]) => Promise<RefPos[]>;

export class ContextRenderer {
  /** Set by the host for the symbol currently shown; used when file groups are expanded lazily. */
  filter?: OccurrenceFilter;

  constructor(
    private readonly store: Store,
    private readonly readLines: (path: string) => Promise<string[] | undefined>,
    private readonly relPath: (path: string) => string,
  ) {}

  // ---- rendering -----------------------------------------------------------

  /** Render from a scope-aware resolution (preferred) or fall back to plain name lookup. */
  async renderResolution(res: Resolution | undefined, word: string, filePath: string): Promise<string> {
    if (!res) return this.render(word, []);
    switch (res.kind) {
      case 'local':
        return (await this.renderLocal(res, filePath)) + (await this.typeSection(baseTypeName(res.typeText), res.name));
      case 'member': {
        const files = this.store.referenceFiles(res.name);
        const parts = [await this.definitionSection(res.symbol, [], t('memberOf', res.ownerType))];
        parts.push(await this.typeSection(typeFromDeclaration(res.symbol.signature, res.name), res.name));
        parts.push(await this.usesSection(res.name, files, t('nameMatchNote')));
        return parts.join('');
      }
      case 'symbols': {
        const primary = res.symbols[0];
        let extra = '';
        if (primary && (primary.kind === 'variable' || primary.kind === 'field')) {
          extra = await this.typeSection(typeFromDeclaration(primary.signature, primary.name), primary.name);
        }
        return (await this.render(word, res.symbols)) + extra;
      }
    }
  }

  /** Source Insight decodes a variable's declaration down to its struct/class: show that type here. */
  private async typeSection(typeName: string | undefined, varName: string): Promise<string> {
    if (!typeName || typeName === varName) return '';
    const def = this.store.findDefinitions(typeName).find((s) => s.kind === 'struct' || s.kind === 'class' || s.kind === 'union' || s.kind === 'typedef' || s.kind === 'enum');
    if (!def) return '';
    const header = await this.definitionSection(def, [], t('typeOf', varName), t('typeBlock'));
    const members = this.membersSection(def);
    return `<div class="type-section">${header.replace('data-block="def"', 'data-block="type"')}${members.replace('data-block="members"', 'data-block="typeMembers"')}</div>`;
  }

  private async renderLocal(res: Extract<Resolution, { kind: 'local' }>, filePath: string): Promise<string> {
    const lines = await this.readLines(filePath);
    const header = `<div class="hdr" data-path="${escapeHtml(filePath)}" data-line="${res.decl.start.line}" data-col="${res.decl.start.col}">
        <span class="kind">${t(res.isParam ? 'kindParam' : 'kindLocal')}</span>
        <span class="name">${escapeHtml(res.typeText)} ${escapeHtml(res.name)}</span>
        <span class="loc">${escapeHtml(this.relPath(filePath))}:${res.decl.start.line + 1}</span></div>`;
    const rows = res.refs.map((r) => {
      const text = lines?.[r.start.line] ?? '';
      const trimmed = text.trimStart();
      const col = Math.max(0, r.start.col - (text.length - trimmed.length));
      const isDecl = r.start.line === res.decl.start.line && r.start.col === res.decl.start.col;
      const code = trimmed.slice(col, col + res.name.length) === res.name
        ? `${escapeHtml(trimmed.slice(0, col))}<mark>${escapeHtml(res.name)}</mark>${escapeHtml(trimmed.slice(col + res.name.length))}`
        : escapeHtml(trimmed);
      return `<div class="row${isDecl ? ' decl' : ''}" data-path="${escapeHtml(filePath)}" data-line="${r.start.line}" data-col="${r.start.col}"><span class="ln">${r.start.line + 1}</span><code>${code}</code></div>`;
    });
    const scopeLabel = res.scopeName ? t('localUses', res.scopeName) : t('usesInProject');
    return `<section><div class="title">${t('definition')}</div>${header}</section>
      <section><div class="title">${escapeHtml(scopeLabel)} <span class="dim">${res.refs.length}</span></div><div class="rows local">${rows.join('')}</div></section>`;
  }

  async render(word: string, syms: SymbolRow[]): Promise<string> {
    const files = this.store.referenceFiles(word);
    if (!syms.length && !files.length) return `<div class="empty">${t('noSymbolNamed', escapeHtml(word))}</div>`;
    const parts: string[] = [];
    const primary = syms[0];
    if (primary) {
      parts.push(await this.definitionSection(primary, syms.slice(1)));
      const membersHtml = this.membersSection(primary);
      if (membersHtml) parts.push(membersHtml);
    }
    parts.push(await this.usesSection(word, files));
    return parts.join('');
  }

  private async definitionSection(s: SymbolRow, others: SymbolRow[], note?: string, title = t('definition')): Promise<string> {
    const snip = await this.snippet(s);
    const header = `<div class="hdr" data-path="${escapeHtml(s.path)}" data-line="${s.line}" data-col="${s.col}" title="${escapeHtml(s.path)}">
        <span class="kind">${kindWord(s.kind)}</span> <span class="name">${escapeHtml(s.qualname)}</span>${note ? ` <span class="dim">${escapeHtml(note)}</span>` : ''}
        <span class="loc">${escapeHtml(this.relPath(s.path))}:${s.line + 1}</span></div>`;
    let code = '';
    if (snip) {
      const rows = snip.lines.map((l, i) => {
        const n = snip.startLine + i;
        const cls = n === s.line ? ' class="def"' : '';
        return `<tr${cls} data-line="${n}"><td class="ln">${n + 1}</td><td class="src">${escapeHtml(l) || '&nbsp;'}</td></tr>`;
      });
      const moreRow = snip.truncated ? `<tr class="dim" data-line="${snip.startLine + snip.lines.length}"><td class="ln">…</td><td class="src">${t('moreLines', s.endLine - snip.startLine - snip.lines.length + 1)}</td></tr>` : '';
      code = `<table class="code" data-path="${escapeHtml(s.path)}">${rows.join('')}${moreRow}</table>`;
    }
    let alt = '';
    if (others.length) {
      const items = others.slice(0, 8).map(
        (o) => `<li data-path="${escapeHtml(o.path)}" data-line="${o.line}" data-col="${o.col}"><span class="kind">${kindWord(o.kind)}</span> ${escapeHtml(o.qualname)} <span class="dim">${escapeHtml(this.relPath(o.path))}:${o.line + 1}</span></li>`,
      );
      alt = `<details class="alt"><summary>${t('otherDefinitions', others.length)}</summary><ul class="list">${items.join('')}</ul></details>`;
    }
    return `<section class="def-section"><details class="block" data-block="def" open><summary class="title">${title}</summary>${header}${code}${alt}</details></section>`;
  }

  /** Occurrences already confirmed by the context filter, keyed by file id; consulted by fileRows(). */
  private confirmed = new Map<number, RefPos[]>();
  /** Occurrences the filter rejected (same-named locals, other types' members); shown last, collapsed. */
  private hidden = new Map<number, RefPos[]>();

  /**
   * Where the user is looking from. Results are ordered by closeness to it, the way Source Insight
   * users read a reference list: same function, then same file, same folder, then by directory distance.
   */
  origin?: { path: string; fnName?: string };

  private dirOf(p: string): string[] {
    const i = p.lastIndexOf('/');
    return (i < 0 ? '' : p.slice(0, i)).toLowerCase().split('/');
  }

  /** 0 = same file, 1 = same folder, 2+ = number of path segments that differ from the origin's folder. */
  private distance(path: string): number {
    if (!this.origin) return 0;
    if (path.toLowerCase() === this.origin.path.toLowerCase()) return 0;
    const a = this.dirOf(this.origin.path);
    const b = this.dirOf(path);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return 1 + (a.length - i) + (b.length - i);
  }

  private orderByCloseness<T extends { path: string; total: number }>(files: T[]): T[] {
    return [...files].sort((x, y) => this.distance(x.path) - this.distance(y.path) || y.total - x.total || x.path.localeCompare(y.path));
  }

  private async usesSection(name: string, files: Array<{ fileId: number; path: string; total: number; calls: number }>, note?: string): Promise<string> {
    this.confirmed = new Map();
    this.hidden = new Map();
    let unfiltered: typeof files = [];
    let hiddenFiles: typeof files = [];
    if (this.filter && files.length) {
      // Context-sensitive first: parse the closest / busiest files and keep only real occurrences.
      const ordered = this.orderByCloseness(files);
      const head = ordered.slice(0, FILTER_MAX_FILES);
      unfiltered = ordered.slice(FILTER_MAX_FILES);
      const kept: typeof files = [];
      for (const f of head) {
        const refs = this.store.referencesInFile(name, f.fileId, ROWS_PER_FILE + 1);
        const ok = await this.filter(f.path, refs);
        const okSet = new Set(ok.map((r) => `${r.line}:${r.col}`));
        const rejected = refs.filter((r) => !okSet.has(`${r.line}:${r.col}`));
        this.confirmed.set(f.fileId, ok);
        if (rejected.length) {
          this.hidden.set(f.fileId, rejected);
          hiddenFiles.push({ ...f, total: rejected.length, calls: rejected.filter((r) => r.kind === 'call').length });
        }
        if (!ok.length) continue;
        const calls = refs.filter((r) => r.kind === 'call' && okSet.has(`${r.line}:${r.col}`)).length;
        kept.push({ ...f, total: ok.length, calls });
      }
      files = kept;
    }
    files = this.orderByCloseness(files);
    hiddenFiles = this.orderByCloseness(hiddenFiles);
    const total = files.reduce((a, f) => a + f.total, 0);
    const calls = files.reduce((a, f) => a + f.calls, 0);
    const hiddenTotal = hiddenFiles.reduce((a, f) => a + f.total, 0);
    const droppedNote = hiddenTotal ? ` · ${t('droppedRows', hiddenTotal)}` : '';
    const title = `<summary class="title">${t('usesInProject')} <span class="dim">${t('usesSummary', files.length, total, calls)}${note ? ' · ' + escapeHtml(note) : ''}${droppedNote}</span></summary>`;
    if (!files.length && !unfiltered.length && !hiddenFiles.length) return `<section><details class="block" data-block="uses" open>${title}<div class="empty">${t('noUses')}</div></details></section>`;
    const groups = await this.fileGroups(name, files.slice(0, FILES_LISTED), FILES_EXPANDED, 'kept');
    const more = files.length > FILES_LISTED ? `<div class="dim more">${t('moreFiles', files.length - FILES_LISTED)}</div>` : '';
    let rest = '';
    if (unfiltered.length) {
      const restGroups = await this.fileGroups(name, unfiltered.slice(0, FILES_LISTED), 0, 'plain');
      rest += `<details class="block" data-block="unfiltered"><summary class="title">${t('unfilteredFiles', unfiltered.length)}</summary>${restGroups}${unfiltered.length > FILES_LISTED ? `<div class="dim more">${t('moreFiles', unfiltered.length - FILES_LISTED)}</div>` : ''}</details>`;
    }
    if (hiddenFiles.length) {
      const hiddenGroups = await this.fileGroups(name, hiddenFiles.slice(0, FILES_LISTED), 0, 'hidden');
      rest += `<details class="block" data-block="hidden"><summary class="title">${t('hiddenBlock', hiddenTotal, hiddenFiles.length)}</summary>${hiddenGroups}</details>`;
    }
    return `<section><details class="block" data-block="uses" open>${title}${groups}${more}</details>${rest}</section>`;
  }

  private async fileGroups(name: string, files: Array<{ fileId: number; path: string; total: number; calls: number }>, expanded: number, variant: 'kept' | 'plain' | 'hidden'): Promise<string> {
    const groups: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const open = i < expanded;
      const rows = open ? await this.fileRows(name, f.fileId, f.path, variant) : `<div class="loading">…</div>`;
      const badge = f.calls === 0 ? t('badgeRefs', f.total) : f.calls === f.total ? t('badgeCalls', f.total) : t('badgeMixed', f.total, f.calls);
      const d = this.distance(f.path);
      const where = d === 0 ? `<span class="where">${t('whereThisFile')}</span>` : d === 1 ? `<span class="where">${t('whereThisFolder')}</span>` : '';
      groups.push(
        `<details class="file"${open ? ' open' : ''} data-key="${variant}:${f.fileId}" data-name="${escapeHtml(name)}" data-file="${f.fileId}" data-path="${escapeHtml(f.path)}" data-variant="${variant}"${open ? ' data-loaded="1"' : ''}>
          <summary>${where}<span class="fname" title="${escapeHtml(f.path)}">${escapeHtml(this.relPath(f.path))}</span>
            <span class="badge">${badge}</span></summary>
          <div class="rows">${rows}</div></details>`,
      );
    }
    return groups.join('');
  }

  /** Code around a location for the preview pane (single click shows, double click opens). */
  async previewHtml(path: string, line: number, col: number, name?: string): Promise<string> {
    const lines = await this.readLines(path);
    if (!lines) return `<div class="empty">${escapeHtml(this.relPath(path))}</div>`;
    const from = Math.max(0, line - PREVIEW_CONTEXT);
    const to = Math.min(lines.length - 1, line + PREVIEW_CONTEXT);
    const rows: string[] = [];
    for (let n = from; n <= to; n++) {
      let code = escapeHtml(lines[n]);
      if (n === line && name && lines[n].slice(col, col + name.length) === name) {
        code = `${escapeHtml(lines[n].slice(0, col))}<mark>${escapeHtml(name)}</mark>${escapeHtml(lines[n].slice(col + name.length))}`;
      }
      rows.push(`<tr${n === line ? ' class="def"' : ''} data-line="${n}"><td class="ln">${n + 1}</td><td class="src">${code || '&nbsp;'}</td></tr>`);
    }
    return `<div class="phdr"><span class="fname" title="${escapeHtml(path)}">${escapeHtml(this.relPath(path))}:${line + 1}</span>
      <button class="popen" data-path="${escapeHtml(path)}" data-line="${line}" data-col="${col}">${t('openFile')}</button>
      <button class="pclose" title="${t('closePreview')}">✕</button></div>
      <table class="code" data-path="${escapeHtml(path)}">${rows.join('')}</table>`;
  }

  /**
   * Rows of one file group. `variant`: kept = confirmed occurrences (same function first when this is the
   * origin file), hidden = the rejected same-named ones, plain = unfiltered name matches.
   */
  async fileRows(name: string, fileId: number, path: string, variant: 'kept' | 'plain' | 'hidden' = 'kept'): Promise<string> {
    const all = this.store.referencesInFile(name, fileId, ROWS_PER_FILE + 1);
    let refs = all;
    if (variant === 'hidden') {
      const h = this.hidden.get(fileId);
      if (h) {
        const set = new Set(h.map((k) => `${k.line}:${k.col}`));
        refs = all.filter((r) => set.has(`${r.line}:${r.col}`));
      } else if (this.filter) {
        const ok = await this.filter(path, all);
        const okSet = new Set(ok.map((k) => `${k.line}:${k.col}`));
        refs = all.filter((r) => !okSet.has(`${r.line}:${r.col}`));
      }
    } else if (variant === 'kept' && this.filter) {
      const kept = this.confirmed.get(fileId) ?? (await this.filter(path, all));
      const keep = new Set(kept.map((k) => `${k.line}:${k.col}`));
      refs = all.filter((r) => keep.has(`${r.line}:${r.col}`));
    }
    // Same function as the cursor first, then the rest of the file in line order.
    const isOrigin = !!this.origin && path.toLowerCase() === this.origin.path.toLowerCase();
    const fnName = isOrigin ? this.origin?.fnName : undefined;
    if (fnName) refs = [...refs.filter((r) => r.from === fnName), ...refs.filter((r) => r.from !== fnName)];
    const lines = await this.readLines(path);
    const out: string[] = [];
    let lastHere: boolean | undefined;
    for (const r of refs.slice(0, ROWS_PER_FILE)) {
      const here = !!fnName && r.from === fnName;
      if (fnName && here !== lastHere) {
        out.push(`<div class="dim sub">${here ? t('sameFunction', fnName) : t('restOfFile')}</div>`);
        lastHere = here;
      }
      const text = lines?.[r.line] ?? '';
      const trimmed = text.trimStart();
      const lead = text.length - trimmed.length;
      const col = Math.max(0, r.col - lead);
      let codeHtml: string;
      if (trimmed.slice(col, col + name.length) === name) {
        codeHtml = `${escapeHtml(trimmed.slice(0, col))}<mark>${escapeHtml(name)}</mark>${escapeHtml(trimmed.slice(col + name.length))}`;
      } else codeHtml = escapeHtml(trimmed);
      const fn = r.from ? `<span class="fn" title="${escapeHtml(t('inFunction', r.from))}">${escapeHtml(r.from)}</span>` : '';
      out.push(
        `<div class="row${r.kind === 'call' ? ' call' : ''}${here ? ' here' : ''}" data-path="${escapeHtml(path)}" data-line="${r.line}" data-col="${r.col}">
          <span class="ln">${r.line + 1}</span>${fn}<code>${codeHtml}</code></div>`,
      );
    }
    if (refs.length > ROWS_PER_FILE) out.push(`<div class="dim more">${t('moreRows')}</div>`);
    return out.join('');
  }

  private membersSection(s: SymbolRow): string {
    if (s.kind !== 'struct' && s.kind !== 'class' && s.kind !== 'union' && s.kind !== 'typedef') return '';
    let members = this.store.membersOf(s.qualname);
    if (!members.length && s.kind === 'typedef') {
      // typedef struct point {...} point_t;  -> members live under "point"
      const m = /typedef\s+(?:struct|union|class)\s+([A-Za-z_]\w*)/.exec(s.signature);
      if (m) members = this.store.membersOf(m[1]);
    }
    if (!members.length) return '';
    const rows = members.slice(0, MEMBER_LIMIT).map((m) => {
      const files = this.store.referenceFiles(m.name);
      const total = files.reduce((a, f) => a + f.total, 0);
      const top = files
        .slice(0, 3)
        .map((f) => this.relPath(f.path).split('/').pop())
        .join(', ');
      return `<tr data-id="${m.id}" title="${escapeHtml(m.signature)}">
        <td class="mname"><span class="kind">${kindWord(m.kind)}</span> ${escapeHtml(m.name)}</td>
        <td class="num">${total}</td><td class="num">${files.length}</td>
        <td class="dim files">${escapeHtml(top)}${files.length > 3 ? ' …' : ''}</td></tr>`;
    });
    const more = members.length > MEMBER_LIMIT ? `<div class="dim more">${t('moreRows')}</div>` : '';
    return `<section><details class="block" data-block="members" open><summary class="title">${t('members', members.length)} <span class="dim">${t('membersHint')}</span></summary>
      <table class="members"><thead><tr><th></th><th class="num">${t('colRefs')}</th><th class="num">${t('colFiles')}</th><th>${t('colWhere')}</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>${more}</details></section>`;
  }


  private async snippet(s: SymbolRow): Promise<Snippet | undefined> {
    const lines = await this.readLines(s.path);
    if (!lines) return undefined;
    let start = s.line;
    let i = s.line - 1;
    let taken = 0;
    while (i >= 0 && taken < MAX_COMMENT_LINES) {
      const tl = lines[i].trim();
      if (tl === '' && taken === 0) break;
      const isComment = tl.startsWith('//') || tl.startsWith('/*') || tl.startsWith('*') || tl.endsWith('*/');
      if (!isComment) break;
      start = i;
      taken++;
      if (tl.startsWith('/*')) break;
      i--;
    }
    const end = Math.min(s.endLine, s.line + MAX_BODY_LINES, lines.length - 1);
    return { startLine: start, lines: lines.slice(start, end + 1), truncated: end < s.endLine };
  }

}

export function contextPageHtml(n: string, cspSource: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${n}';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 6px 8px; }
#bar { position: sticky; top: 0; background: var(--vscode-sideBar-background); padding: 4px 0; display: flex; gap: 8px; align-items: center; z-index: 1; }
#bar label { display: flex; gap: 4px; align-items: center; font-size: 11px; opacity: .85; cursor: pointer; }
.empty { opacity: .7; padding: 6px 2px; }
section { margin: 6px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); }
.title { font-size: 11px; letter-spacing: .02em; opacity: .75; margin: 2px 0 4px; }
.title .dim { letter-spacing: 0; }
.dim { opacity: .6; }
.hdr { cursor: pointer; padding: 3px 2px; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.hdr:hover, .list li:hover, .row:hover, .members tbody tr:hover, table.code tr:hover { background: var(--vscode-list-hoverBackground); }
.kind { font-size: 10px; padding: 0 4px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
.name { font-weight: 600; }
.loc { opacity: .7; font-size: 11px; margin-left: auto; }
table.code { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); margin-top: 2px; }
table.code tr { cursor: pointer; }
table.code tr.def { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.25)); }
td.ln, .row .ln { text-align: right; padding: 0 8px 0 2px; opacity: .5; user-select: none; white-space: nowrap; }
td.ln { width: 1%; }
td.src { white-space: pre; overflow: hidden; }
details.alt, details.file { margin: 3px 0; }
summary { cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
details.file summary { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
details.file summary::before, details.alt summary::before { content: '▸'; font-size: 10px; opacity: .6; width: 10px; display: inline-block; }
details[open] summary::before { content: '▾'; }
.fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { margin-left: auto; font-size: 11px; opacity: .8; white-space: nowrap; }
.rows { margin: 1px 0 4px 12px; }
.row { display: flex; gap: 6px; align-items: baseline; cursor: pointer; padding: 1px 2px; font-family: var(--vscode-editor-font-family); font-size: calc(var(--vscode-editor-font-size) - 1px); white-space: nowrap; overflow: hidden; }
.row .ln { min-width: 3em; }
.row .fn { font-family: var(--vscode-font-family); font-size: 10px; opacity: .65; max-width: 38%; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; }
.row code { overflow: hidden; text-overflow: ellipsis; }
.row.call .ln { border-left: 2px solid var(--vscode-symbolIcon-functionForeground, #b180d7); }
mark { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.35)); color: inherit; }
.list { list-style: none; margin: 2px 0 0; padding-left: 12px; }
.list li { cursor: pointer; padding: 1px 2px; }
.members { border-collapse: collapse; width: 100%; margin-top: 2px; }
.members th { text-align: left; font-weight: normal; font-size: 10px; opacity: .65; padding: 0 6px 2px 2px; }
.members td { padding: 1px 6px 1px 2px; white-space: nowrap; }
.members tbody tr { cursor: pointer; }
.members .num { text-align: right; }
.members .files { overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.more { padding: 2px 2px; font-size: 11px; }
details.block > summary.title { cursor: pointer; }
details.block > summary.title::before { content: '▾'; margin-right: 4px; opacity: .6; }
details.block:not([open]) > summary.title::before { content: '▸'; }
.row.decl .ln { border-left: 2px solid var(--vscode-focusBorder, #007fd4); }
#bar button { background: none; border: none; color: inherit; opacity: .7; cursor: pointer; font-size: 11px; padding: 0 4px; }
#bar button:hover { opacity: 1; }
#preview { position: sticky; bottom: 0; background: var(--vscode-sideBar-background); border-top: 2px solid var(--vscode-focusBorder, #007fd4); max-height: 45vh; overflow: auto; margin: 0 -6px; padding: 0 6px 4px; }
#preview[hidden] { display: none; }
.phdr { display: flex; gap: 6px; align-items: center; padding: 3px 0; font-size: 11px; }
.phdr .fname { flex: 1; }
.phdr button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; padding: 1px 6px; cursor: pointer; font-size: 11px; }
.hint { font-size: 10px; opacity: .55; margin-left: auto; }
.where { font-size: 9px; padding: 0 3px; border-radius: 2px; border: 1px solid var(--vscode-focusBorder, #007fd4); opacity: .8; white-space: nowrap; }
.sub { font-size: 10px; padding: 2px 2px 0; }
.row.here .ln { border-left: 2px solid var(--vscode-focusBorder, #007fd4); }
details[data-block="hidden"] { opacity: .75; }
</style></head><body>
<div id="bar"><label><input type="checkbox" id="lock"> ${t('lock')}</label>
  <button id="expandAll">${t('expandAll')}</button><button id="collapseAll">${t('collapseAll')}</button><span class="hint">${t('clickHint')}</span></div>
<div id="root"><div class="empty">${t('placeCursor')}</div></div>
<div id="preview" hidden></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const lock = document.getElementById('lock');
lock.addEventListener('change', () => vscode.postMessage({ type: 'lock', value: lock.checked }));
  // Fold state is remembered per symbol: which blocks and which file groups are open.
const state = vscode.getState() || { folds: {} };
let currentKey = '';
const foldsFor = (key) => (state.folds[key] = state.folds[key] || { blocks: {}, files: {}, touched: false });
const save = () => { const keys = Object.keys(state.folds); if (keys.length > 200) delete state.folds[keys[0]]; vscode.setState(state); };
const requestRows = (d) => vscode.postMessage({ type: 'expand', key: d.dataset.key, name: d.dataset.name, fileId: +d.dataset.file, path: d.dataset.path, variant: d.dataset.variant });
const applyFolds = () => {
  const f = foldsFor(currentKey);
  root.querySelectorAll('details.block').forEach((d) => { if (d.dataset.block in f.blocks) d.open = f.blocks[d.dataset.block]; });
  root.querySelectorAll('details.file').forEach((d) => {
    if (d.dataset.key in f.files) d.open = f.files[d.dataset.key];
    if (d.open && !d.dataset.loaded) requestRows(d);
  });
};
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'set') { currentKey = m.key || ''; root.innerHTML = m.html; applyFolds(); window.scrollTo(0, 0); }
  else if (m.type === 'preview') { preview.innerHTML = m.html; preview.hidden = false; }
  else if (m.type === 'busy') { root.innerHTML = '<div class="empty">' + m.html + '</div>'; }
  else if (m.type === 'rows') {
    const d = root.querySelector('details.file[data-key="' + m.key + '"]');
    if (d) { d.querySelector('.rows').innerHTML = m.html; d.dataset.loaded = '1'; }
  }
});
root.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName !== 'DETAILS') return;
  const f = foldsFor(currentKey);
  if (d.classList.contains('file')) { f.files[d.dataset.key] = d.open; if (d.open && !d.dataset.loaded) requestRows(d); }
  else if (d.classList.contains('block')) f.blocks[d.dataset.block] = d.open;
  save();
}, true);
const setAll = (open) => {
  const f = foldsFor(currentKey);
  root.querySelectorAll('details.file').forEach((d) => { d.open = open; f.files[d.dataset.key] = open; if (open && !d.dataset.loaded) requestRows(d); });
  save();
};
document.getElementById('expandAll').addEventListener('click', () => setAll(true));
document.getElementById('collapseAll').addEventListener('click', () => setAll(false));
const preview = document.getElementById('preview');
const locOf = (e) => {
  const loc = e.target.closest('.hdr, .list li, .row');
  if (loc && loc.dataset.path) return { path: loc.dataset.path, line: +loc.dataset.line, col: +loc.dataset.col };
  const codeRow = e.target.closest('table.code tr[data-line]');
  if (codeRow) return { path: codeRow.closest('table').dataset.path, line: +codeRow.dataset.line, col: 0 };
  return undefined;
};
// Source Insight style: single click previews in the pane below, double click opens the file.
let clickTimer;
root.addEventListener('click', (e) => {
  const member = e.target.closest('.members tbody tr');
  if (member) { vscode.postMessage({ type: 'target', id: +member.dataset.id }); return; }
  const loc = locOf(e);
  if (!loc) return;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => vscode.postMessage({ type: 'preview', ...loc }), 180);
});
root.addEventListener('dblclick', (e) => {
  const loc = locOf(e);
  if (!loc) return;
  clearTimeout(clickTimer);
  vscode.postMessage({ type: 'open', ...loc });
});
preview.addEventListener('click', (e) => {
  if (e.target.closest('.pclose')) { preview.hidden = true; return; }
  const b = e.target.closest('.popen');
  if (b) { vscode.postMessage({ type: 'open', path: b.dataset.path, line: +b.dataset.line, col: +b.dataset.col }); return; }
});
preview.addEventListener('dblclick', (e) => {
  const row = e.target.closest('table.code tr[data-line]');
  if (row) vscode.postMessage({ type: 'open', path: row.closest('table').dataset.path, line: +row.dataset.line, col: 0 });
});
</script></body></html>`;
}
