// Top-level declarations: where they anchor and how new ones land.

import { findLastImport } from './imports.ts';
import { spliceCode } from './lines.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';
import { findTopLevelUnitStatement } from './units.ts';

/**
 * Where a generated top-level declaration goes: after the last import, or
 * after the file's `unit()` statement when that sits below the imports.
 * `unit()` must stay the first statement after the imports (before any
 * geometry, and above `param()` declarations by convention), so nothing is
 * ever inserted between the imports and it.
 */
export function findTopLevelDeclarationAnchor(tree: TSTree): TSNode | null {
  const lastImport = findLastImport(tree);
  const unitStatement = findTopLevelUnitStatement(tree);
  if (unitStatement && (!lastImport || unitStatement.endIndex > lastImport.endIndex)) {
    return unitStatement;
  }
  return lastImport;
}

/**
 * Insert `const name = initializer;` at top level, directly after the last
 * import — or after the file's `unit()` statement, which keeps its place
 * right under the imports — or as the file's first line. Param declarations
 * land here, one shared spot, rather than inside a sketch body.
 */
export async function declareTopLevelVariable(
  code: string,
  name: string,
  initializer: string,
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  return declareTopLevelStatements(code, tree, [`const ${name} = ${initializer};`]);
}

/** Splice `statements` at the top-level declaration anchor (see {@link findTopLevelDeclarationAnchor}). */
export function declareTopLevelStatements(code: string, tree: TSTree, statements: string[]): string {
  const anchor = findTopLevelDeclarationAnchor(tree);
  const text = statements.join('\n');
  if (anchor) {
    return spliceCode(code, anchor.endIndex, anchor.endIndex, `\n${text}`);
  }
  return `${text}\n${code}`;
}
