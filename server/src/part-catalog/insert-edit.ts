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

/** JSON-safe values a `param()` can resolve to — what the dialog form produces. */
export type InsertParamValue = string | number | boolean | (string | number)[];

export type InsertPartEntry = {
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
  /**
   * NON-DEFAULT parameter values, rendered as insert()'s second argument
   * (`insert(extrusion, { Size: '80x80', Length: 540 })`). The dialog diffs
   * against the scanned defaults before posting; an absent/empty map renders
   * the plain single-argument form.
   */
  params?: Record<string, InsertParamValue>;
};

/**
 * The Insert dialog's edit payload — rides `ApplyFeatureEditSpec` as a
 * side-channel (like `paramEdit`/`segmentSwap`): every other spec field is
 * ignored and the transform below runs instead. A BATCH: the dialog's whole
 * basket lands as one transform → one editor round trip → one re-render.
 */
export type InsertPartEditSpec = {
  inserts: InsertPartEntry[];
};

/**
 * Append the statements that bring the chosen catalog exports into the
 * assembly file, importing each export (and `insert`) as needed:
 *
 *     import { extrusion } from './extrusion.fluid.js';
 *     const extrusion1 = insert(extrusion, { Size: '80x80', Length: 540 });
 *     const extrusion2 = insert(extrusion, { Size: '80x80', Length: 540 });
 *
 * Every entry is bound to a fresh `const` so the follow-up flows (translate
 * chains, mates, sub-assembly part paths) have a name to reference; names
 * number against the evolving code, so one batch never collides with itself.
 *
 * All-or-nothing: entries validate up front and the transform refuses the
 * whole batch on the first bad one — a half-applied basket would be worse
 * than a clean error.
 *
 * Definition-style files — the file's statements live inside a single
 * `assembly('name', () => {...})` body — get the statements INSIDE that body
 * (after its last insert(), else before its `return`): a top-level append
 * there would run at module scope instead of in the assembly's frame.
 * Entry-style files (no assembly() body, or several — ambiguous) keep the
 * top-level append.
 */
export async function applyInsertPartEdit(
  code: string,
  spec: InsertPartEditSpec,
): Promise<{ newCode: string; error?: string }> {
  const entries = spec.inserts;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { newCode: code, error: 'No inserts in the request.' };
  }
  for (const entry of entries) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry.exportName)) {
      return { newCode: code, error: `"${entry.exportName}" is not an importable identifier` };
    }
    const bad = findInvalidParam(entry.params);
    if (bad) {
      return { newCode: code, error: `Parameter '${bad}' of ${entry.exportName} has an unsupported value.` };
    }
  }

  let out = code;
  for (const entry of entries) {
    if (entry.importFrom) {
      out = await ensureSymbolImport(out, entry.exportName, entry.importFrom);
    }
    out = await ensureSymbolImport(out, 'insert');

    const varName = pickInstanceName(out, entry.exportName);
    const callSuffix = entry.kind === 'value' ? '' : '()';
    const paramsLiteral = renderParamsLiteral(entry.params);
    const statement =
      `const ${varName} = insert(${entry.exportName}${callSuffix}${paramsLiteral ? `, ${paramsLiteral}` : ''});`;

    const parser = await getJavaScriptParser();
    const tree = parser.parse(out);

    const bodies = assemblyBodies(tree.rootNode);
    if (bodies.length === 1) {
      out = appendInsideBody(out, bodies[0], statement);
      continue;
    }

    const lines = splitLines(out);
    const children = tree.rootNode.namedChildren;
    const last = children[children.length - 1];
    const insertRow = last ? last.endPosition.row + 1 : lines.length;
    const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1);
    lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
    out = joinLines(lines);
  }
  return { newCode: out };
}

/** The first param label whose value can't render as a literal, if any. */
export function findInvalidParam(params: Record<string, InsertParamValue> | undefined): string | null {
  if (params == null) {
    return null;
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    return '(params)';
  }
  for (const [label, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      continue;
    }
    if (Array.isArray(value)
      && value.every(v => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) {
      continue;
    }
    return label;
  }
  return null;
}

/** `{ Size: '80x80', Length: 540 }` — empty/absent params render nothing. */
function renderParamsLiteral(params: Record<string, InsertParamValue> | undefined): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) {
    return '';
  }
  const rendered = entries.map(([label, value]) => `${renderKey(label)}: ${renderValue(value)}`);
  return `{ ${rendered.join(', ')} }`;
}

export function renderKey(label: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(label)) {
    return label;
  }
  return renderString(label);
}

export function renderValue(value: InsertParamValue): string {
  if (typeof value === 'string') {
    return renderString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => (typeof v === 'string' ? renderString(v) : String(v))).join(', ')}]`;
  }
  return String(value);
}

function renderString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
