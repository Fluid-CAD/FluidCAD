// Line and splice primitives over source text.

export type CodeEditResult = { newCode: string };

export function splitLines(code: string): string[] {
  return code.split('\n');
}

export function joinLines(lines: string[]): string {
  return lines.join('\n');
}

export function isBlankRow(lines: string[], row: number): boolean {
  const line = lines[row];
  return line === undefined || line.trim() === '';
}

export function indentOf(lines: string[], row: number): string {
  if (row < 0 || row >= lines.length) {
    return '';
  }
  const m = lines[row].match(/^(\s*)/);
  return m ? m[1] : '';
}

export function spliceCode(code: string, startIndex: number, endIndex: number, replacement: string): string {
  return code.slice(0, startIndex) + replacement + code.slice(endIndex);
}

// ---------------------------------------------------------------------------
// Point / pick edits — AST-driven transformations. `sourceLine` locates the
// outermost call_expression on that row; edits operate on the node's
// startIndex/endIndex so multi-line calls are handled the same as single-line.
// ---------------------------------------------------------------------------

/**
 * Resolve `sourceLine` (1-indexed) to a 0-indexed row containing code.
 * Walks back over blank rows to match the existing extension behaviour.
 */
export function resolveSourceRow(lines: string[], sourceLine: number): number {
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
 * Walk forward from `from` over whitespace; if a `,` follows, consume it
 * and any trailing whitespace. Returns the index up to which to delete
 * when stripping a non-last argument.
 */
export function consumeTrailingSeparator(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) {
    i++;
  }
  if (i < code.length && code[i] === ',') {
    i++;
    while (i < code.length && /\s/.test(code[i])) {
      i++;
    }
    return i;
  }
  return from;
}

/**
 * Walk backward from `to` over whitespace; if a `,` precedes, consume it
 * and any preceding whitespace. Returns the index from which to start
 * deleting when stripping a non-first argument.
 */
export function consumeLeadingSeparator(code: string, to: number): number {
  let i = to;
  while (i > 0 && /\s/.test(code[i - 1])) {
    i--;
  }
  if (i > 0 && code[i - 1] === ',') {
    i--;
    while (i > 0 && /\s/.test(code[i - 1])) {
      i--;
    }
    return i;
  }
  return to;
}

// ---------------------------------------------------------------------------
// Load insertion — append a load() call for a freshly imported model
// ---------------------------------------------------------------------------

/** Escape a file name for embedding in a single-quoted JS string literal. */
export function quoteForSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export type SpliceEdit = { start: number; end: number; text: string };

/** Apply edits over disjoint ranges, splicing back-to-front. */
export function applySpliceEdits(code: string, edits: SpliceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of sorted) {
    result = spliceCode(result, edit.start, edit.end, edit.text);
  }
  return result;
}
