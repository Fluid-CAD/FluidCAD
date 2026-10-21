// The configurations panel writing the `configurations({ … })` tables back
// to the source — docs/assembly-configurations-plan.md §3.2, §4.2, and the
// multi-part rule of plans/part-configurations-research.md D1. A table is
// one statement, first in a definition's callback body: `const configuration
// = configurations({ Row: { Label: value, … }, … })`. An assembly file has
// one, in its `assembly()` body; a part file may have one per `part()` body,
// each holding the cells of its own body's parameters. Rows are file-wide —
// a row's name means the same configuration in every table that has it.
// Every operation here is a byte-range splice over the tree-sitter tree,
// with the same refusal contract as the other source editors: anything it
// cannot do safely leaves the code untouched and says why.

import {
  applySpliceEdits,
  ensureSymbolImport,
  findPartAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  LexicalBindings,
  removeSymbolImport,
  spliceCode,
  splitLines,
  statementRemovalEdit,
  stringLiteralValue,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor/index.ts';
import { assemblyBodies } from './code-editor/assembly.ts';
import { bindingOfDeclarator, findBindingReferences } from './code-editor/binding-references.ts';
import { boundVariable, isSameNode } from './code-editor/declaration-calls.ts';
import { countIdentifierUses } from './code-editor/imports.ts';
import type { ParamPartTarget } from './param-edit.ts';
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
  /**
   * The definition name of the body the table sits in — the `part()` /
   * `assembly()` call's first argument (`ParamDefinition.bodyName`). Null
   * when the source names the body with something other than a string
   * literal.
   */
  body: string | null;
  /**
   * The body's identity as the source spells it — what the render files
   * the body's parameters under (`ParamDefinition.body`): a part's export
   * binding, else its name and place among the file's parts of that name
   * (`Plate#2`); an assembly's name. Null without a literal name or a
   * binding. A part whose body built before its binding was known renders
   * under the fallback — the route maps a table to the render's identity by
   * {@link call} first.
   */
  id: string | null;
  /** Where the `part()` / `assembly()` call starts: 1-based line, 0-based column — `ParamDefinition.part` of a part's parameters. */
  call: { line: number; column: number };
  /** 1-based line the `configurations()` statement starts on. */
  line: number;
  /** Row name → label → cell, in source order. */
  rows: Record<string, Record<string, ConfigurationCell>>;
};

/** A value the panel writes into a cell — a literal, or `{ expr }` verbatim source. */
export type ConfigurationCellValue = InsertParamValue;

export type ConfigurationEditResult = { newCode: string } | { error: string };

/**
 * Which body's table a write goes to. `body` is the body's identity as the
 * render files its parameters (`ParamDefinition.body`: a part's export
 * binding or `Name#n`, an assembly's name) — or, from an older client, its
 * definition name; `part` the `part()` statement's location as the render
 * captured it (`ParamDefinition.part`, the address `routes/params.ts` gives
 * a part). An export binding the source spells wins, then the location,
 * then a `Name#n` identity, then the one body of that name (refused when
 * parts share it). Neither — or a file with one body — means the file's
 * only body.
 */
export type ConfigurationBodyRef = { body?: string; part?: ParamPartTarget };

/** One body's cells of a row: label → value. */
export type ConfigurationBodyCells = ConfigurationBodyRef & { values: Record<string, ConfigurationCellValue> };

/** One body's share of a grid commit: row name → label → value, or null to unset the cell. */
export type ConfigurationBodyRows = ConfigurationBodyRef & {
  rows: Record<string, Record<string, ConfigurationCellValue | null>>;
};

/**
 * The configurations panel's write, as it rides `ApplyFeatureEditSpec`
 * (`configurationEdit`) through the shared apply-feature round trip — ONE
 * rewrite of the file per request, however many tables it touches, so it
 * lands as one undo step and one render.
 *
 * `values` (add, set) is the cells of the file's only body; `bodies` the
 * cells per body in a file with several, each body's going into its own
 * table. `home` (add) is the body a row with no cells at all goes into.
 * Rename and remove act on every table that has the row.
 */
export type ConfigurationEditSpec =
  | {
    kind: 'add';
    name: string;
    values?: Record<string, ConfigurationCellValue>;
    bodies?: ConfigurationBodyCells[];
    home?: ConfigurationBodyRef;
  }
  | { kind: 'set'; name: string; values?: Record<string, ConfigurationCellValue>; bodies?: ConfigurationBodyCells[] }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'remove'; name: string }
  | ({ kind: 'table' } & ConfigurationTableEdit);

