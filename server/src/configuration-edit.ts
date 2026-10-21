// The configurations panel writing the `configurations({ … })` table back to
// the source — docs/assembly-configurations-plan.md §3.2, §4.2. The table is
// one statement, first in the file's single `assembly()` (or `part()`)
// callback body: `const configuration = configurations({ Row: { Label:
// value, … }, … })`. Every operation here is a byte-range splice over the
// tree-sitter tree, with the same refusal contract as the other source
// editors: anything it cannot do safely leaves the code untouched and says why.

import {
  applySpliceEdits,
  ensureSymbolImport,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  LexicalBindings,
  removeSymbolImport,
  spliceCode,
  splitLines,
  statementRemovalEdit,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor/index.ts';
import { assemblyBodies } from './code-editor/assembly.ts';
import { bindingOfDeclarator, findBindingReferences } from './code-editor/binding-references.ts';
import { declaresName, isSameNode } from './code-editor/declaration-calls.ts';
import { countIdentifierUses } from './code-editor/imports.ts';
import {
  DEFAULT_CONFIGURATION_NAME,
  findInvalidParam,
  literalValueOf,
  renderKey,
  renderValue,
  stringLiteralText,
  type InsertParamValue,
  type ParamLiteralValue,
} from './part-catalog/insert-edit.ts';

export { DEFAULT_CONFIGURATION_NAME };

/**
 * One cell of the table as the panel reads it: `literal` when the source is
 * a plain value (number, string, boolean, array of those), else only `text`
 * — an expression the UI shows read-only, as the Edit-parameters dialog
 * does for insert overrides.
 */
export type ConfigurationCell = { literal?: ParamLiteralValue; text: string };

export type ConfigurationTable = {
  /** 1-based line the `configurations()` statement starts on. */
  line: number;
  /** Row name → label → cell, in source order. */
  rows: Record<string, Record<string, ConfigurationCell>>;
};

/** A value the panel writes into a cell — a literal, or `{ expr }` verbatim source. */
export type ConfigurationCellValue = InsertParamValue;

export type ConfigurationEditResult = { newCode: string } | { error: string };

/** The binding the generated statement takes, unless the file already uses the name. */
const RESULT_BINDING = 'configuration';

type Located = {
  tree: TSTree;
  body: TSNode;
  /** The statement holding the call, the call, and its table literal (null for a non-literal argument). */
  table: { statement: TSNode; call: TSNode; object: TSNode | null } | null;
};

type RowEntry = { entry: TSNode; key: TSNode | null; name: string; object: TSNode | null };

/**
 * Read and rewrite the `configurations({ … })` table of a model file.
 * Static, string-in/string-out, like {@link ParamEditor} — the route hands
 * the result through the ordinary apply-feature round trip.
 */
export class ConfigurationEditor {

  /**
   * The table as written, or null when the file has no addressable one: no
   * single definition body, no `configurations()` statement in it, or an
   * argument that is not an object literal.
   */
  static async readTable(code: string): Promise<ConfigurationTable | null> {
    const located = await ConfigurationEditor.locate(code);
    if ('error' in located || !located.table?.object) {
      return null;
    }
    const rows: Record<string, Record<string, ConfigurationCell>> = {};
    for (const row of rowEntries(located.table.object)) {
      if (!row.object) {
        continue;
      }
      const cells: Record<string, ConfigurationCell> = {};
      for (const cell of cellEntries(row.object)) {
        cells[cell.label] = cell.cell;
      }
      rows[row.name] = cells;
    }
    return { line: located.table.statement.startPosition.row + 1, rows };
  }

  /**
   * Append a row. Without a statement yet, the table is created as the
   * FIRST statement of the body — above every `param()`, where the runtime
   * requires it — and the `configurations` import is pulled in.
   */
  static async addRow(
    code: string,
    name: string,
    values: Record<string, ConfigurationCellValue> = {},
  ): Promise<ConfigurationEditResult> {
    const invalidName = validateRowName(name);
    if (invalidName) {
      return { error: invalidName };
    }
    const bad = findInvalidParam(values);
    if (bad) {
      return { error: `Parameter '${bad}' has an unsupported value.` };
    }
    const located = await ConfigurationEditor.locate(code);
    if ('error' in located) {
      return located;
    }
    const rendered = `${renderKey(name)}: ${renderRow(values)}`;
    if (!located.table) {
      const binding = declaresName(located.tree, RESULT_BINDING) ? '' : `const ${RESULT_BINDING} = `;
      const statement = [`${binding}configurations({`, `  ${rendered},`, `});`];
      const declared = prependToBody(code, splitLines(code), located.body, statement);
      return { newCode: await ensureSymbolImport(declared, 'configurations') };
    }
    if (!located.table.object) {
      return { error: NON_LITERAL_TABLE };
    }
    if (rowEntries(located.table.object).some((row) => row.name === name)) {
      return { error: `a configuration named "${name}" already exists` };
    }
    return { newCode: appendEntry(code, splitLines(code), located.table.object, rendered) };
  }

  /**
   * Set the named cells of a row as literals, adding the ones it lacks.
   * Every other cell keeps its source byte-for-byte, expressions included.
   */
  static async setCells(
    code: string,
    name: string,
    values: Record<string, ConfigurationCellValue>,
  ): Promise<ConfigurationEditResult> {
    const bad = findInvalidParam(values);
    if (bad) {
      return { error: `Parameter '${bad}' has an unsupported value.` };
    }
    let out = code;
    for (const [label, value] of Object.entries(values)) {
      const found = await ConfigurationEditor.locateRow(out, name);
      if ('error' in found) {
        return found;
      }
      const object = found.row.object!;
      const rendered = `${renderKey(label)}: ${renderValue(value)}`;
      const existing = cellEntries(object).find((cell) => cell.label === label);
      if (existing) {
        const valueNode = existing.entry.type === 'pair' ? existing.entry.childForFieldName('value') : null;
        out = valueNode
          ? spliceCode(out, valueNode.startIndex, valueNode.endIndex, renderValue(value))
          : spliceCode(out, existing.entry.startIndex, existing.entry.endIndex, rendered);
        continue;
      }
      out = appendEntry(out, splitLines(out), object, rendered);
    }
    return { newCode: out };
  }

  /** Remove the named cells of a row; a row left without cells stays as `Name: {}`. Absent labels no-op. */
  static async unsetCells(code: string, name: string, labels: string[]): Promise<ConfigurationEditResult> {
    let out = code;
    for (const label of labels) {
      const found = await ConfigurationEditor.locateRow(out, name);
      if ('error' in found) {
        return found;
      }
      const object = found.row.object!;
      const entries = namedEntries(object);
      const index = cellEntries(object).findIndex((cell) => cell.label === label);
      if (index === -1) {
        continue;
      }
      out = removeEntry(out, splitLines(out), object, entries, index);
    }
    return { newCode: out };
  }

  /** Rename a row, keeping its cells. */
  static async renameRow(code: string, from: string, to: string): Promise<ConfigurationEditResult> {
    const invalidName = validateRowName(to);
    if (invalidName) {
      return { error: invalidName };
    }
    const found = await ConfigurationEditor.locateRow(code, from);
    if ('error' in found) {
      return found;
    }
    if (to !== from && rowEntries(found.table.object!).some((row) => row.name === to)) {
      return { error: `a configuration named "${to}" already exists` };
    }
    const key = found.row.key!;
    return { newCode: spliceCode(code, key.startIndex, key.endIndex, renderKey(to)) };
  }

  /**
   * Remove a row. The last row takes the whole statement with it — and the
   * `configurations` import, once nothing else uses it — unless the body
   * reads the statement's result (`if (configuration === 'Wide')`), in
   * which case `configurations({})` stays so the read keeps its value.
   */
  static async removeRow(code: string, name: string): Promise<ConfigurationEditResult> {
    const found = await ConfigurationEditor.locateRow(code, name);
    if ('error' in found) {
      return found;
    }
    const { tree, table, row } = found;
    const object = table.object!;
    const entries = namedEntries(object);
    const lines = splitLines(code);
    if (entries.length > 1) {
      const index = entries.findIndex((entry) => isSameNode(entry, row.entry));
      return { newCode: removeEntry(code, lines, object, entries, index) };
    }
    if (resultIsRead(tree, table.statement)) {
      return { newCode: spliceCode(code, object.startIndex + 1, object.endIndex - 1, '') };
    }
    const removed = applySpliceEdits(code, [statementRemovalEdit(code, lines, table.statement)]);
    const parser = await getJavaScriptParser();
    if (countIdentifierUses(parser.parse(removed), 'configurations') === 0) {
      return { newCode: await removeSymbolImport(removed, 'configurations') };
    }
    return { newCode: removed };
  }

  // -------------------------------------------------------------------------
  // Locating
  // -------------------------------------------------------------------------

  /** The definition body and the table statement it holds, if any. */
  private static async locate(code: string): Promise<Located | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const body = definitionBody(tree.rootNode);
    if ('error' in body) {
      return body;
    }
    return { tree, body: body.body, table: findTable(body.body) };
  }

  /** The table and the row `name` addresses, refusing a missing or non-literal one. */
  private static async locateRow(
    code: string,
    name: string,
  ): Promise<(Located & { table: NonNullable<Located['table']>; row: RowEntry }) | { error: string }> {
    const located = await ConfigurationEditor.locate(code);
    if ('error' in located) {
      return located;
    }
    if (!located.table) {
      return { error: NO_TABLE };
    }
    if (!located.table.object) {
      return { error: NON_LITERAL_TABLE };
    }
    const row = rowEntries(located.table.object).find((candidate) => candidate.name === name);
    if (!row) {
      return { error: `no configuration named "${name}" — is the file in sync with the last render?` };
    }
    if (!row.key || !row.object) {
      return { error: `the configuration "${name}" is not written as an object literal — edit it in the code instead` };
    }
    return { ...located, table: located.table, row };
  }
}

