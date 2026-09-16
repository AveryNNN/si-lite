import { extract, type ExtractOptions } from './extractor';
import type { Lang } from './languages';
import type { ParserService } from './parser';
import type { Store } from './store';

const regexCache = new Map<string, RegExp | null>();

/**
 * Replace decorator macros with spaces of the same length so tree-sitter sees plain C
 * and every position stays valid. Source Insight has the same knob ("ignore macros").
 */
export function blankMacros(text: string, macros: string[] | undefined): string {
  if (!macros || !macros.length) return text;
  const key = macros.join('|');
  let re = regexCache.get(key);
  if (re === undefined) {
    const words = macros.filter((m) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(m));
    re = words.length ? new RegExp('\\b(?:' + words.join('|') + ')\\b', 'g') : null;
    regexCache.set(key, re);
  }
  if (!re) return text;
  return text.replace(re, (m) => ' '.repeat(m.length));
}

/** Parse a file's text and replace its rows in the store. Returns symbol count. */
export async function indexText(
  parser: ParserService,
  store: Store,
  filePath: string,
  lang: Lang,
  text: string,
  mtime: number,
  size: number,
  opts: ExtractOptions,
): Promise<number> {
  const parsed = await parser.parse(lang, blankMacros(text, opts.ignoreMacros));
  if (!parsed) return 0;
  try {
    const index = extract(parsed.tree, parsed.query, lang, opts);
    store.replaceFile(filePath, mtime, size, lang, index);
    return index.symbols.length;
  } finally {
    parsed.tree.delete();
  }
}
