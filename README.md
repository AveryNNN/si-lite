# Source Insight Lite

A VS Code extension that brings the parts of Source Insight people actually miss:
a project-wide symbol database you build once and keep in sync, a Context window that
shows the definition of whatever is under the cursor, and a Relation graph for call and
include relationships. No compiler, no `compile_commands.json`, no language server required.

Parsing is done with tree-sitter (C and C++ grammars, WASM), and the symbol database is SQLite
(sql.js), persisted per workspace so the next open is instant.

## 中文说明

这是一个把 Source Insight 的核心体验搬进 VS Code 的插件：先"构建工程"生成整库符号数据库并缓存，然后有跟随光标的**上下文**视图、展示调用 / 被调用 / 包含 / 继承关系的**关系图**面板，以及一整套不依赖语言服务器的编辑器功能。只靠 tree-sitter 解析 C/C++，不需要编译、`compile_commands.json` 或 clangd。

**对照 Source Insight 已实现的功能**

| Source Insight | 这里 |
|---|---|
| Synchronize Files / Rebuild Project | `SI：构建工程`（增量）/ `SI：重建工程`；后台 worker 线程，编辑器不卡 |
| Add / Remove Project Files | 资源管理器右键：`SI：加入工程`（工作区外的目录也可以）/ `SI：从工程移除` |
| Project Symbol List | 侧边栏"工程符号"树 + `Ctrl+Alt+S` 模糊搜索 + `Ctrl+T` |
| Symbol Window（文件内符号列表） | 大纲视图、面包屑、`Ctrl+Shift+O`，可按名字 / 位置 / 类型排序和过滤 |
| Context Window | "上下文"视图：带语法着色的定义、结构体成员表（每个成员被多少文件引用，点击切换）、全工程引用按文件分组并按离光标的远近排序；变量会解码到它的结构体类型；局部变量只显示所在函数内的使用；单击在下方预览，双击打开 |
| Relation Window | "关系图"视图：调用 / 被调用 / 双向、基类 / 派生类、包含 / 被包含，深度 1-4，跟随光标。图形和大纲列表两种形式；扇入扇出过大时按目录折叠；节点右侧的 ⊕ 再展开一层（对应 SI 图框右边的展开）；单击选中并同步上下文视图，双击打开，右键设为中心 |
| Lookup References | `Ctrl+Alt+/` 全工程引用、`Ctrl+Alt+.` 仅本文件，用 VS Code 原生引用面板展示；也可直接 `Shift+F12` |
| 调用树 / 类继承树（大纲形式） | VS Code 自带的 Call Hierarchy 和 Type Hierarchy 视图 |
| 自动引用高亮（区分作用域） | 光标处标识符的高亮按作用域区分：局部变量只高亮本函数内；另有 Source Insight 式的 F8 持久高亮（`SI：高亮 / 取消高亮光标处符号`），不随光标移动消失，可叠加多个颜色 |
| 符号自动补全（`p->` 列出成员） | 补全会推断 `p`、`a->b`、`(T*)x`、`f()` 的类型后列出成员；普通标识符按前缀补全 |
| Smart Rename | `F2` 重命名：局部变量只改本作用域，全局按名字改全工程 |
| 上下文语法着色 | 语义着色：宏、全局变量、参数、局部变量、成员、类型、枚举值各有颜色（需开启 `editor.semanticHighlighting.enabled`） |
| Search Project（多主题搜索） | `SI：搜索工程`（`Ctrl+Alt+Shift+S`）：输入多个符号名，列出同时用到它们的函数 |
| 头文件跳转 | `#include "x.h"` 上 Ctrl+点击直接打开 |
| 转到声明 / 参数提示 | "转到声明"跳到原型；输入 `name(` 时显示参数列表 |

查找引用和重命名是**上下文敏感**的：先用名字索引缩小到候选文件，再逐个文件解析语法树，剔除只是同名的局部变量、参数和其他类型的同名成员（候选文件不超过 250 个时；再多则退回按名字）。上下文视图展开某个文件时同样过滤，并注明隐藏了几处。

文件按编辑器的 `files.encoding` 解码（GBK、Big5 等都可以），列号和编辑器一致；悬停会带上定义上方的注释；打开工作区时若已有数据库会静默做一次增量同步。

**类型与作用域的处理**：`int c` 和 `float c` 不会混在一起。光标处的标识符先在当前文件的语法树里找局部声明和参数；`p->c` 会先解析 `p` 的类型（局部声明、全局变量声明、结构体成员类型、函数返回值、强制转换都能推断），再精确定位到那个结构体的 `c`；只有全局符号才回落到按名字查找，并优先同文件的定义。跨文件的成员引用统计仍是按名字匹配的，这一点和 Source Insight 一样。

**使用步骤**

