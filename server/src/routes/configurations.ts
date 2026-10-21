import { Router, type Response } from 'express';
import { sceneStopFields, sceneUnitFields } from '../fluidcad-server/index.ts';
import type { FluidCadServer, SceneConfigurations, SceneRenderedData } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import {
  ConfigurationEditor,
  DEFAULT_CONFIGURATION_NAME,
  type ConfigurationCellValue,
  type ConfigurationEditSpec,
  type ConfigurationTableEdit,
} from '../configuration-edit.ts';
import { findInvalidParam } from '../part-catalog/insert-edit.ts';

/**
 * The active configuration of the file on screen, and the table's rows
 * (`docs/assembly-configurations-plan.md` §3.3, §3.4, §4.2).
 *
 * - `GET /api/configurations` → `{ active, names, rows, modified }` as the
 *   last render declared them; `{ active: 'Default', names: [], rows: {},
 *   modified }` for a file without a `configurations()` table (or before any
 *   render).
 * - `POST /api/configurations/select { name }` → switch the session to the
 *   named row (`'Default'` for the literals), drop its overrides, re-render
 *   and fan the render out exactly as `/set-param` does; answers
 *   `{ success: true, configurations }` with the render's summary.
 *
 * The row edits rewrite the current file's `configurations({…})` statement
 * through the same apply-feature round trip `/params/add|update|remove`
 * ride — the editor host rewrites its live buffer (so undo works) and its
 * save re-renders the file — then move the session:
 *
 * - `POST /api/configurations/add { name, values? }` → append a row. Without
 *   `values`, the row holds every label of the last render whose current
 *   value differs from its literal: the active row's cells plus the session
 *   tweaks (a "Save as…"), or nothing at all on an untouched Default. Then
 *   selects the new row.
 * - `POST /api/configurations/save { values? }` → write cells into the
 *   ACTIVE row; without `values`, the session's touched labels with their
 *   current values. Refused on Default (`400`), which has no row. Then
 *   clears the session layer, so the row is the value.
 * - `POST /api/configurations/rename { from, to }` → rename a row; the
 *   session's active name follows when it was the one renamed.
 * - `POST /api/configurations/remove { name }` → remove a row; an active row
 *   goes back to Default.
 * - `POST /api/configurations/table { rows, renames?, removed? }` → the
 *   Manage grid's commit, ONE rewrite of the statement: `renames` (from →
 *   to) and `removed` name rows as the table has them now, `rows` maps a
 *   row name (after the renames) to `{ label: value | null }` — a value
 *   sets the cell, null unsets it (back to the literal); a row the table
 *   lacks is appended. The active name follows a rename; a removed active
 *   row goes back to Default.
 * - `GET /api/configurations/table` → `{ table }`: the current file's table
 *   as its live code writes it (`ConfigurationEditor.readTable` — each cell
 *   `{ literal?, text }`, an expression cell without `literal`), or
 *   `{ table: null }` without an addressable one.
 *
 * A refusal of the editor's (an unknown row, a reserved name, a non-literal
 * table) is a `400` with its message; `404` with no scene; the host's own
 * refusal (`422`/`504`) as the dispatcher reports it. The edit lands first
 * and the host's re-render carries the new table, so the answer's
 * `configurations` is the summary as it will be once that render arrives.
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
   * Rewrite the current file's table. The editor's verdict is read against
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
      res.status(400).json({ error: `Parameter '${bad}' has an unsupported value.` });
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

  /**
   * The row "Add" writes without explicit values: every label of the last
   * render whose current value — override, else the active row's cell, else
   * the literal — differs from the literal. Globals are never a body's row.
   */
  function derivedValues(): Record<string, ConfigurationCellValue> {
    const out: Record<string, ConfigurationCellValue> = {};
    for (const def of fluidCadServer.getParamDefinitions()) {
      if (def.kind === 'global') {
        continue;
      }
      if (!sameValue(def.currentValue, def.defaultValue)) {
        out[def.label] = def.currentValue as ConfigurationCellValue;
      }
    }
    return out;
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
    const values = explicit ?? derivedValues();
    if (!await rewrite(res, file, { kind: 'add', name, values })) {
      return;
    }
    // The new row is the one on screen from here: the session's tweaks are
    // its cells now (or were deliberately left out), so the layer clears.
    const before = fluidCadServer.getConfigurations(file);
    fluidCadServer.selectConfiguration(file, name);
    res.json({
      success: true,
      configurations: {
        active: name,
        names: [...before.names.filter((n) => n !== name), name],
        rows: { ...before.rows, [name]: literalCells(values) },
        modified: false,
      } satisfies SceneConfigurations,
    });
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
    const values = explicit ?? fluidCadServer.getParamOverrides(file);
    if (Object.keys(values).length === 0) {
      res.status(400).json({ error: 'Nothing to save — no value differs from the configuration.' });
      return;
    }
    if (!await rewrite(res, file, { kind: 'set', name: active, values })) {
      return;
    }
    // The row holds the values now; re-selecting it drops the session layer.
    fluidCadServer.selectConfiguration(file, active);
    res.json({
      success: true,
      configurations: {
        active,
        names: before.names,
        rows: { ...before.rows, [active]: { ...before.rows[active], ...literalCells(values) } },
        modified: false,
      } satisfies SceneConfigurations,
    });
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
      for (const [label, value] of Object.entries(overrides)) {
        fluidCadServer.setParam(file, label, value);
      }
    }
    const rows: SceneConfigurations['rows'] = {};
    for (const [rowKey, cells] of Object.entries(before.rows)) {
      rows[rowKey === from ? to : rowKey] = cells;
    }
    res.json({
      success: true,
      configurations: {
        active: before.active === from ? to : before.active,
        names: before.names.map((n) => (n === from ? to : n)),
        rows,
        modified: before.modified,
      } satisfies SceneConfigurations,
    });
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
    const rows = { ...before.rows };
    delete rows[name];
    res.json({
      success: true,
      configurations: {
        active: before.active === name ? DEFAULT_CONFIGURATION_NAME : before.active,
        names: before.names.filter((n) => n !== name),
        rows,
        modified: before.active === name ? false : before.modified,
      } satisfies SceneConfigurations,
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
    res.json({ table: await ConfigurationEditor.readTable(code) });
  });

  router.post('/configurations/table', async (req, res) => {
    const edit = tableEdit(req.body);
    if (typeof edit === 'string') {
      res.status(400).json({ error: edit });
      return;
    }
    const file = currentFile(res);
    if (!file) {
      return;
    }
    if (!await rewrite(res, file, { kind: 'table', ...edit })) {
      return;
    }
    const before = fluidCadServer.getConfigurations(file);
    const renames = edit.renames ?? {};
    const removed = edit.removed ?? [];
    let active = before.active;
    if (removed.includes(before.active)) {
      active = DEFAULT_CONFIGURATION_NAME;
      fluidCadServer.selectConfiguration(file, active);
    } else if (renames[before.active] !== undefined && renames[before.active] !== before.active) {
      // As /rename: the session follows the row under its new name, tweaks included.
      active = renames[before.active];
      const overrides = fluidCadServer.getParamOverrides(file);
      fluidCadServer.selectConfiguration(file, active);
      for (const [label, value] of Object.entries(overrides)) {
        fluidCadServer.setParam(file, label, value);
      }
    }
    const names: string[] = [];
    const rows: SceneConfigurations['rows'] = {};
    for (const name of before.names) {
      if (removed.includes(name)) {
        continue;
      }
      const renamed = renames[name] ?? name;
      names.push(renamed);
      rows[renamed] = { ...before.rows[name] };
    }
    for (const [name, cells] of Object.entries(edit.rows)) {
      if (!names.includes(name)) {
        names.push(name);
        rows[name] = {};
      }
      for (const [label, value] of Object.entries(cells)) {
        if (value === null) {
          delete rows[name][label];
        } else {
          rows[name][label] = literalCells({ [label]: value })[label];
        }
      }
    }
    res.json({
      success: true,
      configurations: {
        active,
        names,
        rows,
        modified: active === before.active ? before.modified : Object.keys(fluidCadServer.getParamOverrides(file)).length > 0,
      } satisfies SceneConfigurations,
    });
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

/** The table route's body as an edit, or why it is malformed. */
function tableEdit(body: unknown): ConfigurationTableEdit | string {
  const input = (body ?? {}) as { rows?: unknown; renames?: unknown; removed?: unknown };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(input.rows)) {
    return 'rows must be an object of { name: { label: value | null } }';
  }
  const rows: ConfigurationTableEdit['rows'] = {};
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
      return `Parameter '${bad}' has an unsupported value.`;
    }
    rows[name] = cells as Record<string, ConfigurationCellValue | null>;
  }
  const edit: ConfigurationTableEdit = { rows };
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

/** The cells as the render will report them: literals as they are, an `{ expr }` cell by its source text. */
function literalCells(values: Record<string, ConfigurationCellValue>): SceneConfigurations['rows'][string] {
  const out: SceneConfigurations['rows'][string] = {};
  for (const [label, value] of Object.entries(values)) {
    out[label] = typeof value === 'object' && !Array.isArray(value) ? value.expr : value;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}
