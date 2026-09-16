// Compact reference encoding for thread hand-off (no side effects: safe to bundle anywhere).
import type { FileIndex } from './extractor';

const REF_STRIDE = 5;

export function encodeRefs(index: FileIndex): { names: string[]; refData: Int32Array } {
  const names: string[] = [];
  const ids = new Map<string, number>();
  const data = new Int32Array(index.refs.length * REF_STRIDE);
  let o = 0;
  for (const r of index.refs) {
    let id = ids.get(r.name);
    if (id == null) {
      id = names.length;
      names.push(r.name);
      ids.set(r.name, id);
    }
    data[o++] = id;
    data[o++] = r.kind === 'call' ? 0 : 1;
    data[o++] = r.line;
    data[o++] = r.col;
    data[o++] = r.fromSymbol;
  }
  return { names, refData: data };
}

export function decodeRefs(names: string[], refData: Int32Array): FileIndex['refs'] {
  const refs: FileIndex['refs'] = new Array(refData.length / REF_STRIDE);
  for (let i = 0, o = 0; o < refData.length; i++, o += REF_STRIDE) {
    refs[i] = { name: names[refData[o]], kind: refData[o + 1] === 0 ? 'call' : 'ref', line: refData[o + 2], col: refData[o + 3], fromSymbol: refData[o + 4] };
  }
  return refs;
}