1. 打开 C/C++ 工作区，运行命令 **SI：构建工程**。
2. 光标放到符号上，左侧"上下文"和"关系图"两个视图自动更新；`Ctrl+Alt+R` 以光标处符号为中心重绘关系图。
3. 关系图里单击节点打开位置，双击换中心，点击边跳到调用点。
4. 保存文件或外部改动会自动只重索引那个文件；编辑时语法树增量更新，大文件也不卡。

界面语言：命令名和设置项跟随 VS Code 显示语言（需要中文语言包）；提示、上下文视图和关系图面板由 `siLite.language` 控制（`auto` / `zh-cn` / `en`）。

工程依赖工作区之外的 SDK / HAL 头文件时，把那些目录填进 `siLite.externalPaths`，它们会一起被索引（相当于 SI 的外部库）。

快捷键由 `siLite.keymap` 决定：`default` 用 Ctrl+Alt 组合，外加 F8 高亮单词（在 C/C++ 文件里取代 VS Code 的"下一个问题"，可用 Ctrl+K Ctrl+S 改回），`sourceInsight` 用 Source Insight 的 `Ctrl+=` 跳转定义、`Ctrl+/` 查找引用、`F7` 工程符号、`F8` 高亮单词、`Alt+,` / `Alt+.` 后退前进（会在 C/C++ 文件里覆盖 VS Code 的放大、切换注释、下一个问题），`none` 则不预设任何键。所有绑定只在 C/C++ 编辑器里生效，别的语言不受影响。

如果你的工程里有 `av_cold`、`__init` 这类夹在类型和函数名之间的修饰宏，把它们加进 `siLite.ignoreMacros`，否则这些函数会解析不出名字。

## Features

