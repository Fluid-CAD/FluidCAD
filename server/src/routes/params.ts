import { Router, type Response } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import {
  ParamEditor,
  MULTI_CONTROL_TYPES,
  PARAM_TYPES,
  type MultiControlType,
  type ParamEditSpec,
  type ParamLiteral,
  type ParamSpec,
  type ParamType,
  type SelectOption,
} from '../param-edit.ts';

/** A finite number, or undefined for anything else (including a missing key). */
function optionalNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

/** A non-empty trimmed string, or undefined for anything else. */
function optionalText(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed === '' ? undefined : trimmed;
}

function validDefaultValue(input: unknown): ParamLiteral | null {
  if (typeof input === 'string' || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  if (Array.isArray(input)
    && input.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) {
    return input as (string | number)[];
  }
  return null;
}

function validOptions(input: unknown): SelectOption[] | null | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    return null;
  }
  const options: SelectOption[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const { label, value } = raw as { label?: unknown; value?: unknown };
    if (typeof label !== 'string') {
      return null;
    }
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      return null;
    }
    options.push({ label, value });
  }
  return options;
}

/**
 * The declaration the panel wants written, or null when the request body
 * cannot describe one. Shape only — whether it is a *coherent* parameter
 * (a select without options, a default outside its options) is
 * `ParamEditor`'s call, so both the route and the editor round trip agree on
 * the same verdict.
 */
function validParamSpec(input: unknown): ParamSpec | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const defaultValue = validDefaultValue(raw.defaultValue);
  const options = validOptions(raw.options);
  if (label === '' || defaultValue === null || options === null) {
    return null;
  }
  if (!PARAM_TYPES.includes(raw.type as ParamType)) {
    return null;
  }
  if (raw.multiControlType !== undefined
    && !MULTI_CONTROL_TYPES.includes(raw.multiControlType as MultiControlType)) {
    return null;
  }
  const spec: ParamSpec = { label, defaultValue, type: raw.type as ParamType };
  const assign = <K extends keyof ParamSpec>(key: K, value: ParamSpec[K] | undefined) => {
    if (value !== undefined) {
      spec[key] = value;
    }
  };
  assign('group', optionalText(raw.group));
  assign('description', optionalText(raw.description));
  assign('min', optionalNumber(raw.min));
  assign('max', optionalNumber(raw.max));
  assign('step', optionalNumber(raw.step));
  assign('options', options);
  if (raw.multi === true) {
    spec.multi = true;
    assign('multiControlType', raw.multiControlType as MultiControlType | undefined);
  }
  return spec;
}

