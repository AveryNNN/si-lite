import * as fs from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { FileIndex } from './extractor';
import type { SymbolKind, Lang } from './languages';

const SCHEMA_VERSION = '7';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, mtime REAL, size INTEGER, lang TEXT
);
CREATE TABLE IF NOT EXISTS symbols(
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, name TEXT NOT NULL, qualname TEXT NOT NULL,
  kind TEXT NOT NULL, line INTEGER, col INTEGER, end_line INTEGER, signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sym_kind ON symbols(kind, name);
CREATE INDEX IF NOT EXISTS idx_sym_qual ON symbols(qualname);
CREATE TABLE IF NOT EXISTS names(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
-- kind: 0 = call, 1 = plain reference. Names are interned: a hot symbol like av_log
-- appears tens of thousands of times and the text would dominate the database size.
-- Clustered by file so re-indexing a file is a range delete with no extra index.
CREATE TABLE IF NOT EXISTS refs(
  file_id INTEGER NOT NULL, seq INTEGER NOT NULL, name_id INTEGER NOT NULL, kind INTEGER NOT NULL,
  line INTEGER, col INTEGER, from_symbol INTEGER,
  PRIMARY KEY(file_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_ref_name ON refs(name_id, kind);
CREATE INDEX IF NOT EXISTS idx_ref_from ON refs(from_symbol, kind);
CREATE TABLE IF NOT EXISTS bases(symbol_id INTEGER NOT NULL, base TEXT NOT NULL, file_id INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bases_sym ON bases(symbol_id);
CREATE INDEX IF NOT EXISTS idx_bases_base ON bases(base);
CREATE TABLE IF NOT EXISTS includes(
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, path TEXT NOT NULL, line INTEGER, is_system INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inc_file ON includes(file_id);
CREATE INDEX IF NOT EXISTS idx_inc_path ON includes(path);
`;

export interface FileRow {
  id: number;
  path: string;
  mtime: number;
  size: number;
  lang: Lang;
}

export interface SymbolRow {
  id: number;
  fileId: number;
  path: string;
  name: string;
  qualname: string;
  kind: SymbolKind;
  line: number;
  col: number;
  endLine: number;
  signature: string;
}

export interface RefRow {
  path: string;
  fileId: number;
  name: string;
  kind: 'call' | 'ref';
  line: number;
  col: number;
  fromSymbol?: SymbolRow;
}

export interface CalleeRow {
  name: string;
  line: number;
  col: number;
  count: number;
  target?: SymbolRow;
}

export interface IncludeRow {
  path: string;
  line: number;
  isSystem: boolean;
  resolved?: FileRow;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function rowToSymbol(r: Record<string, unknown>): SymbolRow {
  return {
    id: r.id as number,
    fileId: r.file_id as number,
    path: r.path as string,
    name: r.name as string,
    qualname: r.qualname as string,
    kind: r.kind as SymbolKind,
    line: r.line as number,
    col: r.col as number,
    endLine: r.end_line as number,
    signature: (r.signature as string) ?? '',
  };
}

const SYMBOL_SELECT = `SELECT s.id, s.file_id, f.path, s.name, s.qualname, s.kind, s.line, s.col, s.end_line, s.signature
  FROM symbols s JOIN files f ON f.id = s.file_id`;

const KIND_RANK = `CASE s.kind WHEN 'function' THEN 0 WHEN 'method' THEN 0 WHEN 'macro' THEN 1 WHEN 'struct' THEN 1 WHEN 'class' THEN 1
  WHEN 'typedef' THEN 1 WHEN 'enum' THEN 1 WHEN 'union' THEN 1 WHEN 'variable' THEN 2 WHEN 'enumerator' THEN 2
  WHEN 'field' THEN 3 WHEN 'prototype' THEN 4 ELSE 5 END`;

const REF_KIND: Record<'call' | 'ref', number> = { call: 0, ref: 1 };
const REF_KIND_NAME: Array<'call' | 'ref'> = ['call', 'ref'];

export class Store {
  private nextSymbolId = 1;
  private dirty = false;
  private names = new Map<string, number>();
  private static SQL: SqlJsStatic | undefined;

  private constructor(private db: Database, private readonly dbPath: string | undefined) {}

  /** Swap in the database file written by a worker build. In-memory changes are discarded. */
  reloadFromDisk(): void {
    if (!this.dbPath || !fs.existsSync(this.dbPath) || !Store.SQL) return;
    const fresh = new Store.SQL.Database(fs.readFileSync(this.dbPath));
    const v = fresh.exec(`SELECT value FROM meta WHERE key='schema'`);
    if (!v.length || v[0].values[0][0] !== SCHEMA_VERSION) {
      fresh.close();
      return;
    }
    this.db.close();
    this.db = fresh;
    const mx = this.db.exec(`SELECT COALESCE(MAX(id), 0) FROM symbols`);
    this.nextSymbolId = (mx[0].values[0][0] as number) + 1;
    this.loadNames();
    this.dirty = false;
  }

  private loadNames(): void {
    this.names.clear();
    for (const r of this.all(`SELECT id, name FROM names`)) this.names.set(r.name as string, r.id as number);
  }

  private nameId(name: string): number {
    let id = this.names.get(name);
    if (id == null) {
      this.db.run(`INSERT INTO names(name) VALUES(?)`, [name]);
      id = this.one(`SELECT last_insert_rowid() AS id`)!.id as number;
      this.names.set(name, id);
    }
    return id;
  }

  static async open(wasmDir: string, dbPath?: string): Promise<Store> {
    const SQL: SqlJsStatic = await initSqlJs({
      locateFile: (file: string) => path.join(wasmDir, file),
    });
    Store.SQL = SQL;
    let db: Database | undefined;
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        db = new SQL.Database(fs.readFileSync(dbPath));
        const v = db.exec(`SELECT value FROM meta WHERE key='schema'`);
        if (!v.length || v[0].values[0][0] !== SCHEMA_VERSION) {
          db.close();
          db = undefined;
        }
      } catch {
        db = undefined;
      }
    }
    if (!db) {
      db = new SQL.Database();
      db.run(SCHEMA);
      db.run(`INSERT OR REPLACE INTO meta(key, value) VALUES('schema', ?)`, [SCHEMA_VERSION]);
    }
    const store = new Store(db, dbPath);
    const mx = db.exec(`SELECT COALESCE(MAX(id), 0) FROM symbols`);
    store.nextSymbolId = (mx[0].values[0][0] as number) + 1;
    store.loadNames();
    return store;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  save(): void {
    if (!this.dbPath) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }

  close(): void {
    this.db.close();
  }

  clear(): void {
    this.db.run(`DELETE FROM refs; DELETE FROM includes; DELETE FROM bases; DELETE FROM symbols; DELETE FROM files; DELETE FROM names;`);
    this.nextSymbolId = 1;
    this.names.clear();
    this.dirty = true;
  }

  private all(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    const out: Record<string, unknown>[] = [];
    try {
      stmt.bind(params as never[]);
      while (stmt.step()) out.push(stmt.getAsObject() as Record<string, unknown>);
    } finally {
      stmt.free();
    }
    return out;
  }

  private one(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
    return this.all(sql, params)[0];
  }

  // ---- files ---------------------------------------------------------------

  getFile(filePath: string): FileRow | undefined {
    const r = this.one(`SELECT * FROM files WHERE path = ?`, [normalizePath(filePath)]);
    return r ? (r as unknown as FileRow) : undefined;
  }

  getFileById(id: number): FileRow | undefined {
    const r = this.one(`SELECT * FROM files WHERE id = ?`, [id]);
    return r ? (r as unknown as FileRow) : undefined;
  }

  allFiles(): FileRow[] {
    return this.all(`SELECT * FROM files ORDER BY path`) as unknown as FileRow[];
  }

  removeFile(filePath: string): void {
    const f = this.getFile(filePath);
    if (!f) return;
    this.db.run(`DELETE FROM refs WHERE file_id = ?`, [f.id]);
    this.db.run(`DELETE FROM includes WHERE file_id = ?`, [f.id]);
    this.db.run(`DELETE FROM bases WHERE file_id = ?`, [f.id]);
    this.db.run(`DELETE FROM symbols WHERE file_id = ?`, [f.id]);
    this.db.run(`DELETE FROM files WHERE id = ?`, [f.id]);
    this.dirty = true;
  }

  /** Replace everything known about a file in one transaction. */
  replaceFile(filePath: string, mtime: number, size: number, lang: Lang, index: FileIndex): number {
    const p = normalizePath(filePath);
    this.db.run('BEGIN');
    try {
      let fileId: number;
      const existing = this.one(`SELECT id FROM files WHERE path = ?`, [p]);
      if (existing) {
        fileId = existing.id as number;
        this.db.run(`DELETE FROM refs WHERE file_id = ?`, [fileId]);
        this.db.run(`DELETE FROM includes WHERE file_id = ?`, [fileId]);
        this.db.run(`DELETE FROM bases WHERE file_id = ?`, [fileId]);
        this.db.run(`DELETE FROM symbols WHERE file_id = ?`, [fileId]);
        this.db.run(`UPDATE files SET mtime = ?, size = ?, lang = ? WHERE id = ?`, [mtime, size, lang, fileId]);
      } else {
        this.db.run(`INSERT INTO files(path, mtime, size, lang) VALUES(?, ?, ?, ?)`, [p, mtime, size, lang]);
        fileId = this.one(`SELECT last_insert_rowid() AS id`)!.id as number;
      }

      const baseId = this.nextSymbolId;
      const symStmt = this.db.prepare(
        `INSERT INTO symbols(id, file_id, name, qualname, kind, line, col, end_line, signature) VALUES(?,?,?,?,?,?,?,?,?)`,
      );
      try {
        index.symbols.forEach((s, i) => {
          symStmt.run([baseId + i, fileId, s.name, s.qualname, s.kind, s.line, s.col, s.endLine, s.signature]);
        });
      } finally {
        symStmt.free();
      }
      this.nextSymbolId = baseId + index.symbols.length;

      const refStmt = this.db.prepare(
        `INSERT INTO refs(file_id, seq, name_id, kind, line, col, from_symbol) VALUES(?,?,?,?,?,?,?)`,
      );
      try {
        let seq = 0;
        for (const r of index.refs) {
          refStmt.run([fileId, seq++, this.nameId(r.name), REF_KIND[r.kind], r.line, r.col, r.fromSymbol >= 0 ? baseId + r.fromSymbol : null]);
        }
      } finally {
        refStmt.free();
      }

      const baseStmt = this.db.prepare(`INSERT INTO bases(symbol_id, base, file_id) VALUES(?,?,?)`);
      try {
        for (const b of index.bases ?? []) baseStmt.run([baseId + b.symbol, b.base, fileId]);
      } finally {
        baseStmt.free();
      }

      const incStmt = this.db.prepare(`INSERT INTO includes(file_id, path, line, is_system) VALUES(?,?,?,?)`);
      try {
        for (const inc of index.includes) incStmt.run([fileId, inc.path, inc.line, inc.isSystem ? 1 : 0]);
      } finally {
        incStmt.free();
      }
      this.db.run('COMMIT');
      this.dirty = true;
      return fileId;
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  // ---- symbols -------------------------------------------------------------

  findSymbols(name: string): SymbolRow[] {
    return this.all(`${SYMBOL_SELECT} WHERE s.name = ? ORDER BY ${KIND_RANK}, (s.end_line - s.line) DESC, f.path, s.line`, [name]).map(rowToSymbol);
  }

  /** Definitions only (prototypes fall back in when nothing else matches). */
  findDefinitions(name: string): SymbolRow[] {
    const rows = this.findSymbols(name);
    const defs = rows.filter((r) => r.kind !== 'prototype');
    return defs.length ? defs : rows;
  }

  getSymbol(id: number): SymbolRow | undefined {
    const r = this.one(`${SYMBOL_SELECT} WHERE s.id = ?`, [id]);
    return r ? rowToSymbol(r) : undefined;
  }

  searchSymbols(query: string, limit = 200): SymbolRow[] {
    const q = query.trim();
    if (!q) return [];
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return this.all(
      `${SYMBOL_SELECT} WHERE s.name LIKE ? ESCAPE '\\'
       ORDER BY instr(lower(s.name), lower(?)) , length(s.name), ${KIND_RANK}, s.name LIMIT ?`,
      [like, q, limit],
    ).map(rowToSymbol);
  }

  /** Case-sensitive prefix match that can use the name index; distinct names only. */
  symbolsWithPrefix(prefix: string, limit = 200): SymbolRow[] {
    if (!prefix) return [];
    const hi = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.all(
      `${SYMBOL_SELECT} WHERE s.name >= ? AND s.name < ? GROUP BY s.name ORDER BY ${KIND_RANK}, s.name LIMIT ?`,
      [prefix, hi, limit],
    ).map(rowToSymbol);
  }

  /** Distinct names of one kind (for semantic colouring). */
  namesOfKind(kinds: SymbolKind[]): Set<string> {
    const placeholders = kinds.map(() => '?').join(',');
    const rows = this.all(`SELECT DISTINCT name FROM symbols WHERE kind IN (${placeholders})`, kinds);
    return new Set(rows.map((r) => r.name as string));
  }

  symbolsByKind(kind: SymbolKind, limit = 5000): SymbolRow[] {
    return this.all(`${SYMBOL_SELECT} WHERE s.kind = ? ORDER BY s.name, f.path LIMIT ?`, [kind, limit]).map(rowToSymbol);
  }

  kindCounts(): Array<{ kind: SymbolKind; count: number }> {
    return this.all(`SELECT kind, COUNT(*) AS count FROM symbols GROUP BY kind ORDER BY kind`).map((r) => ({
      kind: r.kind as SymbolKind,
      count: r.count as number,
    }));
  }

  fileSymbols(fileId: number): SymbolRow[] {
    return this.all(`${SYMBOL_SELECT} WHERE s.file_id = ? ORDER BY s.line`, [fileId]).map(rowToSymbol);
  }

  /** Innermost function/method whose range covers the line in a file. */
  enclosingFunction(filePath: string, line: number): SymbolRow | undefined {
    const r = this.one(
      `${SYMBOL_SELECT} WHERE f.path = ? AND s.kind IN ('function','method') AND s.line <= ? AND s.end_line >= ?
       ORDER BY s.line DESC LIMIT 1`,
      [normalizePath(filePath), line, line],
    );
    return r ? rowToSymbol(r) : undefined;
  }

  // ---- relations -----------------------------------------------------------

  callersOf(name: string, limit = 100000): RefRow[] {
    const nid = this.names.get(name);
    if (nid == null) return [];
    return this.all(
      `SELECT r.line, r.col, r.kind, r.file_id, f.path,
              s.id AS s_id, s.file_id AS s_file_id, sf.path AS s_path, s.name AS s_name, s.qualname AS s_qualname,
              s.kind AS s_kind, s.line AS s_line, s.col AS s_col, s.end_line AS s_end_line, s.signature AS s_signature
       FROM refs r JOIN files f ON f.id = r.file_id
       LEFT JOIN symbols s ON s.id = r.from_symbol
       LEFT JOIN files sf ON sf.id = s.file_id
       WHERE r.name_id = ? AND r.kind = 0
       ORDER BY f.path, r.line LIMIT ?`,
      [nid, limit],
    ).map((r) => refRowWithFrom(r, name));
  }

  callerCount(name: string): number {
    const nid = this.names.get(name);
    if (nid == null) return 0;
    return this.one(`SELECT COUNT(*) AS c FROM refs WHERE name_id = ? AND kind = 0`, [nid])!.c as number;
  }

  calleesOf(symbolId: number): CalleeRow[] {
    const rows = this.all(
      `SELECT n.name, MIN(r.line) AS line, MIN(r.col) AS col, COUNT(*) AS count
       FROM refs r JOIN names n ON n.id = r.name_id
       WHERE r.from_symbol = ? AND r.kind = 0 GROUP BY r.name_id ORDER BY line`,
      [symbolId],
    );
    return rows.map((r) => {
      const name = r.name as string;
      const target = this.findDefinitions(name).find((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'macro')
        ?? this.findDefinitions(name)[0];
      return { name, line: r.line as number, col: r.col as number, count: r.count as number, target };
    });
  }

  referencesOf(name: string, limit = 200000): RefRow[] {
    const nid = this.names.get(name);
    if (nid == null) return [];
    return this.all(
      `SELECT r.line, r.col, r.kind, r.file_id, f.path,
              s.id AS s_id, s.file_id AS s_file_id, sf.path AS s_path, s.name AS s_name, s.qualname AS s_qualname,
              s.kind AS s_kind, s.line AS s_line, s.col AS s_col, s.end_line AS s_end_line, s.signature AS s_signature
       FROM refs r JOIN files f ON f.id = r.file_id
       LEFT JOIN symbols s ON s.id = r.from_symbol
       LEFT JOIN files sf ON sf.id = s.file_id
       WHERE r.name_id = ? ORDER BY f.path, r.line, r.col LIMIT ?`,
      [nid, limit],
    ).map((r) => refRowWithFrom(r, name));
  }

  /** Files that mention a name, with counts, biggest first. Cheap even for hot names (index only). */
  referenceFiles(name: string): Array<{ fileId: number; path: string; total: number; calls: number }> {
    const nid = this.names.get(name);
    if (nid == null) return [];
    return this.all(
      `SELECT r.file_id, f.path, COUNT(*) AS total, SUM(CASE WHEN r.kind = 0 THEN 1 ELSE 0 END) AS calls
       FROM refs r JOIN files f ON f.id = r.file_id
       WHERE r.name_id = ? GROUP BY r.file_id ORDER BY total DESC, f.path`,
      [nid],
    ).map((r) => ({ fileId: r.file_id as number, path: r.path as string, total: r.total as number, calls: r.calls as number }));
  }

  /** Reference rows inside one file, with the enclosing function's name. */
  referencesInFile(name: string, fileId: number, limit = 500): Array<{ line: number; col: number; kind: 'call' | 'ref'; from?: string }> {
    const nid = this.names.get(name);
    if (nid == null) return [];
    return this.all(
      `SELECT r.line, r.col, r.kind, s.qualname AS from_name
       FROM refs r LEFT JOIN symbols s ON s.id = r.from_symbol
       WHERE r.name_id = ? AND r.file_id = ? ORDER BY r.line, r.col LIMIT ?`,
      [nid, fileId, limit],
    ).map((r) => ({
      line: r.line as number,
      col: r.col as number,
      kind: REF_KIND_NAME[r.kind as number],
      from: (r.from_name as string | null) ?? undefined,
    }));
  }

  /** Direct members (fields, methods, prototypes) of a struct/class/union by its qualified name. */
  membersOf(qualname: string): SymbolRow[] {
    // Range scan on the qualname index (C/C++ names are case-sensitive, so no LIKE needed).
    const prefix = qualname + '::';
    return this.all(
      `${SYMBOL_SELECT} WHERE s.qualname >= ? AND s.qualname < ? AND instr(substr(s.qualname, ?), '::') = 0
         AND s.kind IN ('field', 'method', 'prototype') ORDER BY f.path, s.line, s.col`,
      [prefix, prefix + '\uffff', prefix.length + 1],
    ).map(rowToSymbol);
  }

  /** Functions whose bodies reference every one of `names` (Source Insight's "Search Project" for symbols). */
  functionsUsingAll(names: string[], limit = 200): Array<{ symbol: SymbolRow; hits: number }> {
    const ids = names.map((n) => this.names.get(n)).filter((x): x is number => x != null);
    if (ids.length !== names.length || !ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.all(
      `SELECT s.id, s.file_id, f.path, s.name, s.qualname, s.kind, s.line, s.col, s.end_line, s.signature, COUNT(*) AS hits
       FROM refs r JOIN symbols s ON s.id = r.from_symbol JOIN files f ON f.id = s.file_id
       WHERE r.name_id IN (${placeholders})
       GROUP BY r.from_symbol HAVING COUNT(DISTINCT r.name_id) = ?
       ORDER BY hits DESC, f.path, s.line LIMIT ?`,
      [...ids, ids.length, limit],
    ).map((r) => ({ symbol: rowToSymbol(r), hits: r.hits as number }));
  }

  // ---- inheritance ---------------------------------------------------------

  /** Base classes of a class symbol, resolved to symbols when the base is in the project. */
  basesOf(symbolId: number): Array<{ name: string; symbol?: SymbolRow }> {
    return this.all(`SELECT base FROM bases WHERE symbol_id = ?`, [symbolId]).map((r) => {
      const name = r.base as string;
      const symbol = this.findDefinitions(name).find((s) => s.kind === 'class' || s.kind === 'struct');
      return { name, symbol };
    });
  }

  /** Classes that list `name` as a base. */
  derivedOf(name: string): SymbolRow[] {
    return this.all(`${SYMBOL_SELECT} JOIN bases b ON b.symbol_id = s.id WHERE b.base = ? ORDER BY s.name`, [name]).map(rowToSymbol);
  }

  // ---- includes ------------------------------------------------------------

  includesOf(fileId: number): IncludeRow[] {
    const rows = this.all(`SELECT path, line, is_system FROM includes WHERE file_id = ? ORDER BY line`, [fileId]);
    return rows.map((r) => ({
      path: r.path as string,
      line: r.line as number,
      isSystem: !!r.is_system,
      resolved: this.resolveInclude(r.path as string),
    }));
  }

  resolveInclude(includePath: string): FileRow | undefined {
    const suffix = '/' + includePath.toLowerCase();
    const r = this.one(
      `SELECT * FROM files WHERE substr(lower(path), -length(?)) = ? ORDER BY length(path) LIMIT 1`,
      [suffix, suffix],
    );
    return r ? (r as unknown as FileRow) : undefined;
  }

  includedBy(filePath: string): Array<{ file: FileRow; line: number }> {
    const p = normalizePath(filePath).toLowerCase();
    return this.all(
      `SELECT f.id, f.path, f.mtime, f.size, f.lang, i.line
       FROM includes i JOIN files f ON f.id = i.file_id
       WHERE substr(?, -length(i.path) - 1) = '/' || lower(i.path)
       ORDER BY f.path`,
      [p],
    ).map((r) => ({
      file: { id: r.id as number, path: r.path as string, mtime: r.mtime as number, size: r.size as number, lang: r.lang as Lang },
      line: r.line as number,
    }));
  }

  // ---- stats ---------------------------------------------------------------

  stats(): { files: number; symbols: number; refs: number } {
    const n = (t: string) => this.one(`SELECT COUNT(*) AS c FROM ${t}`)!.c as number;
    return { files: n('files'), symbols: n('symbols'), refs: n('refs') };
  }
}

function refRowWithFrom(r: Record<string, unknown>, name: string): RefRow {
  const row: RefRow = {
    path: r.path as string,
    fileId: r.file_id as number,
    name,
    kind: REF_KIND_NAME[r.kind as number],
    line: r.line as number,
    col: r.col as number,
  };
  if (r.s_id != null) {
    row.fromSymbol = {
      id: r.s_id as number,
      fileId: r.s_file_id as number,
      path: r.s_path as string,
      name: r.s_name as string,
      qualname: r.s_qualname as string,
      kind: r.s_kind as SymbolKind,
      line: r.s_line as number,
      col: r.s_col as number,
      endLine: r.s_end_line as number,
      signature: (r.s_signature as string) ?? '',
    };
  }
  return row;
}