const NO_TABLE = 'this file has no configurations() table yet';
const NON_LITERAL_TABLE = 'the configurations() table is not an object literal — edit it in the code instead';

/** Why `name` cannot name a row, or null. */
function validateRowName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') {
    return 'a configuration needs a name';
  }
  if (name !== name.trim()) {
    return 'a configuration name cannot start or end with whitespace';
  }
  if (name === DEFAULT_CONFIGURATION_NAME) {
    return `"${DEFAULT_CONFIGURATION_NAME}" is reserved for the param() literals — pick another name`;
  }
  return null;
}

/**
 * The one callback body a table belongs to: the file's single `assembly()`
 * body, else its single `part()` body. Anything else is ambiguous and refused.
 */
function definitionBody(root: TSNode): { body: TSNode } | { error: string } {
  const assemblies = assemblyBodies(root);
  if (assemblies.length === 1) {
    return { body: assemblies[0] };
  }
  if (assemblies.length > 1) {
    return { error: 'Editing configurations requires a single assembly() callback body in the current file.' };
  }
  const parts = partBodies(root);
  if (parts.length === 1) {
    return { body: parts[0] };
  }
  return { error: 'Editing configurations requires a single part() or assembly() callback body in the current file.' };
}

/** Statement blocks of every `part(name, () => {...})` call in the file. */
function partBodies(root: TSNode): TSNode[] {
  const bodies: TSNode[] = [];
  for (const node of walkTree(root)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'identifier' || fn.text !== 'part') {
      continue;
    }
    const body = findSketchBody(node);
    if (body) {
      bodies.push(body);
    }
  }
  return bodies;
}

