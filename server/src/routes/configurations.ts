import { Router, type Response } from 'express';
import { sceneStopFields, sceneUnitFields } from '../fluidcad-server/index.ts';
import type { FluidCadServer, SceneConfigurations, SceneConfigurationTable, SceneRenderedData } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import {
  ConfigurationEditor,
  DEFAULT_CONFIGURATION_NAME,
  type ConfigurationBodyCells,
  type ConfigurationBodyRef,
  type ConfigurationBodyRows,
  type ConfigurationCellValue,
  type ConfigurationEditSpec,
  type ConfigurationTable as SourceConfigurationTable,
} from '../configuration-edit.ts';
import { findInvalidParam } from '../part-catalog/insert-edit.ts';
import { normalizePath } from '../normalize-path.ts';
import { ParamKey, type ParamBodyHolder, type ParamDefinition, type SessionParamOverride } from '../../../lib/dist/index.js';

/**
 * The active configuration of the file on screen, and the tables' rows
 * (`docs/assembly-configurations-plan.md` §3.3, §3.4, §4.2; the multi-part
 * rule of `plans/part-configurations-research.md` D1).
 *
 * - `GET /api/configurations` → `{ active, names, rows, tables, modified }`
 *   as the last render declared them: `names` / `rows` merged over the
 *   file's tables (the dropdown), `tables` one per body that declares one;
 *   `{ active: 'Default', names: [], rows: {}, modified }` for a file
 *   without a `configurations()` table (or before any render).
 * - `POST /api/configurations/select { name }` → switch the session to the
 *   named row (`'Default'` for the literals), drop its overrides, re-render
 *   and fan the render out exactly as `/set-param` does; answers
 *   `{ success: true, configurations }` with the render's summary.
 *
 * The row edits rewrite the current file's `configurations({…})`
 * statements through the same apply-feature round trip `/params/add|update|remove`
 * ride — the editor host rewrites its live buffer (so undo works) and its
 * save re-renders the file — then move the session. Rows are file-wide; a
 * part file with several `part()` bodies keeps each part's cells in that
 * part's own table, so every edit below is ONE rewrite of the file however
 * many tables it touches.
 *
 * A cell is named by its parameter's key, as the Parameters panel keys its
 * rows (`ParamKey.id`): `["lid","Width"]` — the body is the part's hidden
 * identity, its export binding (`export const lid = part('Plate', …)`) or
 * `Name#n` without one — or a bare label that one body of the last render
 * declares (a label two bodies declare is a `400`). A key from an older
 * client naming the body by its part name (`["Plate","Width"]`) means the
 * one part so named, and is a `400` when parts share the name.
 *
 * - `POST /api/configurations/add { name, values?, part?, body? }` → add a
 *   row. Without `values`, the row holds every parameter of the last render
 *   whose current value differs from its literal: the active row's cells
 *   plus the session tweaks (a "Save as…"), or nothing at all on an
 *   untouched Default. Each body's cells go into its own table (created
 *   when it has none); a row with no cell at all goes into the body `part`
 *   (`{ filePath?, line, column }` of its `part()` statement, as
 *   `/params/add` takes it) or `body` (its identity, or the name of the
 *   one part so named) names — the file's only body without either. Then
 *   selects the new row.
 * - `POST /api/configurations/save { values? }` → write cells into the
 *   ACTIVE row — into each body's table, adding the row to a table that
 *   lacks it; without `values`, the session's overrides with their current
 *   values. Refused on Default (`400`), which has no row. Then clears the
 *   session layer, so the row is the value.
 * - `POST /api/configurations/rename { from, to }` → rename a row in every
 *   table that has it, refused when any table has `to`; the session's active
 *   name follows when it was the one renamed.
 * - `POST /api/configurations/remove { name }` → remove a row from every
 *   table that has it — a table it empties goes, and the import once no
 *   table is left; an active row goes back to Default.
 * - `POST /api/configurations/table { rows, renames?, removed?, part?, body? }`
 *   → the Manage grid's commit, ONE rewrite of the file: `renames` (from →
 *   to) and `removed` name rows as the tables have them now, `rows` maps a
 *   row name (after the renames) to `{ <param key>: value | null }` — a
 *   value sets the cell in its body's table, null unsets it (back to the
 *   literal); a row a table lacks is added there, and a new row with no
 *   cell goes into the `part` / `body` home as `add` does. The active name
 *   follows a rename; a removed active row goes back to Default.
 * - `GET /api/configurations/table` → `{ tables }`: the current file's
 *   tables as its live code writes them (`ConfigurationEditor.readTables` —
 *   each `{ body, name, line, rows }`, `body` the body's identity as the
 *   last render filed it and `name` its part name, each cell
 *   `{ literal?, text }`, an expression cell without `literal`), empty
 *   without an addressable one.
 *
 * Two parts of one name are two bodies, each with its own table. A refusal
 * of the editor's (an unknown row, a reserved name, a non-literal table) is
 * a `400` with its message; `404` with no scene; the host's own refusal
 * (`422`/`504`) as the dispatcher reports it. The edit lands first and the
 * host's re-render carries the new tables, so the answer's `configurations`
 * is the summary as it will be once that render arrives.
 */
