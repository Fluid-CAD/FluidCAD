import { BuildError } from "../common/build-error.js";
import { validateParamOverrides } from "../features/param-overrides.js";
import { activeParamScope, DEFAULT_CONFIGURATION, getParamRegistry } from "../param-registry.js";
import type { ConfigurationRow, ParamOverrides } from "../param-registry.js";

/**
 * The table `configurations()` takes: row name → the `param()` labels the
 * row sets. Rows are sparse — a label a row leaves out keeps its literal.
 */
export type ConfigurationRows = Record<string, ParamOverrides>;

/**
 * Declares the named configurations of a part or assembly: a table of
 * value sets for the body's `param()` interface, and returns the name of
 * the one being built (`'Default'` when the literals are).
 *
 *     export const frame = assembly('frame', () => {
 *       const configuration = configurations({
 *         Compact: { Width: 500, Depth: 600, Lid: false },
 *         Wide:    { Width: 1200 },
 *       });
 *       const width = param('Width', 700, 'number', { min: 400, max: 1500, step: 10 });
 *       ...
 *       if (configuration === 'Wide') { ... }
 *
 * The `param()` declarations are the schema; a row holds only the values it
 * changes, in the file's unit, with the same `{ label: value }` shape an
 * `insert()` override takes. The statement is the FIRST of the body: it
 * must run before the body's first `param()`, once per body. `Default` is
 * reserved for the literals and refused as a row name.
 *
 * Rendering the defining file, the host's active configuration picks the
 * row (the dropdown; `?configuration=` in the viewer) and session overrides
 * sit on top of it. Row names are file-wide but cells are per body: in a
 * file with several parts each body applies its own table's row for the
 * active name, and a body whose table lacks it builds its literals. From a parent, `insert(def, 'Wide')` picks the row per
 * instance, `insert(def, 'Wide', { Depth: 1000 })` layers values on it, and
 * a name the table does not declare is an error on that insert statement.
 *
 * @param rows - `{ Name: { label: value, ... }, ... }` — one entry per configuration.
 * @returns The active row's name, or `'Default'`.
 */
export default function configurations(rows: ConfigurationRows): string {
  const registry = getParamRegistry();
  if (!registry.inBody()) {
    throw new BuildError(
      "configurations() must be called inside a part() or assembly() body — it is the first statement of the body's callback.",
      "A *.params.js file has no body: declare the table in the part or assembly that reads the parameters.",
    );
  }
  if (registry.bodyConfigured()) {
    throw new BuildError(
      `configurations() was already declared in this body — a body has one table.`,
      "merge the rows into the first configurations() call.",
    );
  }
  if (registry.bodyParamRan()) {
    throw new BuildError(
      "configurations() ran after a param() of the same body — the active row must be installed before any value is resolved.",
      "declare configurations() before the body's first param().",
    );
  }
  registry.noteBodyConfigured();

  const table = validateRows(rows);
  const names = Object.keys(table);
  const definition = registry.currentBodyName() ?? "";

  // A scoped run — `insert(def, 'Name')` from a parent. The scope carries
  // the requested name; the row's cells become the scope's configuration
  // layer, below the insert's own overrides. A missing name throws here, so
  // the error lands on the parent's insert statement with the names listed.
  const scope = activeParamScope();
  if (scope) {
    scope.configurationNames = names;
    const requested = scope.configuration;
    if (requested === undefined) {
      return DEFAULT_CONFIGURATION;
    }
    const row = table[requested];
    if (!row) {
      throw new Error(
        `'${definition}' has no configuration '${requested}' — `
        + (names.length > 0 ? `its configurations() declares ${names.map(n => `'${n}'`).join(", ")}.` : "its configurations() declares no rows."),
      );
    }
    scope.configurationValues = new Map(Object.entries(row));
    return requested;
  }

  // The root run — the defining file renders. The host set the active name
  // before evaluation; the table is recorded whatever is active so the host
  // reads the rows from the render.
  registry.recordConfigurations({ definition, names, rows: table });
  const active = registry.getActiveConfiguration();
  if (active === null) {
    return DEFAULT_CONFIGURATION;
  }
  // Rows are file-wide names, cells are per body: a table without the
  // active name builds its body's Default silently — another body's table
  // may declare it. Only a name NO table declares is reported, once, by
  // the end-of-render check (`warnConfigurationRun`).
  const row = table[active];
  if (!row) {
    return DEFAULT_CONFIGURATION;
  }
  // The row becomes THIS body's layer, read by its own param() calls only.
  registry.setConfiguration(row);
  return active;
}

/**
 * The table must be a plain object of plain objects; every row name
 * non-empty and not the reserved `Default`; every cell a value a `param()`
 * can produce (`validateParamOverrides`).
 */
function validateRows(rows: ConfigurationRows): Record<string, ConfigurationRow> {
  if (rows === null || typeof rows !== "object" || Array.isArray(rows)) {
    throw new BuildError(
      "configurations() takes a plain object of rows — { Name: { label: value, ... }, ... }.",
    );
  }
  const table: Record<string, ConfigurationRow> = {};
  for (const [name, row] of Object.entries(rows)) {
    if (name.trim().length === 0) {
      throw new BuildError("configurations(): a row name is empty — every configuration needs a name.");
    }
    if (name === DEFAULT_CONFIGURATION) {
      throw new BuildError(
        `configurations(): '${DEFAULT_CONFIGURATION}' is reserved for the param() literals and cannot be a row.`,
        "rename the row, or drop it — the literals are always the Default configuration.",
      );
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new BuildError(
        `configurations() row '${name}' must be a plain object of { label: value } — got ${row === null ? "null" : Array.isArray(row) ? "an array" : typeof row}.`,
      );
    }
    validateParamOverrides(`configurations() row '${name}'`, row);
    table[name] = { ...row };
  }
  return table;
}
