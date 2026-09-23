// The tree-sitter JavaScript parser: node/tree types and the lazily loaded parser instance.

import path from 'path';

export type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  previousNamedSibling: TSNode | null;
  namedChildren: TSNode[];
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  descendantForPosition(pos: { row: number; column: number }): TSNode | null;
};

export type TSTree = { rootNode: TSNode };

type TSParser = {
  setLanguage(lang: any): void;
  parse(code: string): TSTree;
};

async function loadTreeSitter() {
  const mod = await import('web-tree-sitter');
  // v0.24.x: default export IS the Parser class with .init() and .Language.
  return mod.default as any as {
    init(): Promise<void>;
    new(): TSParser;
    Language: { load(path: string): Promise<any> };
  };
}

let parser: TSParser | null = null;

/**
 * Public alias for `getParser()` so other modules in this package (e.g.
 * `lint-fluid-js.ts`) can reuse the same wasm-backed parser instance instead
 * of loading the JavaScript grammar twice.
 */
export async function getJavaScriptParser(): Promise<TSParser> {
  return getParser();
}

export async function getParser(): Promise<TSParser> {
  if (parser) {
    return parser;
  }
  const TreeSitter = await loadTreeSitter();
  await TreeSitter.init();
  const fresh = new TreeSitter();
  // The JavaScript grammar is vendored in this package (`server/vendor/`)
  // rather than pulled from `tree-sitter-wasms`, which ships 50 MB of grammars
  // for every language to deliver the one file we load. Resolving it against
  // our own directory — the same trick `UI_DIST` uses in `index.ts` — works
  // from `server/src/code-editor` (the --experimental-transform-types dev
  // path) and from `server/dist/code-editor` (the packaged build) alike, since
  // both sit two levels under `server/`. This must not regress to a lookup
  // that depends on where npm
  // hoisted a dependency: that is what broke the earlier relative-path
  // approach when fluidcad was installed from npm.
  const wasmPath = path.resolve(import.meta.dirname, '../../vendor/tree-sitter-javascript.wasm');
  const lang = await TreeSitter.Language.load(wasmPath);
  fresh.setLanguage(lang);
  // Cache only after the language is attached: a parser cached mid-init would
  // make every later parse() throw an opaque "Parsing failed" instead of the
  // load error that actually broke it.
  parser = fresh;
  return parser;
}
