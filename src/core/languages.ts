export type Lang = 'c' | 'cpp';

export type SymbolKind =
  | 'function'
  | 'prototype'
  | 'method'
  | 'variable'
  | 'field'
  | 'struct'
  | 'class'
  | 'union'
  | 'enum'
  | 'enumerator'
  | 'typedef'
  | 'macro'
  | 'namespace';

const EXT_LANG: Record<string, Lang | 'header'> = {
  '.c': 'c',
  '.h': 'header',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.inl': 'cpp',
  '.ipp': 'cpp',
};

export function langForPath(filePath: string, headerLang: Lang): Lang | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filePath.slice(dot).toLowerCase();
  const l = EXT_LANG[ext];
  if (!l) return undefined;
  return l === 'header' ? headerLang : l;
}

// Capture names are shared between grammars. The extractor dispatches on the
// pattern's outer capture (@fn, @decl, ...) and reads inner captures by name.
const COMMON_QUERY = `
(function_definition) @fn
(declaration) @decl
(struct_specifier name: (_) @name body: (_)) @struct
(union_specifier name: (_) @name body: (_)) @union
(enum_specifier name: (_) @name body: (_)) @enum
(enumerator name: (identifier) @name) @enumerator
(field_declaration) @field
(type_definition) @typedef
(preproc_def name: (identifier) @name) @macro
(preproc_function_def name: (identifier) @name) @macro
(preproc_include path: (_) @path) @include
(call_expression function: (identifier) @name) @call
(call_expression function: (field_expression field: (field_identifier) @name)) @call
(identifier) @ident
(type_identifier) @ident
(field_identifier) @ident
`;

const CPP_EXTRA_QUERY = `
(class_specifier name: (_) @name body: (_)) @class
(namespace_definition name: (_) @name) @namespace
(call_expression function: (qualified_identifier name: (identifier) @name)) @call
(call_expression function: (template_function name: (identifier) @name)) @call
(call_expression function: (qualified_identifier name: (template_function name: (identifier) @name))) @call
(call_expression function: (field_expression field: (template_method name: (field_identifier) @name))) @call
`;

export const QUERY_SOURCE: Record<Lang, string> = {
  c: COMMON_QUERY,
  cpp: COMMON_QUERY + CPP_EXTRA_QUERY,
};

export const WASM_FILE: Record<Lang, string> = {
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
};