/**
 * The Manage-configurations grid's commit: every table of the file in one
 * rewrite. `renames` (from → to) and `removed` name rows as the tables have
 * them before the commit, and apply to every table that has the row.
 * `rows` (the file's only body) and `bodies` (one entry per body) map a
 * row name after the renames to its cells: a non-null cell is set, a null
 * one unset (back to the literal). A body's table that lacks the row gets
 * it, with the body's non-null cells; a row with no cell in any body that
 * no table has yet goes into `home`. Rows and cells the commit leaves out
 * keep their source as it is.
 */
export type ConfigurationTableEdit = {
  rows?: Record<string, Record<string, ConfigurationCellValue | null>>;
  bodies?: ConfigurationBodyRows[];
  home?: ConfigurationBodyRef;
  renames?: Record<string, string>;
  removed?: string[];
};

/** The binding the generated statement takes, unless its body can already see the name. */
const RESULT_BINDING = 'configuration';

/** A `part()` / `assembly()` callback body of the file, and its table statement if it has one. */
type DefinitionBody = {
  /** The callback's statement block. */
  node: TSNode;
  /** The source's name for it: the call's string-literal first argument, or null. */
  name: string | null;
  /** Its identity as the source spells it — see `ConfigurationTable.id`. */
  id: string | null;
  /** Whether {@link id} is an export binding (as opposed to a name or a `Name#n` fallback). */
  bound: boolean;
  /** The statement holding the call, the call, and its table literal (null for a non-literal argument). */
  table: { statement: TSNode; call: TSNode; object: TSNode | null } | null;
};

/** The file parsed, with the bodies a table can belong to, in source order. */
type FileBodies = { tree: TSTree; lines: string[]; bodies: DefinitionBody[] };

type RowEntry = { entry: TSNode; key: TSNode | null; name: string; object: TSNode | null };

/**
 * Read and rewrite the `configurations({ … })` tables of a model file.
 * Static, string-in/string-out, like {@link ParamEditor} — the route hands
 * the result through the ordinary apply-feature round trip.
 *
 * A body is addressed by its position among the file's definition bodies
 * once a {@link ConfigurationBodyRef} resolved it: a configuration edit
 * never adds or removes a `part()` call, so the position survives every
 * splice of a multi-table edit while the lines move under it.
 */
export class ConfigurationEditor {

  /**
   * The side-channel entry point: one rewrite per spec, in the shape every
   * other transform answers (`error` set and the code untouched on a refusal).
   */
  static async apply(code: string, spec: ConfigurationEditSpec): Promise<{ newCode: string; error?: string }> {
    let result: ConfigurationEditResult;
    switch (spec.kind) {
      case 'add':
        result = await ConfigurationEditor.addRow(code, spec.name, ConfigurationEditor.cellsOf(spec), spec.home);
        break;
      case 'set':
        result = await ConfigurationEditor.setCells(code, spec.name, ConfigurationEditor.cellsOf(spec));
        break;
      case 'rename':
        result = await ConfigurationEditor.renameRow(code, spec.from, spec.to);
        break;
      case 'remove':
        result = await ConfigurationEditor.removeRow(code, spec.name);
        break;
      case 'table':
        result = await ConfigurationEditor.applyTable(code, spec);
        break;
      default:
        return { newCode: code, error: `unknown configuration edit '${String((spec as { kind?: unknown }).kind)}'` };
    }
    return 'error' in result ? { newCode: code, error: result.error } : { newCode: result.newCode };
  }