export function createParamsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();

  /**
   * Re-render after a value override and fan the result out to editor and UI.
   * Answers the request itself when there is no scene; a true return means the
   * caller still owns the response.
   */
  async function recomputeAndBroadcast(res: Response): Promise<boolean> {
    const data = await fluidCadServer.recomputeCurrentFile();
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return false;
    }
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      result: data.result,
      rollbackStop: data.rollbackStop,
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      rollbackStop: data.rollbackStop,
      params: data.params,
    });
    return true;
  }

  /**
   * Send a declaration edit through the shared apply-feature-edit round trip:
   * the host rewrites its live buffer and the resulting save re-renders, so
   * unlike a value override there is nothing to recompute here. Answers the
   * request either way; returns whether the edit actually landed, which the
   * label-keyed override bookkeeping hangs off.
   */
  async function dispatchParamEdit(
    res: Response,
    paramEdit: ParamEditSpec,
    declaringFile?: string,
  ): Promise<boolean> {
    // A model spread over several `.fluid.js` files declares params in each of
    // them, and the host applies the edit to whichever file the spec names —
    // so the edit follows the declaration, not the file on screen. A new
    // declaration has no home yet and lands in the current one.
    const filePath = declaringFile || fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(404).json({ error: 'No active scene' });
      return false;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath,
      producers: [],
      parts: [],
      imports: [],
      paramEdit,
    };
    await dispatcher.dispatch(res, spec, { success: true });
    return res.statusCode < 400;
  }

  router.post('/recompute', async (_req, res) => {
    const data = await fluidCadServer.recomputeCurrentFile(true);
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      result: data.result,
      rollbackStop: data.rollbackStop,
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      breakpointHit: data.breakpointHit,
      params: data.params,
    });
    // A recompute that runs to completion can still leave features broken —
    // report which ones instead of a bare success. See `RenderOutcome`.
    res.json({
      success: true,
      state: data.objectErrors.length > 0 ? 'build-error' : 'rendered',
      objectErrors: data.objectErrors,
    });
  });

  router.post('/set-param', async (req, res) => {
    const { label, value } = req.body;
    if (typeof label !== 'string') {
      res.status(400).json({ error: 'Invalid label' });
      return;
    }
    fluidCadServer.setParam(fluidCadServer.getCurrentFileName(), label, value);
    if (await recomputeAndBroadcast(res)) {
      res.json({ success: true });
    }
  });

  router.post('/reset-params', async (_req, res) => {
    fluidCadServer.resetParams(fluidCadServer.getCurrentFileName());
    if (await recomputeAndBroadcast(res)) {
      res.json({ success: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Declaration edits — the panel writing `param()` calls back to the source
  // ---------------------------------------------------------------------------

  /**
   * What the panel needs before offering to edit or delete a declaration: the
   * variable it binds and how much of the model reads it, so a delete can warn
   * before it breaks the build.
   */
  router.get('/params/usage', async (req, res) => {
    const label = typeof req.query.label === 'string' ? req.query.label : '';
    const line = Number(req.query.line);
    const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
    if (label === '') {
      res.status(400).json({ error: 'label is required' });
      return;
    }
    // Only the file being rendered is readable from here. A param declared in
    // a sibling `.fluid.js` still edits fine — the host owns that buffer — so
    // report "nothing known" rather than a refusal the declaration doesn't
    // deserve; the delete warning degrades to its generic wording.
    if (filePath !== '' && filePath !== fluidCadServer.getCurrentFileName()) {
      res.json({ label, variable: null, references: 0, referenceLines: [], editable: true });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (code === null) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    try {
      res.json(await ParamEditor.inspect(code, label, Number.isInteger(line) ? line : undefined));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/params/add', async (req, res) => {
    const spec = validParamSpec(req.body?.param);
    if (spec === null) {
      res.status(400).json({ error: 'a well-formed param is required' });
      return;
    }
    // No variable name on the wire: the editor derives one from the label
    // against the file it is about to write, which is the only place that can
    // see what the name would collide with.
    await dispatchParamEdit(res, { kind: 'add', param: spec });
  });

  router.post('/params/update', async (req, res) => {
    const { label, line, filePath, param } = req.body ?? {};
    const spec = validParamSpec(param);
    if (typeof label !== 'string' || label === '' || spec === null) {
      res.status(400).json({ error: 'label and a well-formed param are required' });
      return;
    }
    const sessionId = fluidCadServer.getCurrentFileName();
    const applied = await dispatchParamEdit(res, {
      kind: 'update',
      expectedLabel: label,
      line: Number.isInteger(line) ? line : undefined,
      param: spec,
    }, typeof filePath === 'string' ? filePath : undefined);
    // Overrides are keyed by label, so a rename has to carry the user's
    // current value across with it — but only once the edit actually landed.
    if (applied && spec.label !== label) {
      fluidCadServer.renameParam(sessionId, label, spec.label);
    }
  });

  router.post('/params/remove', async (req, res) => {
    const { label, line, filePath } = req.body ?? {};
    if (typeof label !== 'string' || label === '') {
      res.status(400).json({ error: 'label is required' });
      return;
    }
    const sessionId = fluidCadServer.getCurrentFileName();
    if (await dispatchParamEdit(res, {
      kind: 'remove',
      expectedLabel: label,
      line: Number.isInteger(line) ? line : undefined,
    }, typeof filePath === 'string' ? filePath : undefined)) {
      fluidCadServer.forgetParam(sessionId, label);
    }
  });

  return router;
}
