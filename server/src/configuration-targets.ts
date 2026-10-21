import type { SceneConfigurations, SceneConfigurationTable } from './fluidcad-server/index.ts';
import type {
  ConfigurationBodyCells,
  ConfigurationBodyRef,
  ConfigurationBodyRows,
  ConfigurationCellValue,
} from './configuration-edit.ts';
import { normalizePath } from './normalize-path.ts';
import { ParamKey, type ParamDefinition, type SessionParamOverride } from '../../lib/dist/index.js';

// Where the Parameters panel's values go in the current file's
// `configurations()` tables, and what the tables will look like once an
// edit lands — shared by the row routes (`routes/configurations.ts`) and
// the panel's per-value write (`routes/params.ts` `/params/value`).

/** Cells grouped by the body whose table holds them: body (definition name, null for the file's only body) → label → value. */
export type BodyCells = Map<string | null, Record<string, ConfigurationCellValue>>;

/** A grid commit grouped the same way: body → row name → label → value, or null to unset. */
export type BodyRows = Map<string | null, Record<string, Record<string, ConfigurationCellValue | null>>>;

/** Where a row with no cell goes: the editor's reference to the body, and its definition name for the forecast. */
export type BodyHome = { ref?: ConfigurationBodyRef; body: string | null };

/** A row edit's cells as a request names them: row name → param key → value, or null to unset. */
export type RowCellsRequest = Record<string, Record<string, ConfigurationCellValue | null>>;

/**
 * Where the panel's cells go in the current file: each parameter by its
 * key (`ParamKey.id`) resolved against the last render's definitions to the
 * body that declares it, and each body to the reference the editor
 * addresses it by — its definition name, plus its `part()` statement's
 * location when it is a part. A parameter of a part from another file
 * (built at the top level of this one) is no cell of this file's tables.
 */
export class ConfigurationTargets {
  private readonly definitions: ParamDefinition[];
  /** label → the bodies of this file declaring it, for a bare-label key. */
  private readonly holders: Map<string, string[]>;

  constructor(definitions: ParamDefinition[], private readonly file: string) {
    this.definitions = definitions.filter((def) => def.kind !== 'global'
      && (def.part === undefined || ConfigurationTargets.sameFile(def.part.filePath, file)));
    this.holders = ParamKey.holdersOf(this.definitions);
  }

  /** The body every parameter of the file belongs to, when there is just one — the home of a cell-less row. */
  get soleBody(): string | null {
    const bodies = new Set(this.definitions.map((def) => def.body ?? null));
    return bodies.size === 1 ? [...bodies][0] : null;
  }

  /**
   * Every parameter of the last render whose current value — override,
   * else the active row's cell, else the literal — differs from its
   * literal, grouped by body.
   */
  derived(): BodyCells {
    const cells: BodyCells = new Map();
    for (const def of this.definitions) {
      if (!ConfigurationTargets.sameValue(def.currentValue, def.defaultValue)) {
        ConfigurationTargets.put(cells, def.body ?? null, def.label, def.currentValue as ConfigurationCellValue);
      }
    }
    return cells;
  }

  /** The session's overrides, grouped by the body of the parameter each sets. */
  overrides(entries: SessionParamOverride[]): BodyCells | { error: string } {
    const cells: BodyCells = new Map();
    for (const { key, value } of entries) {
      const resolved = this.resolve(key);
      if ('error' in resolved) {
        return resolved;
      }
      ConfigurationTargets.put(cells, resolved.body, resolved.label, value as ConfigurationCellValue);
    }
    return cells;
  }

  /** A request's `{ <param key>: value }`, grouped by body. */
  group(values: Record<string, ConfigurationCellValue>): BodyCells | { error: string } {
    const cells: BodyCells = new Map();
    for (const [id, value] of Object.entries(values)) {
      const resolved = this.resolve(ParamKey.parse(id));
      if ('error' in resolved) {
        return resolved;
      }
      ConfigurationTargets.put(cells, resolved.body, resolved.label, value);
    }
    return cells;
  }

  /**
   * A grid commit's `{ row: { <param key>: value | null } }`, grouped by
   * body. A row naming no cell is kept under `home`, so the editor still
   * learns of it — it adds such a row to the home body when it is new.
   */
  groupRows(rows: RowCellsRequest, home: string | null): BodyRows | { error: string } {
    const grouped: BodyRows = new Map();
    const at = (body: string | null, name: string): Record<string, ConfigurationCellValue | null> => {
      const byName = grouped.get(body) ?? {};
      grouped.set(body, byName);
      byName[name] ??= {};
      return byName[name];
    };
    for (const [name, cells] of Object.entries(rows)) {
      if (Object.keys(cells).length === 0) {
        at(home, name);
        continue;
      }
      for (const [id, value] of Object.entries(cells)) {
        const resolved = this.resolve(ParamKey.parse(id));
        if ('error' in resolved) {
          return resolved;
        }
        at(resolved.body, name)[resolved.label] = value;
      }
    }
    return grouped;
  }