  /**
   * Every table as written, in source order — one per body that has a
   * `configurations()` statement whose argument is an object literal. Empty
   * when the file has no addressable body (none, two `assembly()` bodies).
   * Two parts of one name are two bodies, each with its own table.
   */
  static async readTables(code: string): Promise<ConfigurationTable[]> {
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return [];
    }
    const tables: ConfigurationTable[] = [];
    for (const body of file.bodies) {
      if (!body.table?.object) {
        continue;
      }
      const rows: Record<string, Record<string, ConfigurationCell>> = {};
      for (const row of rowEntries(body.table.object)) {
        if (!row.object) {
          continue;
        }
        const cells: Record<string, ConfigurationCell> = {};
        for (const cell of cellEntries(row.object)) {
          cells[cell.label] = cell.cell;
        }
        rows[row.name] = cells;
      }
      const call = ConfigurationEditor.definitionCall(body.node);
      tables.push({
        body: body.name,
        id: body.id,
        call: { line: (call?.startPosition.row ?? body.node.startPosition.row) + 1, column: call?.startPosition.column ?? 0 },
        line: body.table.statement.startPosition.row + 1,
        rows,
      });
    }
    return tables;
  }

  /**
   * Add a row — a name no table of the file has yet. Each body's cells go
   * into that body's table; a body without a table gets one, created as
   * the FIRST statement of the body (above every `param()`, where the
   * runtime requires it), with the `configurations` import pulled in. A
   * body the row sets nothing in is left alone; a row with no cells at all
   * goes into `home` (default: the file's only body) as `Name: {}`.
   */
  static async addRow(
    code: string,
    name: string,
    values: Record<string, ConfigurationCellValue> | ConfigurationBodyCells[] = {},
    home?: ConfigurationBodyRef,
  ): Promise<ConfigurationEditResult> {
    const invalidName = validateRowName(name);
    if (invalidName) {
      return { error: invalidName };
    }
    const cells = ConfigurationEditor.bodyCells(values);
    const bad = ConfigurationEditor.invalidCell(cells);
    if (bad) {
      return { error: bad };
    }
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const literal = ConfigurationEditor.literalTables(file);
    if (literal) {
      return literal;
    }
    if (ConfigurationEditor.rowNames(file).includes(name)) {
      return { error: `a configuration named "${name}" already exists` };
    }
    const targets = ConfigurationEditor.targetCells(file, cells);
    if ('error' in targets) {
      return targets;
    }
    if (targets.size === 0) {
      const index = ConfigurationEditor.target(file, home);
      if (typeof index !== 'number') {
        return index;
      }
      targets.set(index, {});
    }
    let out = code;
    for (const [index, bodyValues] of targets) {
      const added = await ConfigurationEditor.appendRowIn(out, index, name, bodyValues);
      if ('error' in added) {
        return added;
      }
      out = added.newCode;
    }
    return { newCode: out };
  }

  /**
   * Set the named cells of a row as literals, adding the ones it lacks.
   * Every other cell keeps its source byte-for-byte, expressions included.
   * The row must exist in some table; a body whose table lacks it (or that
   * has no table yet) gets the row with these cells — the row is file-wide.
   */
  static async setCells(
    code: string,
    name: string,
    values: Record<string, ConfigurationCellValue> | ConfigurationBodyCells[],
  ): Promise<ConfigurationEditResult> {
    const cells = ConfigurationEditor.bodyCells(values);
    const bad = ConfigurationEditor.invalidCell(cells);
    if (bad) {
      return { error: bad };
    }
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const known = ConfigurationEditor.existingRow(file, name);
    if (known) {
      return known;
    }
    const targets = ConfigurationEditor.targetCells(file, cells);
    if ('error' in targets) {
      return targets;
    }
    let out = code;
    for (const [index, bodyValues] of targets) {
      const written = await ConfigurationEditor.writeCellsIn(out, index, name, bodyValues);
      if ('error' in written) {
        return written;
      }
      out = written.newCode;
    }
    return { newCode: out };
  }

  /**
   * Remove the named cells of a row in one body's table (`ref`; default the
   * file's only body); a row left without cells stays as `Name: {}`. Absent
   * labels — and a body whose table lacks the row — no-op.
   */
  static async unsetCells(
    code: string,
    name: string,
    labels: string[],
    ref?: ConfigurationBodyRef,
  ): Promise<ConfigurationEditResult> {
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const known = ConfigurationEditor.existingRow(file, name);
    if (known) {
      return known;
    }
    const index = ConfigurationEditor.target(file, ref);
    if (typeof index !== 'number') {
      return index;
    }
    return ConfigurationEditor.unsetCellsIn(code, index, name, labels);
  }

  /** Rename a row in every table that has it, keeping its cells; refused when any table has the new name. */
  static async renameRow(code: string, from: string, to: string): Promise<ConfigurationEditResult> {
    const invalidName = validateRowName(to);
    if (invalidName) {
      return { error: invalidName };
    }
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const known = ConfigurationEditor.existingRow(file, from);
    if (known) {
      return known;
    }
    if (to !== from && ConfigurationEditor.rowNames(file).includes(to)) {
      return { error: `a configuration named "${to}" already exists` };
    }
    // The keys are renamed bottom-up, so the earlier splices stay where the parse put them.
    const keys = file.bodies
      .map((body) => ConfigurationEditor.rowIn(body, from)?.key ?? null)
      .filter((key): key is TSNode => key !== null)
      .sort((a, b) => b.startIndex - a.startIndex);
    let out = code;
    for (const key of keys) {
      out = spliceCode(out, key.startIndex, key.endIndex, renderKey(to));
    }
    return { newCode: out };
  }

  /**
   * Remove a row from every table that has it. A table's last row takes
   * the whole statement with it — unless its body reads the statement's
   * result (`if (configuration === 'Wide')`), in which case
   * `configurations({})` stays so the read keeps its value — and the
   * `configurations` import goes once no statement of the file uses it,
   * so it stays while another body still has a table.
   */
  static async removeRow(code: string, name: string): Promise<ConfigurationEditResult> {
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const known = ConfigurationEditor.existingRow(file, name);
    if (known) {
      return known;
    }
    let out = code;
    let statementRemoved = false;
    for (const [index, body] of file.bodies.entries()) {
      if (!ConfigurationEditor.rowIn(body, name)) {
        continue;
      }
      const removed = await ConfigurationEditor.removeRowIn(out, index, name);
      if ('error' in removed) {
        return removed;
      }
      out = removed.newCode;
      statementRemoved ||= removed.statementRemoved;
    }
    if (statementRemoved) {
      const parser = await getJavaScriptParser();
      if (countIdentifierUses(parser.parse(out), 'configurations') === 0) {
        return { newCode: await removeSymbolImport(out, 'configurations') };
      }
    }
    return { newCode: out };
  }

  /**
   * The grid's commit as one code change: every rename, removal, cell set,
   * cell unset and new row of `edit`, in every table it touches, composed
   * over the string with the primitives above — so it lands as one edit,
   * one undo step and one render. Checked up front against the tables as
   * they stand (row names are file-wide: a rename or new row may not repeat
   * a name any table has); any refusal leaves the code untouched.
   *
   * Removals go first (a deleted row's name may be reused by a rename or a
   * new row), renames next — through temporary names, so two rows can
   * swap theirs — then the rows' cells, body by body.
   */
  static async applyTable(code: string, edit: ConfigurationTableEdit): Promise<ConfigurationEditResult> {
    const shares: ConfigurationBodyRows[] = [
      ...(edit.rows && Object.keys(edit.rows).length > 0 ? [{ rows: edit.rows }] : []),
      ...(edit.bodies ?? []),
    ];
    const renames = Object.entries(edit.renames ?? {}).filter(([from, to]) => from !== to);
    const removed = [...new Set(edit.removed ?? [])];
    for (const share of shares) {
      for (const cells of Object.values(share.rows ?? {})) {
        const bad = findInvalidParam(setValuesOf(cells));
        if (bad) {
          return { error: `Parameter '${bad}' has an unsupported value.` };
        }
      }
    }
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const literal = ConfigurationEditor.literalTables(file);
    if (literal) {
      return literal;
    }
    const existing = ConfigurationEditor.rowNames(file);
    const unknown = [...removed, ...renames.map(([from]) => from)].find((name) => !existing.includes(name));
    if (unknown !== undefined) {
      return { error: `no configuration named "${unknown}" — is the file in sync with the last render?` };
    }
    const renameMap = new Map(renames);
    const both = removed.find((name) => renameMap.has(name));
    if (both !== undefined) {
      return { error: `the configuration "${both}" cannot be both renamed and removed` };
    }
    const finalNames = existing.filter((name) => !removed.includes(name)).map((name) => renameMap.get(name) ?? name);
    const written = [...new Set(shares.flatMap((share) => Object.keys(share.rows ?? {})))];
    const created = written.filter((name) => !finalNames.includes(name));
    for (const name of [...renameMap.values(), ...created]) {
      const invalid = validateRowName(name);
      if (invalid) {
        return { error: invalid };
      }
    }
    const clash = finalNames.find((name, index) => finalNames.indexOf(name) !== index);
    if (clash !== undefined) {
      return { error: `a configuration named "${clash}" already exists` };
    }
    // Every body's share resolves before anything is written.
    const byBody = new Map<number, Record<string, Record<string, ConfigurationCellValue | null>>>();
    for (const share of shares) {
      const index = ConfigurationEditor.target(file, share);
      if (typeof index !== 'number') {
        return index;
      }
      const rows = byBody.get(index) ?? {};
      for (const [name, cells] of Object.entries(share.rows ?? {})) {
        rows[name] = { ...rows[name], ...cells };
      }
      byBody.set(index, rows);
    }
    const homeless = created.filter((name) =>
      !Array.from(byBody.values()).some((rows) => Object.values(rows[name] ?? {}).some((value) => value !== null)));
    let home: number | null = null;
    if (homeless.length > 0) {
      const index = ConfigurationEditor.target(file, edit.home);
      if (typeof index !== 'number') {
        return index;
      }
      home = index;
    }

    let out = code;
    const step = async (result: Promise<ConfigurationEditResult>): Promise<string | null> => {
      const landed = await result;
      if ('error' in landed) {
        return landed.error;
      }
      out = landed.newCode;
      return null;
    };
    for (const name of removed) {
      const refused = await step(ConfigurationEditor.removeRow(out, name));
      if (refused) {
        return { error: refused };
      }
    }
    const temporary = renames.map((_, index) => {
      let candidate = `__renaming_${index}`;
      while (existing.includes(candidate) || finalNames.includes(candidate)) {
        candidate = `_${candidate}`;
      }
      return candidate;
    });
    for (const [index, [from]] of renames.entries()) {
      const refused = await step(ConfigurationEditor.renameRow(out, from, temporary[index]));
      if (refused) {
        return { error: refused };
      }
    }
    for (const [index, [, to]] of renames.entries()) {
      const refused = await step(ConfigurationEditor.renameRow(out, temporary[index], to));
      if (refused) {
        return { error: refused };
      }
    }
    for (const name of written) {
      for (const [index, rows] of byBody) {
        const cells = rows[name];
        if (!cells) {
          continue;
        }
        const values = setValuesOf(cells);
        const unset = Object.keys(cells).filter((label) => cells[label] === null);
        const body = await ConfigurationEditor.bodyAt(out, index);
        if ('error' in body) {
          return body;
        }
        if (!ConfigurationEditor.rowIn(body, name)) {
          if (Object.keys(values).length > 0) {
            const refused = await step(ConfigurationEditor.appendRowIn(out, index, name, values));
            if (refused) {
              return { error: refused };
            }
          }
          continue;
        }
        if (Object.keys(values).length > 0) {
          const refused = await step(ConfigurationEditor.writeCellsIn(out, index, name, values));
          if (refused) {
            return { error: refused };
          }
        }
        if (unset.length > 0) {
          const refused = await step(ConfigurationEditor.unsetCellsIn(out, index, name, unset));
          if (refused) {
            return { error: refused };
          }
        }
      }
    }
    for (const name of homeless) {
      const refused = await step(ConfigurationEditor.appendRowIn(out, home!, name, {}));
      if (refused) {
        return { error: refused };
      }
    }
    return { newCode: out };
  }

  // -------------------------------------------------------------------------
  // One body's table
  // -------------------------------------------------------------------------

  /**
   * Append row `name` to body `index`'s table — creating the statement
   * first in the body, and the import, when it has none. The caller has
   * checked the name against every table.
   */
  private static async appendRowIn(
    code: string,
    index: number,
    name: string,
    values: Record<string, ConfigurationCellValue>,
  ): Promise<ConfigurationEditResult> {
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const body = file.bodies[index];
    const rendered = `${renderKey(name)}: ${renderRow(values)}`;
    if (!body.table) {
      const taken = ConfigurationEditor.nameVisibleIn(file, body, RESULT_BINDING);
      const binding = taken ? '' : `const ${RESULT_BINDING} = `;
      const statement = [`${binding}configurations({`, `  ${rendered},`, `});`];
      const declared = prependToBody(code, file.lines, body.node, statement);
      return { newCode: await ensureSymbolImport(declared, 'configurations') };
    }
    if (!body.table.object) {
      return { error: NON_LITERAL_TABLE };
    }
    return { newCode: appendEntry(code, file.lines, body.table.object, rendered) };
  }

  /** Set cells of row `name` in body `index` — the row added to that table when it lacks it. */
  private static async writeCellsIn(
    code: string,
    index: number,
    name: string,
    values: Record<string, ConfigurationCellValue>,
  ): Promise<ConfigurationEditResult> {
    const body = await ConfigurationEditor.bodyAt(code, index);
    if ('error' in body) {
      return body;
    }
    if (!ConfigurationEditor.rowIn(body, name)) {
      return ConfigurationEditor.appendRowIn(code, index, name, values);
    }
    let out = code;
    for (const [label, value] of Object.entries(values)) {
      const found = await ConfigurationEditor.locateRow(out, index, name);
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

  /** Remove cells of row `name` in body `index`; a body whose table lacks the row is left as it is. */
  private static async unsetCellsIn(
    code: string,
    index: number,
    name: string,
    labels: string[],
  ): Promise<ConfigurationEditResult> {
    let out = code;
    for (const label of labels) {
      const body = await ConfigurationEditor.bodyAt(out, index);
      if ('error' in body) {
        return body;
      }
      if (!ConfigurationEditor.rowIn(body, name)) {
        return { newCode: out };
      }
      const found = await ConfigurationEditor.locateRow(out, index, name);
      if ('error' in found) {
        return found;
      }
      const object = found.row.object!;
      const entries = namedEntries(object);
      const at = cellEntries(object).findIndex((cell) => cell.label === label);
      if (at === -1) {
        continue;
      }
      out = removeEntry(out, splitLines(out), object, entries, at);
    }
    return { newCode: out };
  }

  /**
   * Take row `name` out of body `index`'s table; its last row takes the
   * statement too, unless the body reads the result. The import is the
   * caller's to settle, once every table had its turn.
   */
  private static async removeRowIn(
    code: string,
    index: number,
    name: string,
  ): Promise<{ newCode: string; statementRemoved: boolean } | { error: string }> {
    const found = await ConfigurationEditor.locateRow(code, index, name);
    if ('error' in found) {
      return found;
    }
    const { tree, lines, table, row } = found;
    const object = table.object!;
    const entries = namedEntries(object);
    if (entries.length > 1) {
      const at = entries.findIndex((entry) => isSameNode(entry, row.entry));
      return { newCode: removeEntry(code, lines, object, entries, at), statementRemoved: false };
    }
    if (resultIsRead(tree, table.statement)) {
      return { newCode: spliceCode(code, object.startIndex + 1, object.endIndex - 1, ''), statementRemoved: false };
    }
    return { newCode: applySpliceEdits(code, [statementRemovalEdit(code, lines, table.statement)]), statementRemoved: true };
  }

  // -------------------------------------------------------------------------
  // Locating
  // -------------------------------------------------------------------------

  /** The file's definition bodies and their tables, or why the file has none to edit. */
  private static async read(code: string): Promise<FileBodies | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const bodies = ConfigurationEditor.definitionBodies(tree.rootNode);
    if ('error' in bodies) {
      return bodies;
    }
    return {
      tree,
      lines: splitLines(code),
      bodies: bodies.map((body) => ({ ...body, table: findTable(body.node) })),
    };
  }

  /**
   * The callback bodies a table may belong to: the file's single
   * `assembly()` body, else every `part()` body — nested ones included, in
   * source order. Refused: no body, and two `assembly()` bodies. Two parts
   * of one name are two bodies: the render files each under its own
   * identity (its export binding, else `Name#n`), never its name.
   */
  private static definitionBodies(root: TSNode): Omit<DefinitionBody, 'table'>[] | { error: string } {
    const assemblies = assemblyBodies(root);
    if (assemblies.length === 1) {
      const name = ConfigurationEditor.bodyName(assemblies[0]);
      return [{ node: assemblies[0], name, id: name, bound: false }];
    }
    if (assemblies.length > 1) {
      return { error: 'Editing configurations requires a single assembly() callback body in the current file.' };
    }
    const parts = partBodies(root);
    if (parts.length === 0) {
      return { error: 'Editing configurations requires a part() or assembly() callback body in the current file.' };
    }
    const ordinals = ConfigurationEditor.partOrdinals(root);
    return parts.map((node) => {
      const name = ConfigurationEditor.bodyName(node);
      const call = ConfigurationEditor.definitionCall(node);
      const binding = call ? ConfigurationEditor.exportBinding(root, call) : null;
      const ordinal = call ? ordinals.get(call.startIndex) : undefined;
      const id = binding ?? (name !== null && ordinal !== undefined ? `${name}#${ordinal}` : null);
      return { node, name, id, bound: binding !== null };
    });
  }

  /** The `part()` / `assembly()` call a callback body belongs to. */
  private static definitionCall(body: TSNode): TSNode | null {
    const call = body.parent?.parent?.parent;
    return call?.type === 'call_expression' ? call : null;
  }

  /** The definition call's name for a callback body: its string-literal first argument, else null. */
  private static bodyName(body: TSNode): string | null {
    const call = ConfigurationEditor.definitionCall(body);
    if (!call) {
      return null;
    }
    const first = call.childForFieldName('arguments')?.namedChildren.find((c) => c.type !== 'comment');
    return first ? stringLiteralValue(first) : null;
  }

  /**
   * Each literal-named `part()` call's place among the file's calls of
   * that name, in source order, by the call's start index — what the
   * engine's `Name#n` fallback counts (lib `PartIdentity`). A nested
   * part's call runs when its enclosing body builds, so for those the
   * engine's order can differ; the route addresses parts by location.
   */
  private static partOrdinals(root: TSNode): Map<number, number> {
    const counts = new Map<string, number>();
    const ordinals = new Map<number, number>();
    for (const node of walkTree(root)) {
      if (node.type !== 'call_expression') {
        continue;
      }
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'identifier' || fn.text !== 'part') {
        continue;
      }
      const first = node.childForFieldName('arguments')?.namedChildren.find((c) => c.type !== 'comment');
      const name = first ? stringLiteralValue(first) : null;
      if (name === null) {
        continue;
      }
      const ordinal = (counts.get(name) ?? 0) + 1;
      counts.set(name, ordinal);
      ordinals.set(node.startIndex, ordinal);
    }
    return ordinals;
  }

  /**
   * The export binding of a top-level `const <x> = part(…)` — `x` when the
   * declaration is exported, and every name an `export { x as y }` clause
   * gives it — the first in code-unit order, as the engine picks it
   * (lib `PartIdentity`). Null for a part no export names (`default`
   * names no binding).
   */
  private static exportBinding(root: TSNode, call: TSNode): string | null {
    const local = boundVariable(call);
    if (local === null) {
      return null;
    }
    let declaration: TSNode | null = call.parent;
    while (declaration && declaration.type !== 'lexical_declaration' && declaration.type !== 'variable_declaration') {
      declaration = declaration.parent;
    }
    const statement = declaration?.parent?.type === 'export_statement' ? declaration.parent : declaration;
    if (!statement || statement.parent?.type !== 'program') {
      return null;
    }
    const names: string[] = statement.type === 'export_statement' ? [local] : [];
    for (const node of root.namedChildren) {
      if (node.type !== 'export_statement' || node.childForFieldName('source')) {
        continue;
      }
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      for (const specifier of clause?.namedChildren ?? []) {
        if (specifier.type !== 'export_specifier' || specifier.childForFieldName('name')?.text !== local) {
          continue;
        }
        const exported = (specifier.childForFieldName('alias') ?? specifier.childForFieldName('name'))!.text;
        if (exported !== 'default' && !names.includes(exported)) {
          names.push(exported);
        }
      }
    }
    return names.length > 0 ? names.sort()[0] : null;
  }

  /** Body `index` of the file as `code` stands, with its table. */
  private static async bodyAt(code: string, index: number): Promise<DefinitionBody | { error: string }> {
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    return file.bodies[index] ?? { error: 'the part() bodies changed while the configurations were being written' };
  }

  /**
   * The body a reference names, as its position among the file's bodies:
   * by the export binding the source spells, else by the `part()`
   * statement's location, else by a `Name#n` identity, else by the one body
   * of that name (an older client's reference; refused when parts share
   * it), else the file's only body.
   */
  private static target(file: FileBodies, ref: ConfigurationBodyRef | undefined): number | { error: string } {
    if (ref?.body !== undefined) {
      const index = file.bodies.findIndex((body) => body.bound && body.id === ref.body);
      if (index !== -1) {
        return index;
      }
    }
    if (ref?.part !== undefined) {
      const part = findPartAt(file.tree, file.lines, ref.part.line);
      if ('error' in part) {
        return part;
      }
      const index = file.bodies.findIndex((body) => body.node.startIndex === part.body.startIndex);
      if (index !== -1) {
        return index;
      }
      return { error: `the part() at line ${ref.part.line} cannot hold a configurations() table in this file` };
    }
    if (ref?.body !== undefined) {
      const index = file.bodies.findIndex((body) => body.id === ref.body);
      if (index !== -1) {
        return index;
      }
      const named = file.bodies.filter((body) => body.name === ref.body);
      if (named.length === 1) {
        return file.bodies.indexOf(named[0]);
      }
      if (named.length > 1) {
        return { error: `${named.length} part() bodies in this file are named "${ref.body}" — address the part by its export name or its part() statement's line.` };
      }
    }
    if (file.bodies.length === 1) {
      return 0;
    }
    if (ref?.body !== undefined) {
      return { error: `no part() named "${ref.body}" in this file — is the file in sync with the last render?` };
    }
    return { error: 'this file has several part() bodies — name the part whose configurations() table to write' };
  }

  /** The cells grouped by the body they resolve to, empty shares left out. */
  private static targetCells(
    file: FileBodies,
    cells: ConfigurationBodyCells[],
  ): Map<number, Record<string, ConfigurationCellValue>> | { error: string } {
    const targets = new Map<number, Record<string, ConfigurationCellValue>>();
    for (const share of cells) {
      if (Object.keys(share.values).length === 0) {
        continue;
      }
      const index = ConfigurationEditor.target(file, share);
      if (typeof index !== 'number') {
        return index;
      }
      targets.set(index, { ...targets.get(index), ...share.values });
    }
    return targets;
  }

  /** The table and row `name` of body `index`, refusing a missing or non-literal one. */
  private static async locateRow(
    code: string,
    index: number,
    name: string,
  ): Promise<(FileBodies & { table: NonNullable<DefinitionBody['table']>; row: RowEntry }) | { error: string }> {
    const file = await ConfigurationEditor.read(code);
    if ('error' in file) {
      return file;
    }
    const table = file.bodies[index]?.table;
    if (!table) {
      return { error: NO_TABLE };
    }
    if (!table.object) {
      return { error: NON_LITERAL_TABLE };
    }
    const row = rowEntries(table.object).find((candidate) => candidate.name === name);
    if (!row) {
      return { error: `no configuration named "${name}" — is the file in sync with the last render?` };
    }
    if (!row.key || !row.object) {
      return { error: `the configuration "${name}" is not written as an object literal — edit it in the code instead` };
    }
    return { ...file, table, row };
  }

  /** A body's row of that name, when its table is a literal that has one. */
  private static rowIn(body: DefinitionBody, name: string): RowEntry | undefined {
    return body.table?.object ? rowEntries(body.table.object).find((row) => row.name === name) : undefined;
  }

  /** Every row name of the file's tables, first-declared order, each once. */
  private static rowNames(file: FileBodies): string[] {
    const names: string[] = [];
    for (const body of file.bodies) {
      for (const row of body.table?.object ? rowEntries(body.table.object) : []) {
        if (!names.includes(row.name)) {
          names.push(row.name);
        }
      }
    }
    return names;
  }

  /** The refusal for a table whose argument is no object literal — its rows cannot be read. */
  private static literalTables(file: FileBodies): { error: string } | null {
    return file.bodies.some((body) => body.table && !body.table.object) ? { error: NON_LITERAL_TABLE } : null;
  }

  /**
   * Why row `name` cannot be edited: no table at all, a non-literal one, no
   * table with that row, or a row that is not written as an object literal.
   */
  private static existingRow(file: FileBodies, name: string): { error: string } | null {
    const tables = file.bodies.filter((body) => body.table);
    if (tables.length === 0) {
      return { error: NO_TABLE };
    }
    const literal = ConfigurationEditor.literalTables(file);
    if (literal) {
      return literal;
    }
    const rows = file.bodies.map((body) => ConfigurationEditor.rowIn(body, name)).filter((row) => row !== undefined);
    if (rows.length === 0) {
      return { error: `no configuration named "${name}" — is the file in sync with the last render?` };
    }
    if (rows.some((row) => !row!.key || !row!.object)) {
      return { error: `the configuration "${name}" is not written as an object literal — edit it in the code instead` };
    }
    return null;
  }

  /**
   * Whether `name` is declared where `body` can see it — at the top level,
   * in a body enclosing it, or in it — so a new table there stays unbound.
   * A sibling part's own `configuration` is its business.
   */
  private static nameVisibleIn(file: FileBodies, body: DefinitionBody, name: string): boolean {
    const others = file.bodies.map((b) => b.node).filter((node) => !isSameNode(node, body.node));
    for (const node of walkTree(file.tree.rootNode)) {
      const declares = (node.type === 'variable_declarator' || node.type === 'function_declaration' || node.type === 'class_declaration')
        ? node.childForFieldName('name')?.text === name
        : (node.type === 'import_specifier' || node.type === 'namespace_import')
          && (node.childForFieldName('alias') ?? node.childForFieldName('name') ?? node.namedChild(0))?.text === name;
      if (!declares) {
        continue;
      }
      const inSibling = others.some((other) => ConfigurationEditor.contains(other, node) && !ConfigurationEditor.contains(other, body.node));
      if (!inSibling) {
        return true;
      }
    }
    return false;
  }

  private static contains(outer: TSNode, inner: TSNode): boolean {
    return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
  }

  // -------------------------------------------------------------------------
  // Specs
  // -------------------------------------------------------------------------

  /** A spec's cells as per-body shares: `values` is the file's only body's. */
  private static cellsOf(spec: { values?: Record<string, ConfigurationCellValue>; bodies?: ConfigurationBodyCells[] }): ConfigurationBodyCells[] {
    return [...(spec.values ? [{ values: spec.values }] : []), ...(spec.bodies ?? [])];
  }

  /** The method arguments' cells as per-body shares: a plain record is the file's only body's. */
  private static bodyCells(values: Record<string, ConfigurationCellValue> | ConfigurationBodyCells[]): ConfigurationBodyCells[] {
    return Array.isArray(values) ? values : [{ values }];
  }

  /** The first cell no table can hold, as the refusal's text. */
  private static invalidCell(cells: ConfigurationBodyCells[]): string | null {
    for (const share of cells) {
      const bad = findInvalidParam(share.values ?? {});
      if (bad) {
        return `Parameter '${bad}' has an unsupported value.`;
      }
    }
    return null;
  }
}

const NO_TABLE = 'this file has no configurations() table yet';
const NON_LITERAL_TABLE = 'the configurations() table is not an object literal — edit it in the code instead';

/** A grid row's cells without its nulls — the ones it sets. */
function setValuesOf(cells: Record<string, ConfigurationCellValue | null>): Record<string, ConfigurationCellValue> {
  const out: Record<string, ConfigurationCellValue> = {};
  for (const [label, value] of Object.entries(cells ?? {})) {
    if (value !== null) {
      out[label] = value;
    }
  }
  return out;
}

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
function findTable(body: TSNode): DefinitionBody['table'] {
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