/** The body's `configurations(…)` statement — bound or bare — and the call's table argument. */
function findTable(body: TSNode): Located['table'] {
  for (const statement of body.namedChildren) {
    const call = configurationsCallOf(statement);
    if (!call) {
      continue;
    }
    const args = call.childForFieldName('arguments');
    const first = args?.namedChildren.find((c) => c.type !== 'comment') ?? null;
    return { statement, call, object: first?.type === 'object' ? first : null };
  }
  return null;
}

/** The `configurations()` call a statement's own value is, or null. */
function configurationsCallOf(statement: TSNode): TSNode | null {
  if (statement.type === 'expression_statement') {
    const expression = statement.namedChildren.find((c) => c.type !== 'comment');
    return expression && isConfigurationsCall(expression) ? expression : null;
  }
  if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
    return null;
  }
  for (const declarator of statement.namedChildren) {
    const value = declarator.type === 'variable_declarator' ? declarator.childForFieldName('value') : null;
    if (value && isConfigurationsCall(value)) {
      return value;
    }
  }
  return null;
}

function isConfigurationsCall(node: TSNode): boolean {
  if (node.type !== 'call_expression') {
    return false;
  }
  const fn = node.childForFieldName('function');
  return fn?.type === 'identifier' && fn.text === 'configurations';
}

