import * as path from 'node:path';
import type { Tree, Query as QueryT, Language as LanguageT, Parser as ParserT } from 'web-tree-sitter';

// Use the CommonJS build: the ESM build relies on import.meta.url, which does not survive bundling to CJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const TreeSitter = require('web-tree-sitter') as typeof import('web-tree-sitter');
const { Parser, Language, Query } = TreeSitter;
type Query = QueryT;
type Language = LanguageT;
type Parser = ParserT;
import { Lang, QUERY_SOURCE, WASM_FILE } from './languages';

interface LoadedLang {
  language: Language;
  query: Query;
}

/** Owns the tree-sitter runtime and lazily loaded grammars. */
export class ParserService {
  private parser!: Parser;
  private langs = new Map<Lang, Promise<LoadedLang>>();

  constructor(private readonly wasmDir: string) {}

  async init(): Promise<void> {
    await Parser.init({
      locateFile: (file: string) => path.join(this.wasmDir, file),
    });
    this.parser = new Parser();
  }

  private load(lang: Lang): Promise<LoadedLang> {
    let p = this.langs.get(lang);
    if (!p) {
      p = (async () => {
        const language = await Language.load(path.join(this.wasmDir, WASM_FILE[lang]));
        const query = new Query(language, QUERY_SOURCE[lang]);
        return { language, query };
      })();
      this.langs.set(lang, p);
    }
    return p;
  }

  /** Parse text and hand back the tree plus the grammar's query. Caller must tree.delete(). */
  async parse(lang: Lang, text: string, oldTree?: Tree): Promise<{ tree: Tree; query: Query } | undefined> {
    const { language, query } = await this.load(lang);
    this.parser.setLanguage(language);
    const tree = this.parser.parse(text, oldTree);
    if (!tree) return undefined;
    return { tree, query };
  }
}