| Source Insight | Here |
|---|---|
| Synchronize Files / Rebuild Project | `SI: Build Project` (incremental, mtime based) / `SI: Rebuild Project`, in worker threads |
| Add / Remove Project Files | Right-click in the Explorer: `SI: Add to Project` (also folders outside the workspace) / `SI: Remove from Project` |
| Project Symbol List | **Project Symbols** tree, `SI: Search Project Symbol` (`Ctrl+Alt+S`), `Ctrl+T` workspace symbols |
| Symbol Window | Outline, breadcrumbs and `Ctrl+Shift+O` from a tree-sitter DocumentSymbolProvider |
| Context Window | **Context** view: syntax-coloured definition, struct member table with usage counts, project-wide uses grouped by file and ordered by closeness to the cursor; variables are decoded to their struct type; locals show only their scope; single click previews in the pane below, double click opens |
| Relation Window | **Relations** view: calls / called by / both, base / derived classes, include graph, depth 1-4, follows the cursor. Graph or outline list; big fan-in/out is folded by folder; the ⊕ handle on a node expands one more level (Source Insight's box handle); click selects and the Context view follows, double-click opens, right-click re-centres |
| Lookup References | `Ctrl+Alt+/` project wide, `Ctrl+Alt+.` this file, shown in VS Code's own references peek; `Shift+F12` works too |
| Call / class trees in outline form | VS Code's Call Hierarchy and Type Hierarchy views |
| Automatic reference highlighting | Scope-aware DocumentHighlightProvider; F8-style sticky highlight (`SI: Toggle Highlight`) that survives cursor moves |
| Symbolic auto-completion | `p->` lists the members of `p`'s type (locals, globals, member chains, casts, call results); identifiers complete by prefix |
| Smart Rename | `F2`: locals rename within their scope, globals project wide by name |
| Contextual syntax formatting | Semantic tokens for macros, globals, parameters, locals, fields, types, enumerators |
| Search Project (multi-topic) | `SI: Search Project` (`Ctrl+Alt+Shift+S`): functions that mention every given symbol |
| Ctrl-click on `#include` | Opens the header from the project's include index |
| Go to Declaration / signature help | Prototypes via Go to Declaration; `name(` shows the parameter list from the index |

References and rename are **context-sensitive** like Source Insight: after the name index narrows the
candidate files, each file is parsed and occurrences that are really a same-named local, parameter
or another type's member are dropped (up to 250 files; beyond that results stay name-based).

Files are decoded with the editor's `files.encoding` (GBK, Big5, Shift-JIS ... all work), so columns line up.

Everything stays in sync automatically: saving a file, or an external change (git checkout),
re-indexes only that file. Open documents are parsed incrementally as you type.

**Types and scope.** `int c` and `float c` do not get mixed up. The identifier under the cursor is
first looked up as a local or parameter in the current file's syntax tree; `p->c` resolves the type
of `p` (local, global, member chain, cast, function return) and then the exact struct member; only
global names fall back to name lookup, preferring same-file definitions. Cross-file member
reference counts are still by name, as in Source Insight.

## Getting started

1. Open a C/C++ workspace.
2. Run **SI: Build Project** from the command palette (or click the prompt).
3. Put the cursor on a function. The Context view and Relations panel update.
   `Ctrl+Alt+R` re-centres the Relations panel on the symbol under the cursor.
4. In the graph: click a node to open it, double-click to make it the new centre, click an edge
   to jump to the call site.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `siLite.include` | `**/*.{c,h,cpp,cc,cxx,hpp,hh,hxx,inl}` | Files that belong to the project |
| `siLite.exclude` | node_modules, .git, build, out, dist, .cache | Files to skip |
| `siLite.headerLanguage` | `cpp` | Grammar for `.h` files |
| `siLite.indexReferences` | `true` | Record every identifier use (needed for Find References). Turn off on very large trees |
| `siLite.autoBuildOnOpen` | `false` | Sync automatically when the workspace opens |
| `siLite.relationDepth` | `1` | Default graph depth |
| `siLite.relationFollowCursor` | `true` | Relations panel follows the cursor |
| `siLite.maxGraphNodes` | `150` | Cap on graph size |
| `siLite.provideHover` | `true` | Signature + location on hover |
| `siLite.language` | `auto` | `auto` follows the VS Code display language; `zh-cn` / `en` force one for messages, the Context view and the Relations panel |
| `siLite.semanticHighlighting` | `true` | Semantic colouring of identifiers |
| `siLite.parallelism` | `0` | Parse threads for a full build; 0 = automatic |
| `siLite.externalPaths` | `[]` | Extra directories outside the workspace to index (SDK / HAL headers), like Source Insight external libraries |
| `siLite.keymap` | `default` | `default` (Ctrl+Alt combos plus F8 = highlight word), `sourceInsight` (Ctrl+= definition, Ctrl+/ references, F7 symbols, F8 highlight word, Alt+, / Alt+.), or `none`. All bindings apply only inside C/C++ editors |
| `siLite.ignoreMacros` | FFmpeg / Linux / Win32 decorators | Attribute-like macros blanked before parsing (`av_cold`, `__init`, `WINAPI`...). Without this `static void av_cold f()` loses its name. Add your project's own |

## How it works

```
src/core/        vscode-free, unit tested with plain Node
  languages.ts   tree-sitter queries per grammar
  extractor.ts   syntax tree -> symbols / references / includes
  store.ts       SQLite schema and queries (sql.js)
  graph.ts       BFS builders for call and include graphs
  worker.ts      full builds run here, off the extension host thread
  resolver.ts    scope/type-aware resolution on the current file's tree
src/docTree.ts   syntax trees of open documents, incremental re-parse on edit
src/indexer.ts   workspace scan, incremental sync, file watcher
src/editorFeatures.ts outline / highlight / completion / rename / type hierarchy
src/semanticTokens.ts semantic colouring
src/providers.ts definition / references / hover / workspace symbols / call hierarchy
src/views/       symbol tree, Context webview, Relations webview
webview/         browser side of the Relations panel (Cytoscape + dagre)
```

Symbol resolution is name based, like Source Insight: a call to `foo` links to every definition
named `foo`, preferring functions and macros over prototypes. That is what makes it work on code
that does not build, and it is also why overloaded C++ functions are grouped, not distinguished.

## Scale (FFmpeg, 4,690 files, 1.85M lines, Windows laptop)

| | |
|---|---|
| Full build | ~25 s (4 parse threads + 1 database thread); the editor never stalls more than a few ms |
| Symbols / references | 135k / 2.9M |
| Database on disk | ~195 MB (55 MB with `siLite.indexReferences` off) |
| Extension host memory after build | ~450 MB (peaks ~1.1 GB while the workers hand over) |
| Definition / hover / 4k references | 130 ms / 150 ms / 230 ms |
| Re-sync with nothing changed | ~1.4 s |

`npm run bench -- <dir>` runs the core pipeline on any tree and prints these numbers.

## Development

```
npm install
npm run build          # bundle extension + webview, copy wasm
npm run typecheck
npm run test:core      # core pipeline in plain Node
npm run test:vscode    # integration suite in a real (downloaded) VS Code
node test/runTest.mjs --suite=suite-ffmpeg --workspace=bench/ffmpeg   # stress run on a big tree
npm run package        # produce .vsix
```

Press F5 in VS Code to launch the Extension Development Host.

## Credits

Icons in the webviews come from [VS Code Codicons](https://github.com/microsoft/vscode-codicons) (CC-BY-4.0).

## Limitations

- Macro bodies are not parsed, so calls made from inside a macro are not recorded.
- Conditional compilation is ignored: all `#if` branches are indexed.
- C++ overloads and templates share a name entry.
- Columns are UTF-16 based; lines are always correct.
