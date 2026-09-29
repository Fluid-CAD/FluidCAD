import { Router, type Response } from 'express';
import { sceneStopFields, sceneUnitFields } from '../fluidcad-server/index.ts';
import { UI_APPLY_WAIT_MS } from './render.ts';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import { DeclarationRefactor } from '../declaration-refactor.ts';
import { DeclarationRewrite } from '../declaration-rewrite.ts';
import {
  ParamEditor,
  MULTI_CONTROL_TYPES,
  PARAM_TYPES,
  type MultiControlType,
  type ParamEditSpec,
  type ParamLiteral,
  type ParamPartTarget,
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

/**
 * The `part()` statement a new declaration goes into — the Add dialog's Part
 * choice, as `{filePath, line, column}` of the statement the render captured.
 * Null when the body does not describe one.
 */
function validPartLocation(input: unknown): (ParamPartTarget & { filePath: string }) | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const { filePath, line, column } = input as Record<string, unknown>;
  if (typeof filePath !== 'string' || filePath === '') {
    return null;
  }
  if (!Number.isInteger(line) || (line as number) < 1 || !Number.isInteger(column) || (column as number) < 0) {
    return null;
  }
  return { filePath, line: line as number, column: column as number };
}

export function createParamsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
  dispatcher: FeatureEditDispatcher,
  awaitSceneApplied: (timeoutMs: number) => Promise<boolean> = async () => false,
  workspacePath = '',
): Router {
  const router = Router();
  // A rename or delete reaches every file that reads the declaration, not
  // just the one on screen: the refactor finds them across the workspace and
  // sends their edits ahead of the declaring file's.
  const refactor = new DeclarationRefactor(fluidCadServer, workspacePath, dispatcher);

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
      ...(data.assembly ? { assembly: data.assembly } : {}),
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

  router.post('/recompute', async (req, res) => {
    // `changes: true` (the MCP's recompute) adds the render's change summary
    // to the response — every object rebuilt, with bounds before and after.
    const data = await fluidCadServer.recomputeCurrentFile(true, req.body?.changes === true ? { changes: true } : undefined);
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
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
      breakpointHit: data.breakpointHit,
      params: data.params,
      properties: data.properties,
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
    // A recompute that runs to completion can still leave features broken —
    // report which ones instead of a bare success. See `RenderOutcome`.
    // `awaitUi: true` (the MCP's recompute): answer once a viewer has the
    // render on screen — see `RenderOutcome.uiApplied`.
    const uiApplied = req.body?.awaitUi === true ? await awaitSceneApplied(UI_APPLY_WAIT_MS) : undefined;
    res.json({
      success: true,
      state: data.objectErrors.length > 0 ? 'build-error' : 'rendered',
      objectErrors: data.objectErrors,
      ...(data.changes ? { changes: data.changes } : {}),
      ...(uiApplied !== undefined ? { uiApplied } : {}),
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
   * variable it binds, every file that reads it, and what a delete would put
   * in place of those reads — or which of them it cannot, so the dialog can
   * refuse the delete up front.
   */
  router.get('/params/usage', async (req, res) => {
    const label = typeof req.query.label === 'string' ? req.query.label : '';
    const line = Number(req.query.line);
    const filePath = typeof req.query.filePath === 'string' && req.query.filePath !== ''
      ? req.query.filePath
      : fluidCadServer.getCurrentFileName();
    if (label === '') {
      res.status(400).json({ error: 'label is required' });
      return;
    }
    const code = filePath ? await refactor.readFile(filePath) : null;
    if (code === null) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    try {
      const usage = await ParamEditor.inspect(code, label, Number.isInteger(line) ? line : undefined, filePath);
      res.json(await refactor.extendReport(usage));
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
    if (req.body?.assembly === true) {
      if (req.body.part != null) {
        res.status(400).json({ error: 'Choose either assembly or part scope' });
        return;
      }
      await dispatchParamEdit(res, { kind: 'add', param: spec, assembly: true });
      return;
    }
    // The Part dropdown's choice: the declaration goes into that part's
    // callback body, in the file that declares the part. A parameter only
    // lives inside a part body, so there is no add without one.
    const part = validPartLocation(req.body?.part);
    if (!part) {
      res.status(400).json({
        error: 'part must be {filePath, line, column} of the part() statement the parameter is declared in',
      });
      return;
    }
    // No variable name on the wire: the editor derives one from the label
    // against the file it is about to write, which is the only place that can
    // see what the name would collide with.
    await dispatchParamEdit(res, {
      kind: 'add',
      param: spec,
      part: { line: part.line, column: part.column },
      ...(req.body?.exposeAsProperty === true ? { exposeAsProperty: true } : {}),
    }, part.filePath);
  });

  router.post('/params/update', async (req, res) => {
    const { label, line, filePath, param } = req.body ?? {};
    const spec = validParamSpec(param);
    if (typeof label !== 'string' || label === '' || spec === null) {
      res.status(400).json({ error: 'label and a well-formed param are required' });
      return;
    }
    const sessionId = fluidCadServer.getCurrentFileName();
    const declaringFile = typeof filePath === 'string' && filePath !== '' ? filePath : sessionId;
    const at = Number.isInteger(line) ? line : undefined;
    let variable: string | undefined;
    if (spec.label !== label) {
      // A new label renames the variable it suggests — derived here, against
      // the declaring file, the only place that knows which names are free —
      // and every other file that reads the declaration follows first.
      const code = declaringFile ? await refactor.readFile(declaringFile) : null;
      if (code === null) {
        res.status(404).json({ error: 'No active scene' });
        return;
      }
      const planned = await ParamEditor.plan(code, label, at, declaringFile);
      if ('error' in planned) {
        res.status(422).json({ success: false, reason: planned.error });
        return;
      }
      const { plan, tree } = planned;
      const current = plan.declaration.variable;
      if (current !== null) {
        variable = ParamEditor.variableNameFor(spec.label, tree, current);
      }
      const renamed = variable !== undefined && variable !== current;
      const newVariable = renamed ? variable! : null;
      const newExport = renamed && plan.declaration.variableExport === current ? variable! : plan.declaration.variableExport;
      const specs = await refactor.renameSpecs(plan.declaration, spec.label, newVariable, newExport);
      if (!await refactor.dispatchConsumers(res, specs)) {
        return;
      }
    }
    const applied = await dispatchParamEdit(res, {
      kind: 'update',
      expectedLabel: label,
      line: at,
      param: spec,
      ...(variable !== undefined ? { variable } : {}),
    }, declaringFile);
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
    const declaringFile = typeof filePath === 'string' && filePath !== '' ? filePath : sessionId;
    const at = Number.isInteger(line) ? line : undefined;
    // The default value stands in for every read of the parameter, in every
    // file. Where it cannot — it names things only its own scope has — the
    // whole delete is refused before any file changes.
    const code = declaringFile ? await refactor.readFile(declaringFile) : null;
    if (code === null) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    const planned = await ParamEditor.plan(code, label, at, declaringFile);
    if ('error' in planned) {
      res.status(422).json({ success: false, reason: planned.error });
      return;
    }
    const { plan, tree, declaration } = planned;
    const refusal = DeclarationRewrite.inlineRefusal(tree, 'param', declaration, plan);
    if (refusal) {
      res.status(422).json({ success: false, reason: refusal });
      return;
    }
    const consumers = await refactor.inlineSpecs(plan.declaration, plan.value, plan.portable);
    if ('error' in consumers) {
      res.status(422).json({ success: false, reason: consumers.error });
      return;
    }
    if (!await refactor.dispatchConsumers(res, consumers.specs)) {
      return;
    }
    if (await dispatchParamEdit(res, { kind: 'remove', expectedLabel: label, line: at }, declaringFile)) {
      fluidCadServer.forgetParam(sessionId, label);
    }
  });

  return router;
}
