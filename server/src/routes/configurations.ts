import { Router, type Response } from 'express';
import { sceneStopFields, sceneUnitFields } from '../fluidcad-server/index.ts';
import type { FluidCadServer, SceneRenderedData } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import {
  ConfigurationEditor,
  DEFAULT_CONFIGURATION_NAME,
  type ConfigurationCellValue,
  type ConfigurationEditSpec,
} from '../configuration-edit.ts';
import { ConfigurationTargets, ConfigurationsForecast, type BodyHome } from '../configuration-targets.ts';
import { findInvalidParam } from '../part-catalog/insert-edit.ts';
import { ParamKey } from '../../../lib/dist/index.js';

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
 * One value the Parameters panel commits is not a row edit of its own: it
 * goes through `POST /api/params/value` (routes/params.ts), which writes it
 * into the active row's cell here, or into the `param()` literal on Default.
 *
 * A cell is named by its parameter's key, as the Parameters panel keys its
 * rows (`ParamKey.id`): `["Plate","Width"]`, or a bare label that one body
 * of the last render declares (a label two bodies declare is a `400`).
 *
 * - `POST /api/configurations/add { name, values?, part?, body? }` → add a
 *   row. Without `values`, the row holds every parameter of the last render
 *   whose current value differs from its literal: the active row's cells
 *   plus any session tweaks (a "Duplicate…"), or nothing at all on an
 *   untouched Default. Each body's cells go into its own table (created
 *   when it has none); a row with no cell at all goes into the body `part`
 *   (`{ filePath?, line, column }` of its `part()` statement, as
 *   `/params/add` takes it) or `body` (its definition name) names — the
 *   file's only body without either. Then selects the new row.
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
 *   each `{ body, line, rows }`, each cell `{ literal?, text }`, an
 *   expression cell without `literal`), empty without an addressable one.
 *
 * A refusal of the editor's (an unknown row, a reserved name, a non-literal
 * table, two parts of one name) is a `400` with its message; `404` with no
 * scene; the host's own refusal (`422`/`504`) as the dispatcher reports it.
 * The edit lands first and the host's re-render carries the new tables, so
 * the answer's `configurations` is the summary as it will be once that
 * render arrives.
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
    res.json({ tables: await ConfigurationEditor.readTables(code) });
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

/** The table route's body, before its keys are resolved. */
type TableRequest = {
  rows: Record<string, Record<string, ConfigurationCellValue | null>>;
  renames?: Record<string, string>;
  removed?: string[];
};

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
