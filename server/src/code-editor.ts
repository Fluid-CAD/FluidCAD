import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

type TSNode = {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: TSNode | null;
  descendantForPosition(pos: { row: number; column: number }): TSNode | null;
};

type TSParser = {
  setLanguage(lang: any): void;
  parse(code: string): { rootNode: TSNode };
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

async function getParser(): Promise<TSParser> {
  if (parser) {
    return parser;
  }
  const TreeSitter = await loadTreeSitter();
  await TreeSitter.init();
  parser = new TreeSitter();
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(
    thisDir, '..', '..',
    'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-javascript.wasm',
  );
  const lang = await TreeSitter.Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser;
}

/** True if the row in `code` is empty or whitespace-only. */
function isBlankRow(code: string, row: number): boolean {
  const lines = code.split('\n');
  const line = lines[row];
  return line === undefined || line.trim() === '';
}

/**
 * Given source text and a 0-indexed reference row (cursor line, or the
 * source line of a scene object), return the 0-indexed line at which a
 * breakpoint() call should be inserted — i.e., the row immediately after
 * the enclosing top-level statement ends.
 *
 * "Top-level statement" here means a node whose parent is the program
 * root or a statement_block (so breakpoints inside a function / callback
 * body still land after the enclosing statement within that body).
 *
 * Falls back to referenceRow + 1 if nothing useful can be resolved.
 */
export async function findBreakpointInsertLine(code: string, referenceRow: number): Promise<number> {
  const p = await getParser();
  const tree = p.parse(code);
  const root = tree.rootNode;

  // If the reference row itself is blank, walk backward to the nearest
  // non-blank row so we resolve a meaningful node.
  let row = referenceRow;
  while (row >= 0 && isBlankRow(code, row)) {
    row--;
  }
  if (row < 0) {
    return referenceRow + 1;
  }

  let node: TSNode | null = root.descendantForPosition({ row, column: 0 });
  if (!node || node === root) {
    return referenceRow + 1;
  }

  // Walk up until the parent is a program root or a block — that makes
  // the current node the top-level statement inside its enclosing scope.
  let current: TSNode | null = node;
  while (current?.parent) {
    const pt = current.parent.type;
    if (pt === 'program' || pt === 'statement_block') {
      break;
    }
    current = current.parent;
  }

  if (!current) {
    return referenceRow + 1;
  }

  return current.endPosition.row + 1;
}
