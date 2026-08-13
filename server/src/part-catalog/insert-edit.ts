import {
  ensureSymbolImport,
  getJavaScriptParser,
  indentOf,
  isBlankRow,
  joinLines,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
} from '../code-editor.ts';

/** What the chosen catalog export is, deciding the statement rendered for it. */
export type InsertPartKind = 'value' | 'factory' | 'assembly';

/**
 * The Insert dialog's edit payload — rides `ApplyFeatureEditSpec` as a
 * side-channel (like `paramEdit`/`segmentSwap`): every other spec field is
 * ignored and the transform below runs instead.
 */
export type InsertPartEditSpec = {
  /**
   * Module specifier for the part's file relative to the assembly file
   * (`'./side-plate.part.js'`), or null when the export comes from the
   * assembly file itself — its export declaration is already a top-level
   * binding there, so no import is added.
   */
  importFrom: string | null;
  exportName: string;
  /**
   * 'value' renders `insert(name)` and 'factory' renders `insert(name())`
   * — for parts and assembly() definitions alike, since insert() accepts
   * both. 'assembly' is the legacy sub-assembly spelling and now renders
   * `insert(name())` too (a factory returning an assembly() definition);
   * old-style factories that inserted directly into the enclosing scene
   * throw a clear migration error from insert() itself.
   */
  kind: InsertPartKind;
};

/**
 * Append the statement that brings a catalog export into the assembly file,
 * importing the export (and `insert` when the statement uses it) as needed:
 *
 *     import { sidePlate } from './side-plate.part.js';
 *     const sidePlate1 = insert(sidePlate());
 *
 *     import { gantryAssembly } from './gantry.assembly.js';
 *     const gantryAssembly1 = insert(gantryAssembly());
 *
 * The result is always bound to a fresh `const` so the follow-up flows
 * (translate chains, mates, sub-assembly part paths) have a name to
 * reference.
 *
 * Definition-style files — the file's statements live inside a single
 * `assembly('name', () => {...})` body — get the statement INSIDE that body
 * (after its last insert(), else before its `return`): a top-level append
 * there would run at module scope instead of in the assembly's frame.
 * Entry-style files (no assembly() body, or several — ambiguous) keep the
 * top-level append.
 */
export async function applyInsertPartEdit(
  code: string,
  spec: InsertPartEditSpec,
): Promise<{ newCode: string; error?: string }> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(spec.exportName)) {
    return { newCode: code, error: `"${spec.exportName}" is not an importable identifier` };
  }
  let out = code;
  if (spec.importFrom) {
    out = await ensureSymbolImport(out, spec.exportName, spec.importFrom);
  }
  out = await ensureSymbolImport(out, 'insert');

  const varName = pickInstanceName(out, spec.exportName);
  const statement =
    `const ${varName} = insert(${spec.exportName}${spec.kind === 'value' ? '' : '()'});`;

  const parser = await getJavaScriptParser();
  const tree = parser.parse(out);

  const bodies = assemblyBodies(tree.rootNode);
  if (bodies.length === 1) {
    return { newCode: appendInsideBody(out, bodies[0], statement) };
  }

  const lines = splitLines(out);
  const children = tree.rootNode.namedChildren;
  const last = children[children.length - 1];
  const insertRow = last ? last.endPosition.row + 1 : lines.length;
  const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1);
  lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
  return { newCode: joinLines(lines) };
}

/** Statement blocks of every `assembly(name, () => {...})` call in the file. */
function assemblyBodies(root: TSNode): TSNode[] {
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

/**
 * Insert the statement inside an assembly body's statement block: grouped
 * directly under the last existing `insert()` chain, else before the
 * trailing `return`, else as the block's first statement (an empty
 * `() => {}` body is spliced open).
 */
function appendInsideBody(code: string, body: TSNode, statement: string): string {
  const lines = splitLines(code);
  const statements = body.namedChildren.filter(c => c.type !== 'comment');
  const insertStmts = statements.filter(s =>
    /^(const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*)?insert\s*\(/.test(s.text));
  const lastInsert = insertStmts[insertStmts.length - 1] ?? null;
  const returnStmt = statements.find(c => c.type === 'return_statement') ?? null;
  const lastStmt = statements[statements.length - 1] ?? null;

  if (lastInsert) {
    const row = lastInsert.endPosition.row + 1;
    lines.splice(row, 0, `${indentOf(lines, lastInsert.startPosition.row)}${statement}`);
    return joinLines(lines);
  }
  if (returnStmt) {
    const row = returnStmt.startPosition.row;
    lines.splice(row, 0, `${indentOf(lines, row)}${statement}`);
    return joinLines(lines);
  }
  if (lastStmt) {
    const row = lastStmt.endPosition.row + 1;
    lines.splice(row, 0, `${indentOf(lines, lastStmt.startPosition.row)}${statement}`);
    return joinLines(lines);
  }
  // Empty body — `() => {}` possibly on one line: splice the braces open.
  const baseIndent = indentOf(lines, body.startPosition.row);
  return spliceCode(
    code,
    body.startIndex + 1,
    body.endIndex - 1,
    `\n${baseIndent}    ${statement}\n${baseIndent}`,
  );
}

/**
 * A fresh instance variable name derived from the export: factory prefixes
 * drop and the first letter lowers (`getExtrusion` → `extrusion1`), then the
 * smallest numeric suffix not already appearing as a word in the file wins —
 * matching the `p1`/`rail2` style assemblies are written in.
 */
function pickInstanceName(code: string, exportName: string): string {
  let base = exportName
    .replace(/\$/g, '')
    .replace(/^(get|create|make|build)(?=[A-Z0-9_])/, '');
  base = base.charAt(0).toLowerCase() + base.slice(1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) {
    base = 'instance';
  }
  for (let n = 1; ; n++) {
    const candidate = `${base}${n}`;
    if (!new RegExp(`\\b${candidate}\\b`).test(code)) {
      return candidate;
    }
  }
}