/** Whether the body reads what the statement binds — a `const x = configurations(…)` with references to `x`. */
function resultIsRead(tree: TSTree, statement: TSNode): boolean {
  if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
    return false;
  }
  const declarator = statement.namedChildren.find((c) => c.type === 'variable_declarator');
  const name = declarator?.childForFieldName('name');
  if (!name || name.type !== 'identifier') {
    // A destructured result is a read in itself; keep the statement.
    return declarator !== undefined;
  }
  const bindings = new LexicalBindings(tree);
  const binding = bindingOfDeclarator(bindings, name);
  return binding !== null && findBindingReferences(bindings, binding).length > 0;
}

/** An object literal's entries, comments aside. */
function namedEntries(object: TSNode): TSNode[] {
  return object.namedChildren.filter((c) => c.type !== 'comment');
}

/** The key text an entry is addressed by — an identifier, or the value of a string literal. */
function entryName(entry: TSNode): { key: TSNode | null; name: string | null } {
  if (entry.type === 'shorthand_property_identifier') {
    return { key: null, name: entry.text };
  }
  if (entry.type !== 'pair') {
    return { key: null, name: null };
  }
  const key = entry.childForFieldName('key');
  if (!key) {
    return { key: null, name: null };
  }
  if (key.type === 'property_identifier' || key.type === 'number') {
    return { key, name: key.text };
  }
  if (key.type === 'string') {
    return { key, name: stringLiteralText(key) };
  }
  return { key: null, name: null };
}

/** The rows of the table literal, in source order — `object` is null for a row whose value is no literal. */
function rowEntries(table: TSNode): RowEntry[] {
  const rows: RowEntry[] = [];
  for (const entry of namedEntries(table)) {
    const { key, name } = entryName(entry);
    if (name === null) {
      continue;
    }
    const value = entry.type === 'pair' ? entry.childForFieldName('value') : null;
    rows.push({ entry, key, name, object: value?.type === 'object' ? value : null });
  }
  return rows;
}

/** The cells of a row literal, in source order. */
function cellEntries(row: TSNode): { entry: TSNode; label: string; cell: ConfigurationCell }[] {
  const cells: { entry: TSNode; label: string; cell: ConfigurationCell }[] = [];
  for (const entry of namedEntries(row)) {
    const { name } = entryName(entry);
    if (name === null) {
      continue;
    }
    if (entry.type === 'shorthand_property_identifier') {
      cells.push({ entry, label: name, cell: { text: entry.text } });
      continue;
    }
    const value = entry.childForFieldName('value');
    if (!value) {
      continue;
    }
    const literal = literalValueOf(value);
    cells.push({ entry, label: name, cell: literal === undefined ? { text: value.text } : { literal, text: value.text } });
  }
  return cells;
}