export function createConfigurationsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
  dispatcher?: FeatureEditDispatcher,
): Router {
  const router = Router();
  const broadcastRender = sceneRenderedBroadcaster(sendToExtension, broadcastToUI);

  /** The current file, or a 404 answered. */
  function currentFile(res: Response): string | null {
    const file = fluidCadServer.getCurrentFileName();
    if (!file) {
      res.status(404).json({ error: 'No active scene' });
      return null;
    }
    return file;
  }

  /**
   * Rewrite the current file's tables. The editor's verdict is read against
   * the server's copy of the code first — its refusals are the request's
   * `400`s — and the spec then rides the dispatcher to the host's live
   * buffer. True when the edit landed; the response is answered otherwise.
   */
  async function rewrite(res: Response, file: string, edit: ConfigurationEditSpec): Promise<boolean> {
    const code = fluidCadServer.getCurrentCode();
    if (code !== null) {
      const verdict = await ConfigurationEditor.apply(code, edit);
      if (verdict.error !== undefined) {
        res.status(400).json({ error: verdict.error });
        return false;
      }
    }
    if (!dispatcher) {
      res.status(422).json({ success: false, reason: 'this server cannot edit the configurations() table' });
      return false;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: file,
      producers: [],
      parts: [],
      imports: [],
      configurationEdit: edit,
    };
    const sent = await dispatcher.send(spec);
    if (sent.error !== undefined) {
      const timedOut = sent.error.startsWith('the editor did not apply');
      res.status(timedOut ? 504 : 422).json({ success: false, reason: sent.error });
      return false;
    }
    return true;
  }

  /** A `values` body field as cells, or a `400` answered. Absent → undefined. */
  function cellValues(res: Response, input: unknown): Record<string, ConfigurationCellValue> | undefined | null {
    if (input === undefined || input === null) {
      return undefined;
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      res.status(400).json({ error: 'values must be an object of { label: value }' });
      return null;
    }
    const bad = findInvalidParam(input as Record<string, ConfigurationCellValue>);
    if (bad) {
      res.status(400).json({ error: `Parameter '${ParamKey.parse(bad).label}' has an unsupported value.` });
      return null;
    }
    return input as Record<string, ConfigurationCellValue>;
  }

  /** A name field as a row name, or a `400` answered. */
  function rowName(res: Response, input: unknown, field: string): string | null {
    if (typeof input !== 'string' || input.trim() === '') {
      res.status(400).json({ error: `${field} must be a non-empty string — a configuration row` });
      return null;
    }
    return input;
  }

  /** The request's home body (`part` / `body`), or a `400` answered. */
  function homeOf(res: Response, targets: ConfigurationTargets, body: any): BodyHome | null {
    const home = targets.home(body?.part, body?.body);
    if ('error' in home) {
      res.status(400).json({ error: home.error });
      return null;
    }
    return home;
  }

  router.get('/configurations', (_req, res) => {
    const file = fluidCadServer.getCurrentFileName();
    if (!file) {
      res.json({ active: 'Default', names: [], rows: {}, modified: false });
      return;
    }
    res.json(fluidCadServer.getConfigurations(file));
  });

  router.post('/configurations/select', async (req, res) => {
    const name = req.body?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name must be a non-empty string — a configuration row, or Default' });
      return;
    }
    const file = currentFile(res);
    if (!file) {
      return;
    }
    fluidCadServer.selectConfiguration(file, name);
    const data = await fluidCadServer.recomputeCurrentFile();
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    broadcastRender(data);
    res.json({ success: true, ...(data.configurations ? { configurations: data.configurations } : {}) });
  });

  router.post('/configurations/add', async (req, res) => {
    const name = rowName(res, req.body?.name, 'name');
    if (name === null) {
      return;
    }
    const explicit = cellValues(res, req.body?.values);
    if (explicit === null) {
      return;
    }
    const file = currentFile(res);
    if (!file) {
      return;
    }
    const targets = new ConfigurationTargets(fluidCadServer.getParamDefinitions(), file);
    const home = homeOf(res, targets, req.body);
    if (!home) {
      return;
    }
    const cells = explicit ? targets.group(explicit) : targets.derived();
    if ('error' in cells) {
      res.status(400).json({ error: cells.error });
      return;
    }
    const edit: ConfigurationEditSpec = {
      kind: 'add',
      name,
      bodies: targets.edits(cells),
      ...(home.ref ? { home: home.ref } : {}),
    };
    if (!await rewrite(res, file, edit)) {
      return;
    }
    // The new row is the one on screen from here: the session's tweaks are
    // its cells now (or were deliberately left out), so the layer clears.
    const forecast = new ConfigurationsForecast(fluidCadServer.getConfigurations(file), targets.soleBody);
    forecast.addRow(name, cells, home.body);
    fluidCadServer.selectConfiguration(file, name);
    res.json({ success: true, configurations: forecast.summary(name, false) });
  });

  router.post('/configurations/save', async (req, res) => {
    const explicit = cellValues(res, req.body?.values);
    if (explicit === null) {
      return;
    }
    const file = currentFile(res);
    if (!file) {
      return;
    }
    const before = fluidCadServer.getConfigurations(file);
    const active = before.active;
    if (active === DEFAULT_CONFIGURATION_NAME) {
      res.status(400).json({
        error: `${DEFAULT_CONFIGURATION_NAME} is the param() literals — the pencil edits them. Pick a row to save into, or Save as… a new one.`,
      });
      return;
    }
    const targets = new ConfigurationTargets(fluidCadServer.getParamDefinitions(), file);
    const cells = explicit ? targets.group(explicit) : targets.overrides(fluidCadServer.getParamOverrideEntries(file));
    if ('error' in cells) {
      res.status(400).json({ error: cells.error });
      return;
    }
    if (cells.size === 0) {
      res.status(400).json({ error: 'Nothing to save — no value differs from the configuration.' });
      return;
    }
    if (!await rewrite(res, file, { kind: 'set', name: active, bodies: targets.edits(cells) })) {
      return;
    }
    // The row holds the values now; re-selecting it drops the session layer.
    const forecast = new ConfigurationsForecast(before, targets.soleBody);
    forecast.setCells(active, cells);
    fluidCadServer.selectConfiguration(file, active);
    res.json({ success: true, configurations: forecast.summary(active, false) });
  });

  router.post('/configurations/rename', async (req, res) => {
    const from = rowName(res, req.body?.from, 'from');
    if (from === null) {
      return;
    }
    const to = rowName(res, req.body?.to, 'to');
    if (to === null) {
      return;
    }
    const file = currentFile(res);
    if (!file) {
      return;
    }
    if (!await rewrite(res, file, { kind: 'rename', from, to })) {
      return;
    }
    const before = fluidCadServer.getConfigurations(file);
    if (before.active === from && to !== from) {
      // The session follows the row under its new name — tweaks included,
      // since selecting is what persists the name and it clears the layer.
      const overrides = fluidCadServer.getParamOverrides(file);
      fluidCadServer.selectConfiguration(file, to);
      fluidCadServer.restoreParamOverrides(file, overrides);
    }
    const forecast = new ConfigurationsForecast(before, null);
    forecast.rename(from, to);
    res.json({ success: true, configurations: forecast.summary(before.active === from ? to : before.active, before.modified) });
  });

  router.post('/configurations/remove', async (req, res) => {
    const name = rowName(res, req.body?.name, 'name');
    if (name === null) {
      return;
    }
    const file = currentFile(res);
    if (!file) {
      return;
    }
    if (!await rewrite(res, file, { kind: 'remove', name })) {
      return;
    }
    const before = fluidCadServer.getConfigurations(file);
    if (before.active === name) {
      // Deliberately removed: back to Default now, rather than the render's
      // "no longer declared" fallback and its notice.
      fluidCadServer.selectConfiguration(file, DEFAULT_CONFIGURATION_NAME);
    }
    const forecast = new ConfigurationsForecast(before, null);
    forecast.remove(name);
    res.json({
      success: true,
      configurations: before.active === name
        ? forecast.summary(DEFAULT_CONFIGURATION_NAME, false)
        : forecast.summary(before.active, before.modified),
    });
  });

  router.get('/configurations/table', async (_req, res) => {
    const file = currentFile(res);
    if (!file) {
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (code === null) {
      res.status(404).json({ error: 'No live code for the current file' });
      return;
    }
    const targets = new ConfigurationTargets(fluidCadServer.getParamDefinitions(), file);
    const tables = await ConfigurationEditor.readTables(code);
    res.json({ tables: tables.map((table) => targets.sourceTable(table)) });
  });

  router.post('/configurations/table', async (req, res) => {
    const request = tableRequest(req.body);
    if (typeof request === 'string') {
      res.status(400).json({ error: request });
      return;
    }
    const file = currentFile(res);
    if (!file) {
      return;
    }
    const targets = new ConfigurationTargets(fluidCadServer.getParamDefinitions(), file);
    const home = homeOf(res, targets, req.body);
    if (!home) {
      return;
    }
    const byBody = targets.groupRows(request.rows, home.body);
    if ('error' in byBody) {
      res.status(400).json({ error: byBody.error });
      return;
    }
    const edit: ConfigurationEditSpec = {
      kind: 'table',
      bodies: targets.rowEdits(byBody),
      ...(home.ref ? { home: home.ref } : {}),
      ...(request.renames ? { renames: request.renames } : {}),
      ...(request.removed ? { removed: request.removed } : {}),
    };
    if (!await rewrite(res, file, edit)) {
      return;
    }
    const before = fluidCadServer.getConfigurations(file);
    const renames = request.renames ?? {};
    const removed = request.removed ?? [];
    let active = before.active;
    if (removed.includes(before.active)) {
      active = DEFAULT_CONFIGURATION_NAME;
      fluidCadServer.selectConfiguration(file, active);
    } else if (renames[before.active] !== undefined && renames[before.active] !== before.active) {
      // As /rename: the session follows the row under its new name, tweaks included.
      active = renames[before.active];
      const overrides = fluidCadServer.getParamOverrides(file);
      fluidCadServer.selectConfiguration(file, active);
      fluidCadServer.restoreParamOverrides(file, overrides);
    }
    const forecast = new ConfigurationsForecast(before, targets.soleBody);
    forecast.applyTable(byBody, renames, removed, Object.keys(request.rows), home.body);
    const modified = active === before.active ? before.modified : Object.keys(fluidCadServer.getParamOverrides(file)).length > 0;
    res.json({ success: true, configurations: forecast.summary(active, modified) });
  });

  return router;
}

