import { walkTree } from './nodes.ts';
import type { TSNode } from './parser.ts';

/** Statement blocks of every `assembly(name, () => {...})` call in the file. */
export function assemblyBodies(root: TSNode): TSNode[] {
  const bodies: TSNode[] = [];
  for (const node of walkTree(root)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'identifier' || fn.text !== 'assembly') {
      continue;
    }
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];
    const callback = args.find(a => a.type === 'arrow_function' || a.type === 'function_expression');
    const body = callback?.childForFieldName('body');
    if (body?.type === 'statement_block') {
      bodies.push(body);
    }
  }
  return bodies;
}

/** The statements that determine where new inserts land and which variables they can see. */
export function assemblyInsertAnchors(body: TSNode): { lastInsert: TSNode | null; returnStmt: TSNode | null; lastStmt: TSNode | null } {
  const statements = body.namedChildren.filter(c => c.type !== 'comment');
  const insertStmts = statements.filter(s =>
    /^(const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*)?insert\s*\(/.test(s.text));
  const lastInsert = insertStmts[insertStmts.length - 1] ?? null;
  const returnStmt = statements.find(c => c.type === 'return_statement') ?? null;
  const lastStmt = statements[statements.length - 1] ?? null;

  return { lastInsert, returnStmt, lastStmt };
}

/**
 * The object literal an `assembly()` body returns — the parts it exposes to
 * the file that inserts it — or null when the body returns nothing or
 * something else.
 */
export function returnedParts(body: TSNode): TSNode | null {
  const returnStmt = body.namedChildren.find(c => c.type === 'return_statement');
  let value = returnStmt?.namedChildren.find(c => c.type !== 'comment') ?? null;
  if (value?.type === 'parenthesized_expression') {
    value = value.namedChildren[0] ?? null;
  }
  return value?.type === 'object' ? value : null;
}