/** `{ Width: 1200, Lid: false }` — an empty row renders `{}`. */
function renderRow(values: Record<string, ConfigurationCellValue>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return '{}';
  }
  return `{ ${entries.map(([label, value]) => `${renderKey(label)}: ${renderValue(value)}`).join(', ')} }`;
}

/**
 * Put `rendered` in as the last entry of `object`, in the literal's own
 * style: on a line of its own in a multi-line literal (keeping its trailing
 * comma convention), after a `, ` in a one-line one, inside an empty `{}`.
 */
function appendEntry(code: string, lines: string[], object: TSNode, rendered: string): string {
  const entries = namedEntries(object);
  const last = entries[entries.length - 1];
  const multiLine = object.startPosition.row !== object.endPosition.row;
  if (!last) {
    if (!multiLine) {
      return spliceCode(code, object.startIndex + 1, object.endIndex - 1, ` ${rendered} `);
    }
    const indent = indentOf(lines, object.startPosition.row) + '  ';
    return spliceCode(code, object.startIndex + 1, object.startIndex + 1, `\n${indent}${rendered},`);
  }
  if (!multiLine) {
    return spliceCode(code, last.endIndex, last.endIndex, `, ${rendered}`);
  }
  const indent = indentOf(lines, last.startPosition.row);
  const trailing = code.slice(last.endIndex, object.endIndex - 1);
  const comma = trailing.indexOf(',');
  if (comma !== -1 && trailing.slice(0, comma).trim() === '') {
    const at = last.endIndex + comma + 1;
    return spliceCode(code, at, at, `\n${indent}${rendered},`);
  }
  return spliceCode(code, last.endIndex, last.endIndex, `,\n${indent}${rendered}`);
}

/**
 * Take entry `index` out of `object`: the whole line(s) when it sits alone
 * on them, else the entry and one separator; the last entry leaves `{}`.
 */
function removeEntry(code: string, lines: string[], object: TSNode, entries: TSNode[], index: number): string {
  if (entries.length === 1) {
    return spliceCode(code, object.startIndex + 1, object.endIndex - 1, '');
  }
  const entry = entries[index];
  const startRow = entry.startPosition.row;
  const endRow = entry.endPosition.row;
  const before = lines[startRow].slice(0, entry.startPosition.column);
  const after = lines[endRow].slice(entry.endPosition.column).replace(/^\s*,/, '').trim();
  const aloneOnItsLines = before.trim() === '' && (after === '' || after.startsWith('//'))
    && object.startPosition.row < startRow && object.endPosition.row > endRow;
  if (aloneOnItsLines) {
    const offsets: number[] = [0];
    for (const line of lines) {
      offsets.push(offsets[offsets.length - 1] + line.length + 1);
    }
    return spliceCode(code, offsets[startRow], offsets[endRow + 1], '');
  }
  if (index === 0) {
    return spliceCode(code, entries[0].startIndex, entries[1].startIndex, '');
  }
  return spliceCode(code, entries[index - 1].endIndex, entry.endIndex, '');
}

/**
 * Put `statement` (its lines) at the very top of `body` — above the first
 * statement, whatever it is. An empty body opens up around it, a one-line
 * `{}` included.
 */
function prependToBody(code: string, lines: string[], body: TSNode, statement: string[]): string {
  const existing = body.namedChildren.filter((c) => c.type !== 'comment');
  if (existing.length === 0) {
    const baseIndent = indentOf(lines, body.startPosition.row);
    const indent = baseIndent + '  ';
    const text = statement.join(`\n${indent}`);
    const singleLine = body.startPosition.row === body.endPosition.row;
    const opened = singleLine ? `\n${indent}${text}\n${baseIndent}` : `\n${indent}${text}`;
    return spliceCode(code, body.startIndex + 1, body.startIndex + 1, opened);
  }
  const first = existing[0];
  const indent = indentOf(lines, first.startPosition.row);
  const text = statement.join(`\n${indent}`);
  return spliceCode(code, first.startIndex, first.startIndex, `${text}\n${indent}`);
}