/**
 * Fan a configuration re-render out to the editor host and the pages, as
 * `/set-param` does — shared with the screenshot route's configuration
 * round trip (`screenshot-configuration.ts`).
 */
export function sceneRenderedBroadcaster(
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
): (data: SceneRenderedData) => void {
  return (data) => {
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      result: data.result,
      ...sceneStopFields(data),
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      ...sceneStopFields(data),
      params: data.params,
      properties: data.properties,
      ...(data.configurations ? { configurations: data.configurations } : {}),
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
  };
}

/** Cells grouped by the body whose table holds them: body (its identity, null for the file's only body) → label → value. */
type BodyCells = Map<string | null, Record<string, ConfigurationCellValue>>;

/** A grid commit grouped the same way: body → row name → label → value, or null to unset. */
type BodyRows = Map<string | null, Record<string, Record<string, ConfigurationCellValue | null>>>;

/** Where a row with no cell goes: the editor's reference to the body, and its identity for the forecast. */
type BodyHome = { ref?: ConfigurationBodyRef; body: string | null };

/** The table route's body, before its keys are resolved. */
type TableRequest = {
  rows: Record<string, Record<string, ConfigurationCellValue | null>>;
  renames?: Record<string, string>;
  removed?: string[];
};

/**
 * Where the panel's cells go in the current file: each parameter by its
 * key (`ParamKey.id`) resolved against the last render's definitions to the
 * body that declares it, and each body to the reference the editor
 * addresses it by — its identity, plus its `part()` statement's location
 * when it is a part. A body is its identity, so two parts of one name are
 * two bodies. A parameter of a part from another file (built at the top
 * level of this one) is no cell of this file's tables.
 */
