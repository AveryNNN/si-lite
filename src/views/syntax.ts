// Small C/C++ lexer for colouring code snippets in webviews. Not a parser: it only needs to make
// keywords, strings, comments, numbers, preprocessor lines and call names look like the editor.
import { escapeHtml } from '../util-core';

const KEYWORDS = new Set(
  'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while class namespace template typename public private protected virtual override final new delete this try catch throw using operator friend explicit constexpr noexcept nullptr static_cast dynamic_cast reinterpret_cast const_cast true false'.split(' '),
);
const TYPES = new Set('void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t intptr_t wchar_t'.split(' '));

export type TokenClass = 'k' | 't' | 's' | 'c' | 'n' | 'p' | 'f' | 'm' | 'i' | 'o';
export interface Token {
  start: number;
  end: number;
  cls?: TokenClass;
}

/** State carried between lines: inside a block comment or not. */
export function tokenizeLine(line: string, inComment: boolean): { tokens: Token[]; inComment: boolean } {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;
  const push = (start: number, end: number, cls?: TokenClass) => {
    if (end > start) tokens.push({ start, end, cls });
  };
  if (inComment) {
    const close = line.indexOf('*/');
    if (close < 0) {
      push(0, n, 'c');
      return { tokens, inComment: true };
    }
    push(0, close + 2, 'c');
    i = close + 2;
    inComment = false;
  }
  // Preprocessor line: colour the directive, then lex the rest normally.
  const pp = /^\s*#\s*[A-Za-z_]+/.exec(line.slice(i));
  if (pp && i === 0) {
    push(0, pp[0].length, 'p');
    i = pp[0].length;
  }
  while (i < n) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') {
      push(i, n, 'c');
      i = n;
      break;
    }
    if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) {
        push(i, n, 'c');
        inComment = true;
        i = n;
        break;
      }
      push(i, close + 2, 'c');
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && line[j] !== ch) {
        if (line[j] === '\\') j++;
        j++;
      }
      push(i, Math.min(n, j + 1), 's');
      i = Math.min(n, j + 1);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F']+|0[bB][01']+|[0-9][0-9']*\.?[0-9']*(?:[eE][+-]?[0-9]+)?)[uUlLfF]*/.exec(line.slice(i));
      const len = m ? m[0].length : 1;
      push(i, i + len, 'n');
      i += len;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let cls: TokenClass = 'i';
      if (KEYWORDS.has(word)) cls = 'k';
      else if (TYPES.has(word) || /_t$/.test(word)) cls = 't';
      else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) cls = 'm';
      else {
        let k = j;
        while (k < n && line[k] === ' ') k++;
        if (line[k] === '(') cls = 'f';
      }
      push(i, j, cls);
      i = j;
      continue;
    }
    if (/[-+*\/%=<>!&|^~?:;,.{}()\[\]]/.test(ch)) {
      push(i, i + 1, 'o');
      i++;
      continue;
    }
    // whitespace or anything else
    let j = i + 1;
    while (j < n && !/[A-Za-z0-9_"'\/#\-+*%=<>!&|^~?:;,.{}()\[\]]/.test(line[j])) j++;
    push(i, j);
    i = j;
  }
  return { tokens, inComment };
}

/** Is the given line (0-based) inside a block comment at its start? Scans from the top of the file. */
export function commentStateAt(lines: string[], line: number): boolean {
  let inComment = false;
  const upto = Math.min(line, lines.length);
  for (let i = 0; i < upto; i++) inComment = tokenizeLine(lines[i], inComment).inComment;
  return inComment;
}

/** HTML for one line; `mark` wraps [col, col+len) in <mark> on top of the colouring. */
export function renderLine(line: string, inComment: boolean, mark?: { col: number; len: number }): { html: string; inComment: boolean } {
  const { tokens, inComment: next } = tokenizeLine(line, inComment);
  const cuts = new Set<number>([0, line.length]);
  for (const t of tokens) {
    cuts.add(t.start);
    cuts.add(t.end);
  }
  if (mark) {
    cuts.add(mark.col);
    cuts.add(mark.col + mark.len);
  }
  const points = [...cuts].filter((p) => p >= 0 && p <= line.length).sort((a, b) => a - b);
  let html = '';
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k];
    const b = points[k + 1];
    if (b <= a) continue;
    const tok = tokens.find((t) => t.start <= a && t.end >= b);
    const text = escapeHtml(line.slice(a, b));
    const inMark = mark && a >= mark.col && b <= mark.col + mark.len;
    let piece = tok?.cls ? `<span class="tk-${tok.cls}">${text}</span>` : text;
    if (inMark) piece = `<mark>${piece}</mark>`;
    html += piece;
  }
  return { html: html || '&nbsp;', inComment: next };
}

/** Token colours; picks up VS Code's light/dark body class in the webview. */
export const SYNTAX_CSS = `
.tk-k { color: #569cd6; } .tk-t { color: #4ec9b0; } .tk-s { color: #ce9178; } .tk-c { color: #6a9955; font-style: italic; }
.tk-n { color: #b5cea8; } .tk-p { color: #c586c0; } .tk-f { color: #dcdcaa; } .tk-m { color: #4fc1ff; } .tk-o { opacity: .85; }
body.vscode-light .tk-k { color: #0000ff; } body.vscode-light .tk-t { color: #267f99; } body.vscode-light .tk-s { color: #a31515; }
body.vscode-light .tk-c { color: #008000; } body.vscode-light .tk-n { color: #098658; } body.vscode-light .tk-p { color: #af00db; }
body.vscode-light .tk-f { color: #795e26; } body.vscode-light .tk-m { color: #0070c1; }
body.vscode-high-contrast .tk-k { color: #569cd6; }
`;