  /** The cells as the editor spec carries them, one share per body. */
  edits(cells: BodyCells): ConfigurationBodyCells[] {
    return Array.from(cells, ([body, values]) => ({ ...this.ref(body), values }));
  }

  /** A grid commit as the editor spec carries it, one share per body. */
  rowEdits(rows: BodyRows): ConfigurationBodyRows[] {
    return Array.from(rows, ([body, byName]) => ({ ...this.ref(body), rows: byName }));
  }

  /**
   * The request's home body: its `part()` statement (`{ filePath?, line,
   * column }`, the Add-to part) and/or its definition name. Neither: the
   * file's only body.
   */
  home(part: unknown, body: unknown): BodyHome | { error: string } {
    if (body !== undefined && body !== null && (typeof body !== 'string' || body === '')) {
      return { error: 'body must be the definition name of the part the configuration goes in' };
    }
    if (part === undefined || part === null) {
      if (typeof body === 'string') {
        return { ref: this.ref(body), body };
      }
      return { body: this.soleBody };
    }
    const { filePath, line, column } = (typeof part === 'object' ? part : {}) as Record<string, unknown>;
    if (!Number.isInteger(line) || (line as number) < 1
      || (column !== undefined && (!Number.isInteger(column) || (column as number) < 0))
      || (filePath !== undefined && typeof filePath !== 'string')) {
      return { error: 'part must be {filePath, line, column} of the part() statement the configuration goes in' };
    }
    if (typeof filePath === 'string' && !ConfigurationTargets.sameFile(filePath, this.file)) {
      return { error: 'part must be a part() of the current file — a configuration lives in the file that declares it' };
    }
    const named = typeof body === 'string'
      ? body
      : this.definitions.find((def) => def.part?.line === line)?.body ?? null;
    return {
      ref: { ...(named !== null ? { body: named } : {}), part: { line: line as number, column: (column as number | undefined) ?? 0 } },
      body: named,
    };
  }

  /** The editor's reference to a body: its name, and its `part()` statement when it is a part. Null: the only body. */
  private ref(body: string | null): ConfigurationBodyRef {
    if (body === null) {
      return {};
    }
    const located = this.definitions.find((def) => def.body === body && def.part !== undefined);
    return located?.part
      ? { body, part: { line: located.part.line, column: located.part.column } }
      : { body };
  }

  /**
   * The body and label a key names: its own body, or for a bare label the
   * one body declaring it (none yet: the file's only body). A label two
   * bodies declare is refused — a cell meant for one part must not land in
   * another's table.
   */
  private resolve(key: ParamKey): { body: string | null; label: string } | { error: string } {
    if (!key.labelOnly) {
      if (!this.definitions.some((def) => def.body === key.body)) {
        return { error: `${key.describe()} is no parameter of this file's parts — a configuration sets the parameters of the file that declares it.` };
      }
      return { body: key.body, label: key.label };
    }
    const resolved = ParamKey.resolveLabel(key.label, this.holders);
    if ('error' in resolved) {
      const keys = resolved.bodies.map((body) => JSON.stringify([body, key.label])).join(' or ');
      return { error: `Parameter '${key.label}' is declared by ${resolved.bodies.map((b) => `'${b}'`).join(' and ')} — key its cell by its part: ${keys}.` };
    }
    return { body: resolved.key.body, label: key.label };
  }

  private static put(cells: BodyCells, body: string | null, label: string, value: ConfigurationCellValue): void {
    const values = cells.get(body) ?? {};
    values[label] = value;
    cells.set(body, values);
  }

  private static sameFile(a: string, b: string): boolean {
    return normalizePath(a.replace('virtual:live-render:', '')) === normalizePath(b.replace('virtual:live-render:', ''));
  }

  private static sameValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
    }
    return a === b;
  }
}

/**
 * The summary an edit's answer carries — the tables as the host's
 * re-render will report them once it saved the edit — worked out table by
 * table from the summary before it. The merged `names` / `rows` follow from
 * the tables as the registry merges them. A summary without `tables` (a
 * server predating them) is read as one table and answered without them.
 */
export class ConfigurationsForecast {
  private readonly tables: SceneConfigurationTable[];
  private readonly reportTables: boolean;

  constructor(before: SceneConfigurations, private readonly soleBody: string | null) {
    this.reportTables = before.tables !== undefined;
    this.tables = before.tables
      ? before.tables.map((table) => ({ body: table.body, names: table.names.slice(), rows: ConfigurationsForecast.copyRows(table.rows) }))
      : before.names.length > 0
        ? [{ body: soleBody ?? '', names: before.names.slice(), rows: ConfigurationsForecast.copyRows(before.rows) }]
        : [];
  }

  /** A new row: each body's cells in its table, or an empty row in `home`'s when no body has a cell. */
  addRow(name: string, cells: BodyCells, home: string | null): void {
    const written = Array.from(cells).filter(([, values]) => Object.keys(values).length > 0);
    if (written.length === 0) {
      this.row(home, name);
      return;
    }
    for (const [body, values] of written) {
      Object.assign(this.row(body, name), ConfigurationsForecast.literalCells(values));
    }
  }

