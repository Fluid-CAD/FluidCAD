// The document's unit() statement: reading, setting and clearing it.

import { parseProjectUnit } from '../project-config.ts';
import { ASSEMBLY_UNIT_MESSAGE, unknownUnitMessage } from '../unit-lint.ts';
import { countIdentifierUses, ensureSymbolImport, findLastImport, removeSymbolImport } from './imports.ts';
import { spliceCode, type CodeEditResult } from './lines.ts';
import { removeStatementLine } from './nodes.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';

/**
 * Recognise a `unit('in');` statement: an expression_statement wrapping a
 * call to the bare identifier `unit` with exactly one string-literal
 * argument. The literal form is the only legal one (a document's unit must
 * be readable without running the file), so a `unit(someVar)` is not a unit
 * statement here — the lint reports it instead.
 */
export function isUnitStatement(node: TSNode): boolean {
  if (node.type !== 'expression_statement') {
    return false;
  }
  const call = node.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'identifier' || fn.text !== 'unit') {
    return false;
  }
  const args = call.childForFieldName('arguments');
  if (!args || args.namedChildren.length !== 1) {
    return false;
  }
  return args.namedChildren[0].type === 'string';
}

/** The literal a unit statement declares (`unit('in')` → `in`), quotes stripped. */
export function unitStatementLiteral(node: TSNode): string {
  const literal = node.namedChild(0)!.childForFieldName('arguments')!.namedChildren[0];
  return literal.text.slice(1, -1);
}

/** The file's first top-level unit statement, if any. */
export function findTopLevelUnitStatement(tree: TSTree): TSNode | null {
  for (const node of tree.rootNode.namedChildren) {
    if (isUnitStatement(node)) {
      return node;
    }
  }
  return null;
}

export type UnitStatement = {
  /** The declared literal, verbatim — validation is the lint's job. */
  unit: string;
  /** Zero-based row the statement starts on. */
  row: number;
  startIndex: number;
  endIndex: number;
};

/**
 * Read a file's `unit('…')` declaration without executing it — the first
 * top-level one, which is the only one the runtime accepts. Null when the
 * file declares none (an mm document, or one on the project unit).
 */
export async function readUnitStatement(code: string): Promise<UnitStatement | null> {
  const p = await getParser();
  const node = findTopLevelUnitStatement(p.parse(code));
  if (!node) {
    return null;
  }
  return {
    unit: unitStatementLiteral(node),
    row: node.startPosition.row,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  };
}

/** The set-unit transform can refuse (assembly file, unknown unit) — the
 * refusal rides `error` beside the untouched code, like apply-feature. */
export type SetUnitResult = CodeEditResult & { error?: string };

/**
 * Make a part file declare `unit('<unit>')` — the literal only, never the
 * numbers (a document's numbers ARE its unit; docs/unit-system-plan.md §2).
 * An existing top-level statement has its literal replaced in place, so
 * comments and quote style around it survive; a file without one gets
 * `unit('…');` directly after its last import — the spot
 * `findTopLevelDeclarationAnchor` treats as the unit's home, above any
 * `param()` declarations — and `unit` added to the core import. `filePath`,
 * when given, refuses assembly files: their lengths are in the project unit
 * and the runtime would reject the statement anyway.
 *
 * `unit: null` un-declares instead — the chip's "Same as project" pick: the
 * statement's line goes, and `unit` leaves the core import when nothing
 * else in the file uses the identifier (see `clearDocumentUnit`).
 */
export async function setDocumentUnit(code: string, unit: string | null, filePath?: string): Promise<SetUnitResult> {
  if (typeof filePath === 'string' && /\.assembly\.js$/i.test(filePath)) {
    return { newCode: code, error: ASSEMBLY_UNIT_MESSAGE };
  }
  if (unit === null) {
    return { newCode: await clearDocumentUnit(code) };
  }
  const canonical = parseProjectUnit(unit);
  if (canonical === null) {
    return { newCode: code, error: unknownUnitMessage(String(unit)) };
  }
  const p = await getParser();
  const tree = p.parse(code);
  const existing = findTopLevelUnitStatement(tree);
  if (existing) {
    const literal = existing.namedChild(0)!.childForFieldName('arguments')!.namedChildren[0];
    if (literal.text.slice(1, -1) === canonical) {
      return { newCode: code };
    }
    // Keep the author's quote character; only the word inside changes.
    const quote = literal.text[0] === '"' ? '"' : "'";
    return { newCode: spliceCode(code, literal.startIndex, literal.endIndex, `${quote}${canonical}${quote}`) };
  }
  const statement = `unit('${canonical}');`;
  const lastImport = findLastImport(tree);
  const withStatement = lastImport
    ? spliceCode(code, lastImport.endIndex, lastImport.endIndex, `\n${statement}`)
    : `${statement}\n${code}`;
  // Import second: it splices after the last import, i.e. above the
  // statement just placed there, so "imports, then unit()" holds either way.
  return { newCode: await ensureSymbolImport(withStatement, 'unit', 'fluidcad/core') };
}

/**
 * Remove a file's top-level `unit('…')` statement so it follows the project
 * unit again. The whole line goes (a unit statement owns its line — it was
 * placed that way and the runtime wants it alone before any geometry), and
 * `unit` is dropped from the core import unless another `unit` identifier
 * is still in use somewhere. A file that declares none is returned as is,
 * so the caller can skip the write.
 */
export async function clearDocumentUnit(code: string): Promise<string> {
  const p = await getParser();
  const statement = findTopLevelUnitStatement(p.parse(code));
  if (!statement) {
    return code;
  }
  const withoutStatement = removeStatementLine(code, statement);
  if (countIdentifierUses(p.parse(withoutStatement), 'unit') > 0) {
    return withoutStatement;
  }
  return removeSymbolImport(withoutStatement, 'unit', 'fluidcad/core');
}
