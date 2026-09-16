import * as vscode from 'vscode';
import type { SymbolKind } from './core/languages';
import { normalizePath } from './core/store';

export function fsPathOf(uri: vscode.Uri): string {
  return normalizePath(uri.fsPath);
}

export function uriOf(storedPath: string): vscode.Uri {
  return vscode.Uri.file(storedPath);
}

export function wordAt(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
  const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_][A-Za-z0-9_]*/);
  return range ? doc.getText(range) : undefined;
}

export function isCFamily(doc: vscode.TextDocument | undefined): doc is vscode.TextDocument {
  return !!doc && (doc.languageId === 'c' || doc.languageId === 'cpp');
}

export async function openLocation(storedPath: string, line: number, col = 0, preserveFocus = false): Promise<void> {
  const uri = uriOf(storedPath);
  const pos = new vscode.Position(Math.max(0, line), Math.max(0, col));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(pos, pos),
    preserveFocus,
    preview: true,
  });
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const ENCODING_MAP: Record<string, string> = {
  utf8: 'utf-8', utf8bom: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be',
  gbk: 'gbk', gb2312: 'gb2312', gb18030: 'gb18030', big5: 'big5', big5hkscs: 'big5-hkscs',
  shiftjis: 'shift_jis', eucjp: 'euc-jp', euckr: 'euc-kr', cp1252: 'windows-1252', windows1252: 'windows-1252',
  iso88591: 'iso-8859-1', iso885915: 'iso-8859-15', koi8r: 'koi8-r', cp1251: 'windows-1251', windows1251: 'windows-1251',
};

/** TextDecoder label matching the editor's files.encoding, so byte offsets line up with what VS Code shows. */
export function fileEncoding(): string {
  const enc = vscode.workspace.getConfiguration('files').get<string>('encoding', 'utf8');
  const label = ENCODING_MAP[enc.toLowerCase()] ?? 'utf-8';
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

export function makeDecoder(): InstanceType<typeof TextDecoder> {
  return new TextDecoder(fileEncoding(), { fatal: false });
}

export function config() {
  const c = vscode.workspace.getConfiguration('siLite');
  return {
    include: c.get<string>('include', '**/*.{c,h,cpp,cc,cxx,hpp,hh,hxx,inl}'),
    exclude: c.get<string>('exclude', '{**/node_modules/**,**/.git/**,**/build/**,**/out/**,**/dist/**}'),
    headerLanguage: c.get<'c' | 'cpp'>('headerLanguage', 'cpp'),
    indexReferences: c.get<boolean>('indexReferences', true),
    autoBuildOnOpen: c.get<boolean>('autoBuildOnOpen', false),
    relationDepth: c.get<number>('relationDepth', 1),
    relationFollowCursor: c.get<boolean>('relationFollowCursor', true),
    maxGraphNodes: c.get<number>('maxGraphNodes', 150),
    provideHover: c.get<boolean>('provideHover', true),
    ignoreMacros: c.get<string[]>('ignoreMacros', []),
    semanticHighlighting: c.get<boolean>('semanticHighlighting', true),
    parallelism: c.get<number>('parallelism', 0),
    externalPaths: c.get<string[]>('externalPaths', []),
    excludePaths: c.get<string[]>('excludePaths', []),
  };
}

export const KIND_ICON: Record<SymbolKind, string> = {
  function: 'symbol-method',
  method: 'symbol-method',
  prototype: 'symbol-interface',
  variable: 'symbol-variable',
  field: 'symbol-field',
  struct: 'symbol-structure',
  class: 'symbol-class',
  union: 'symbol-structure',
  enum: 'symbol-enum',
  enumerator: 'symbol-enum-member',
  typedef: 'symbol-type-parameter',
  macro: 'symbol-constant',
  namespace: 'symbol-namespace',
};

export const KIND_TO_VSCODE: Record<SymbolKind, vscode.SymbolKind> = {
  function: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  prototype: vscode.SymbolKind.Interface,
  variable: vscode.SymbolKind.Variable,
  field: vscode.SymbolKind.Field,
  struct: vscode.SymbolKind.Struct,
  class: vscode.SymbolKind.Class,
  union: vscode.SymbolKind.Struct,
  enum: vscode.SymbolKind.Enum,
  enumerator: vscode.SymbolKind.EnumMember,
  typedef: vscode.SymbolKind.TypeParameter,
  macro: vscode.SymbolKind.Constant,
  namespace: vscode.SymbolKind.Namespace,
};

export function relPath(storedPath: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    const root = fsPathOf(f.uri);
    if (storedPath.toLowerCase().startsWith(root.toLowerCase() + '/')) return storedPath.slice(root.length + 1);
  }
  return storedPath;
}

export { escapeHtml, nonce } from './util-core';