  /** Cells into a row that exists in some table — added to a body's table that lacks it. */
  setCells(name: string, cells: BodyCells): void {
    for (const [body, values] of cells) {
      Object.assign(this.row(body, name), ConfigurationsForecast.literalCells(values));
    }
  }

  rename(from: string, to: string): void {
    for (const table of this.tables) {
      if (!table.names.includes(from)) {
        continue;
      }
      table.names = table.names.map((n) => (n === from ? to : n));
      const rows: SceneConfigurationTable['rows'] = {};
      for (const [rowName, cells] of Object.entries(table.rows)) {
        rows[rowName === from ? to : rowName] = cells;
      }
      table.rows = rows;
    }
  }

  /** The row out of every table; a table it empties is gone. */
  remove(name: string): void {
    for (const table of this.tables) {
      table.names = table.names.filter((n) => n !== name);
      delete table.rows[name];
    }
    this.tables.splice(0, this.tables.length, ...this.tables.filter((table) => table.names.length > 0));
  }

  /** A grid commit: removals, renames (through no temporary — the forecast has none to collide), then each body's cells. */
  applyTable(rows: BodyRows, renames: Record<string, string>, removed: string[], order: string[], home: string | null): void {
    for (const name of removed) {
      this.remove(name);
    }
    const renamed = this.tables.map((table) => ({ ...table }));
    for (const table of renamed) {
      table.names = table.names.map((n) => renames[n] ?? n);
      const next: SceneConfigurationTable['rows'] = {};
      for (const [rowName, cells] of Object.entries(table.rows)) {
        next[renames[rowName] ?? rowName] = cells;
      }
      table.rows = next;
    }
    this.tables.splice(0, this.tables.length, ...renamed);
    const existing = new Set(this.names());
    for (const name of order) {
      let landed = existing.has(name);
      for (const [body, byName] of rows) {
        const cells = byName[name];
        if (!cells) {
          continue;
        }
        const set = Object.entries(cells).filter(([, value]) => value !== null);
        const table = this.table(body, false);
        if (!table?.names.includes(name) && set.length === 0) {
          continue;
        }
        const row = this.row(body, name);
        for (const [label, value] of Object.entries(cells)) {
          if (value === null) {
            delete row[label];
          } else {
            row[label] = ConfigurationsForecast.literalCells({ [label]: value })[label];
          }
        }
        landed = true;
      }
      if (!landed) {
        this.row(home, name);
      }
    }
  }

  /** The answer's summary: the merged listing, the tables when the summary before had them. */
  summary(active: string, modified: boolean): SceneConfigurations {
    const names = this.names();
    const rows: SceneConfigurations['rows'] = {};
    for (const table of this.tables) {
      for (const name of table.names) {
        rows[name] = table.rows[name];
      }
    }
    return {
      active,
      names,
      rows,
      ...(this.reportTables ? { tables: this.tables } : {}),
      modified,
    };
  }

  /** Every row name, first table first — the registry's merge order. */
  private names(): string[] {
    const names: string[] = [];
    for (const table of this.tables) {
      for (const name of table.names) {
        if (!names.includes(name)) {
          names.push(name);
        }
      }
    }
    return names;
  }

  /** A body's table — null: the file's only body (the first table, or the sole body's) — created on demand. */
  private table(body: string | null, create: true): SceneConfigurationTable;
  private table(body: string | null, create: false): SceneConfigurationTable | undefined;
  private table(body: string | null, create: boolean): SceneConfigurationTable | undefined {
    const name = body ?? this.soleBody;
    let found = name !== null ? this.tables.find((table) => table.body === name) : undefined;
    if (!found && body === null) {
      found = this.tables[0];
    }
    if (found || !create) {
      return found;
    }
    const table: SceneConfigurationTable = { body: name ?? '', names: [], rows: {} };
    this.tables.push(table);
    return table;
  }

  /** Row `name` of a body's table, added (empty) when the table lacks it. */
  private row(body: string | null, name: string): Record<string, SceneConfigurationTable['rows'][string][string]> {
    const table = this.table(body, true);
    if (!table.names.includes(name)) {
      table.names.push(name);
      table.rows[name] = {};
    }
    table.rows[name] ??= {};
    return table.rows[name];
  }

  private static copyRows(rows: SceneConfigurationTable['rows']): SceneConfigurationTable['rows'] {
    const out: SceneConfigurationTable['rows'] = {};
    for (const [name, cells] of Object.entries(rows)) {
      out[name] = { ...cells };
    }
    return out;
  }

  /** The cells as the render will report them: literals as they are, an `{ expr }` cell by its source text. */
  private static literalCells(values: Record<string, ConfigurationCellValue>): SceneConfigurationTable['rows'][string] {
    const out: SceneConfigurationTable['rows'][string] = {};
    for (const [label, value] of Object.entries(values)) {
      out[label] = typeof value === 'object' && !Array.isArray(value) ? value.expr : value;
    }
    return out;
  }
}
