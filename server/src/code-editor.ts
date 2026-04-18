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

const BREAKPOINT_LINE = /^(\s*)breakpoint\s*\(\s*\)\s*;?\s*$/;
const FLUIDCAD_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]fluidcad(?:\/core)?['"]\s*;?/;
const POINT_LITERAL = /\[([^\]]+)\]/g;

export type BreakpointEditResult = { newCode: string; breakpointLine: number | null };
export type CodeEditResult = { newCode: string };

function splitLines(code: string): string[] {
  return code.split('\n');
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function isBlankRow(lines: string[], row: number): boolean {
  const line = lines[row];
  return line === undefined || line.trim() === '';
}

function lineHasBreakpoint(lines: string[], row: number): boolean {
  if (row < 0 || row >= lines.length) {
    return false;
  }
  return BREAKPOINT_LINE.test(lines[row]);
}

function indentOf(lines: string[], row: number): string {
  if (row < 0 || row >= lines.length) {
    return '';
  }
  const m = lines[row].match(/^(\s*)/);
  return m ? m[1] : '';
}

/**
 * Resolve `sourceLine` (1-indexed) to a 0-indexed row containing code.
 * Walks back over blank rows so callers can target the actual statement
 * even when the live-update reported a trailing blank line.
 */
function resolveSourceRow(lines: string[], sourceLine: number): number {
  let row = sourceLine - 1;
  if (row < 0) {
    return -1;
  }
  if (row >= lines.length) {
    row = lines.length - 1;
  }
  while (row >= 0 && lines[row].trim() === '') {
    row--;
  }
  return row;
}

/**
 * Tree-sitter resolution: given a 0-indexed reference row, return the row
 * immediately after the enclosing top-level statement ends.
 *
 * "Top-level" = parent is the program root or a statement_block, so
 * breakpoints inside a function body still land after the enclosing
 * statement within that body.
 */
async function findBreakpointInsertLine(code: string, referenceRow: number): Promise<number> {
  const p = await getParser();
  const tree = p.parse(code);
  const root = tree.rootNode;
  const lines = splitLines(code);

  let row = referenceRow;
  while (row >= 0 && isBlankRow(lines, row)) {
    row--;
  }
  if (row < 0) {
    return referenceRow + 1;
  }

  const node: TSNode | null = root.descendantForPosition({ row, column: 0 });
  if (!node || node === root) {
    return referenceRow + 1;
  }

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

/**
 * Add `breakpoint` to an existing `import { ... } from 'fluidcad/core'`
 * statement, or insert a new import line at the top. Returns the new code
 * plus how many lines were added at the top (0 or 1).
 */
function ensureBreakpointImport(code: string): { newCode: string; lineShift: number } {
  const match = code.match(FLUIDCAD_IMPORT);
  if (match) {
    const names = match[1];
    if (/\bbreakpoint\b/.test(names)) {
      return { newCode: code, lineShift: 0 };
    }
    const braceOffset = match.index! + match[0].indexOf('{') + 1;
    const needsSpace = names.length > 0 && !/^\s/.test(names);
    const insertText = needsSpace ? ' breakpoint,' : 'breakpoint,';
    const newCode = code.slice(0, braceOffset) + insertText + code.slice(braceOffset);
    return { newCode, lineShift: 0 };
  }
  const importLine = `import { breakpoint } from 'fluidcad/core';\n`;
  return { newCode: importLine + code, lineShift: 1 };
}

/**
 * Insert `breakpoint();` into the lines array at `row`. Adds a blank line
 * after if the following line is non-blank. Returns the row where the
 * statement landed.
 */
function insertBreakpointLine(lines: string[], row: number, indent: string): number {
  const breakpointText = `${indent}breakpoint();`;
  if (row >= lines.length) {
    lines.push(breakpointText);
    return lines.length - 1;
  }
  const following = lines[row];
  if (following !== undefined && following.trim() !== '') {
    lines.splice(row, 0, breakpointText, '');
  } else {
    lines.splice(row, 0, breakpointText);
  }
  return row;
}

export async function addBreakpoint(code: string, referenceRow: number): Promise<BreakpointEditResult> {
  const insertLine = await findBreakpointInsertLine(code, referenceRow);
  const lines = splitLines(code);

  if (lineHasBreakpoint(lines, insertLine)) {
    return { newCode: code, breakpointLine: insertLine };
  }

  const indentRow = Math.max(0, Math.min(insertLine - 1, lines.length - 1));
  const indent = indentOf(lines, indentRow);

  const insertedRow = insertBreakpointLine(lines, insertLine, indent);
  const interim = joinLines(lines);

  const { newCode, lineShift } = ensureBreakpointImport(interim);
  return { newCode, breakpointLine: insertedRow + lineShift };
}

export async function removeBreakpoint(code: string, line: number): Promise<BreakpointEditResult> {
  const lines = splitLines(code);
  if (!lineHasBreakpoint(lines, line)) {
    return { newCode: code, breakpointLine: null };
  }
  lines.splice(line, 1);
  return { newCode: joinLines(lines), breakpointLine: null };
}

export async function toggleBreakpoint(code: string, cursorRow: number): Promise<BreakpointEditResult> {
  const lines = splitLines(code);
  if (lineHasBreakpoint(lines, cursorRow)) {
    return removeBreakpoint(code, cursorRow);
  }
  if (lineHasBreakpoint(lines, cursorRow + 1)) {
    return removeBreakpoint(code, cursorRow + 1);
  }
  return addBreakpoint(code, cursorRow);
}

export async function clearBreakpoints(code: string): Promise<CodeEditResult> {
  const lines = splitLines(code);
  const filtered: string[] = [];
  for (const line of lines) {
    if (!BREAKPOINT_LINE.test(line)) {
      filtered.push(line);
    }
  }
  return { newCode: joinLines(filtered) };
}

// ---------------------------------------------------------------------------
// Point / pick edits — line-level transformations on the function call that
// ends on the resolved source row.
// ---------------------------------------------------------------------------

export async function insertPoint(
  code: string,
  sourceLine: number,
  point: [number, number],
): Promise<CodeEditResult> {
  const lines = splitLines(code);
  const row = resolveSourceRow(lines, sourceLine);
  if (row < 0) {
    return { newCode: code };
  }
  const lineText = lines[row];
  const closeParen = lineText.lastIndexOf(')');
  if (closeParen < 0) {
    return { newCode: code };
  }
  const openParen = lineText.lastIndexOf('(', closeParen);
  if (openParen < 0) {
    return { newCode: code };
  }
  const between = lineText.substring(openParen + 1, closeParen).trim();
  const prefix = between.length > 0 ? ', ' : '';
  const pointText = `[${point[0]}, ${point[1]}]`;
  lines[row] = lineText.slice(0, closeParen) + `${prefix}${pointText}` + lineText.slice(closeParen);
  return { newCode: joinLines(lines) };
}

export async function addPick(code: string, sourceLine: number): Promise<CodeEditResult> {
  const lines = splitLines(code);
  const row = resolveSourceRow(lines, sourceLine);
  if (row < 0) {
    return { newCode: code };
  }
  const lineText = lines[row];
  if (lineText.includes('.pick(')) {
    return { newCode: code };
  }
  const closeParen = lineText.lastIndexOf(')');
  if (closeParen < 0) {
    return { newCode: code };
  }
  lines[row] = lineText.slice(0, closeParen + 1) + '.pick()' + lineText.slice(closeParen + 1);
  return { newCode: joinLines(lines) };
}

export async function removePoint(
  code: string,
  sourceLine: number,
  point: [number, number],
): Promise<CodeEditResult> {
  const lines = splitLines(code);
  const row = resolveSourceRow(lines, sourceLine);
  if (row < 0) {
    return { newCode: code };
  }
  const lineText = lines[row];
  const closeParen = lineText.lastIndexOf(')');
  if (closeParen < 0) {
    return { newCode: code };
  }
  const openParen = lineText.lastIndexOf('(', closeParen);
  if (openParen < 0) {
    return { newCode: code };
  }
  const argsStr = lineText.substring(openParen + 1, closeParen);
  const matches = [...argsStr.matchAll(POINT_LITERAL)];
  if (matches.length === 0) {
    return { newCode: code };
  }

  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < matches.length; i++) {
    const parts = matches[i][1].split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const dx = parts[0] - point[0];
      const dy = parts[1] - point[1];
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
  }

  const match = matches[bestIndex];
  const matchStart = openParen + 1 + match.index!;
  const matchEnd = matchStart + match[0].length;

  let deleteStart = matchStart;
  let deleteEnd = matchEnd;

  if (matches.length === 1) {
    // Only point — strip just the literal.
  } else if (bestIndex === 0) {
    const rest = lineText.substring(deleteEnd);
    const commaMatch = rest.match(/^,\s*/);
    if (commaMatch) {
      deleteEnd += commaMatch[0].length;
    }
  } else {
    const before = lineText.substring(0, matchStart);
    const commaMatch = before.match(/,\s*$/);
    if (commaMatch) {
      deleteStart = matchStart - commaMatch[0].length;
    }
  }

  lines[row] = lineText.slice(0, deleteStart) + lineText.slice(deleteEnd);
  return { newCode: joinLines(lines) };
}

export async function setPickPoints(
  code: string,
  sourceLine: number,
  points: [number, number][],
): Promise<CodeEditResult> {
  const lines = splitLines(code);
  const row = resolveSourceRow(lines, sourceLine);
  if (row < 0) {
    return { newCode: code };
  }
  const lineText = lines[row];
  const closeParen = lineText.lastIndexOf(')');
  if (closeParen < 0) {
    return { newCode: code };
  }
  const openParen = lineText.lastIndexOf('(', closeParen);
  if (openParen < 0) {
    return { newCode: code };
  }
  const newArgs = points.map((p) => `[${p[0]}, ${p[1]}]`).join(', ');
  lines[row] = lineText.slice(0, openParen + 1) + newArgs + lineText.slice(closeParen);
  return { newCode: joinLines(lines) };
}