class ConfigurationTargets {
  private readonly definitions: ParamDefinition[];
  /** label → the bodies of this file declaring it, for a bare-label or name-keyed key. */
  private readonly holders: Map<string, ParamBodyHolder[]>;

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
  groupRows(rows: TableRequest['rows'], home: string | null): BodyRows | { error: string } {
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
   * column }`, the Add-to part) and/or its identity (or the name of the one
   * part so named). Neither: the file's only body.
   */
  home(part: unknown, body: unknown): BodyHome | { error: string } {
    if (body !== undefined && body !== null && (typeof body !== 'string' || body === '')) {
      return { error: 'body must be the id of the part the configuration goes in' };
    }
    if (part === undefined || part === null) {
      if (typeof body === 'string') {
        const named = this.bodyNamed(body);
        if (typeof named !== 'string') {
          return named;
        }
        return { ref: this.ref(named), body: named };
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
    let named: string | null = this.definitions.find((def) => def.part?.line === line)?.body ?? null;
    if (typeof body === 'string') {
      const resolved = this.bodyNamed(body);
      if (typeof resolved !== 'string') {
        return resolved;
      }
      named = resolved;
    }
    return {
      ref: { ...(named !== null ? { body: named } : {}), part: { line: line as number, column: (column as number | undefined) ?? 0 } },
      body: named,
    };
  }

  /**
   * A source table as the panel reads it: under the identity the last
   * render filed its body's parameters by — found by the definition call's
   * line, which is `ParamDefinition.part` — else the identity the source
   * spells, with its part name beside it.
   */
  sourceTable(table: SourceConfigurationTable): Omit<SourceConfigurationTable, 'id' | 'call'> & { name: string | null } {
    const rendered = this.definitions.find((def) => def.part !== undefined && def.part.line === table.call.line)?.body;
    const { id, call: _call, body: name, ...rest } = table;
    return { ...rest, body: rendered ?? id ?? name, name };
  }

  /**
   * The body a request's `body` names: a body of that identity, else the
   * one body of that name (an older client's); refused when parts share
   * the name. A body no definition has is passed on as it is.
   */
  private bodyNamed(body: string): string | { error: string } {
    if (this.definitions.some((def) => def.body === body)) {
      return body;
    }
    const named = [...new Set(this.definitions.filter((def) => def.bodyName === body).map((def) => def.body!))];
    if (named.length > 1) {
      return { error: `${named.length} parts of this file are named '${body}' — name the part by its id: ${named.map((b) => `'${b}'`).join(' or ')}.` };
    }
    return named[0] ?? body;
  }

  /** The editor's reference to a body: its identity, and its `part()` statement when it is a part. Null: the only body. */
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
   * The body and label a key names: its own body (by identity, or by the
   * name of the one part so named), or for a bare label the one body
   * declaring it (none yet: the file's only body). A label two bodies
   * declare, or a name two parts share, is refused — a cell meant for one
   * part must not land in another's table.
   */
  private resolve(key: ParamKey): { body: string | null; label: string } | { error: string } {
    if (!key.labelOnly) {
      const resolved = ParamKey.resolveBody(key.body!, key.label, this.holders);
      if ('error' in resolved) {
        return { error: resolved.error };
      }
      if (!this.definitions.some((def) => def.body === resolved.key.body)) {
        return { error: `${key.describe()} is no parameter of this file's parts — a configuration sets the parameters of the file that declares it.` };
      }
      return { body: resolved.key.body, label: key.label };
    }
    const resolved = ParamKey.resolveLabel(key.label, this.holders);
    if ('error' in resolved) {
      const bodies = this.holders.get(key.label) ?? [];
      const keys = resolved.bodies.map((body) => JSON.stringify([body, key.label])).join(' or ');
      return { error: `Parameter '${key.label}' is declared by ${ParamKey.labels(bodies).join(' and ')} — key its cell by its part: ${keys}.` };
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
class ConfigurationsForecast {
  private readonly tables: SceneConfigurationTable[];
  private readonly reportTables: boolean;

  constructor(before: SceneConfigurations, private readonly soleBody: string | null) {
    this.reportTables = before.tables !== undefined;
    this.tables = before.tables
      ? before.tables.map((table) => ({ ...table, names: table.names.slice(), rows: ConfigurationsForecast.copyRows(table.rows) }))
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

/** The table route's body, or why it is malformed. */
function tableRequest(body: unknown): TableRequest | string {
  const input = (body ?? {}) as { rows?: unknown; renames?: unknown; removed?: unknown };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(input.rows)) {
    return 'rows must be an object of { name: { label: value | null } }';
  }
  const rows: TableRequest['rows'] = {};
  for (const [name, cells] of Object.entries(input.rows)) {
    if (!isRecord(cells)) {
      return `rows["${name}"] must be an object of { label: value | null }`;
    }
    const set: Record<string, ConfigurationCellValue> = {};
    for (const [label, value] of Object.entries(cells)) {
      if (value !== null) {
        set[label] = value as ConfigurationCellValue;
      }
    }
    const bad = findInvalidParam(set);
    if (bad) {
      return `Parameter '${ParamKey.parse(bad).label}' has an unsupported value.`;
    }
    rows[name] = cells as Record<string, ConfigurationCellValue | null>;
  }
  const edit: TableRequest = { rows };
  if (input.renames !== undefined && input.renames !== null) {
    if (!isRecord(input.renames) || Object.values(input.renames).some((to) => typeof to !== 'string')) {
      return 'renames must be an object of { from: to }';
    }
    edit.renames = input.renames as Record<string, string>;
  }
  if (input.removed !== undefined && input.removed !== null) {
    if (!Array.isArray(input.removed) || input.removed.some((name) => typeof name !== 'string')) {
      return 'removed must be an array of configuration names';
    }
    edit.removed = input.removed as string[];
  }
  return edit;
}
