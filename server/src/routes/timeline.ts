import { Router } from 'express';
import { sceneStopFields, sceneUnitFields } from '../fluidcad-server/index.ts';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import type { SketchImageEdit } from '../code-editor/index.ts';
import { MaterialCatalog } from '../material-catalog.ts';
import { MoveToPart } from '../move-to-part.ts';
import { PartRename } from '../part-rename.ts';
import { DeclarationRefactor } from '../declaration-refactor.ts';
import type { ProjectMaterials } from '../project-config.ts';
import { RemoveFeature } from '../remove-feature.ts';
import { WorkspaceConnectorReads } from '../hole-connectors.ts';
import { WorkspaceScripts } from '../workspace-scripts.ts';
import { TimelineBreakpoint } from '../timeline-breakpoint.ts';

/** A finite number, or undefined for an absent optional field. */
function optionalFinite(value: unknown): number | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : false;
}

/**
 * The Image tool's record as the route accepts it: a non-empty path, a
 * positive width and/or height, and well-formed optional centre, angle and
 * opacity (0…1) — the same rules the lib applies to the written statement, so
 * a rejected edit never reaches the host.
 */
function isSketchImageEdit(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.src !== 'string' || v.src.trim() === '') {
    return false;
  }
  const width = optionalFinite(v.width);
  const height = optionalFinite(v.height);
  if (width === false || height === false || (width === undefined && height === undefined)) {
    return false;
  }
  if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) {
    return false;
  }
  if (v.at !== undefined && !(Array.isArray(v.at) && v.at.length === 2 && v.at.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
    return false;
  }
  if (optionalFinite(v.angle) === false) {
    return false;
  }
  const opacity = optionalFinite(v.opacity);
  if (opacity === false || (opacity !== undefined && (opacity < 0 || opacity > 1))) {
    return false;
  }
  return true;
}

/** The validated record with only the fields the writer knows. */
function sketchImageEditOf(value: Record<string, any>): SketchImageEdit {
  return {
    src: String(value.src).trim(),
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
    ...(value.at !== undefined ? { at: [value.at[0], value.at[1]] as [number, number] } : {}),
    ...(value.angle !== undefined ? { angle: value.angle } : {}),
    ...(value.opacity !== undefined ? { opacity: value.opacity } : {}),
  };
}

export function createTimelineRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
  options: {
    dispatcher?: FeatureEditDispatcher;
    /** The user's global materials (Settings → Materials); tests inject a map, the app reads the preferences file. */
    loadGlobalMaterials?: () => Promise<ProjectMaterials>;
    /** Where the other model files live — the ones that may read a removed hole's connectors by name. */
    workspacePath?: string;
  } = {},
): Router {
  const router = Router();
  const connectorReads = new WorkspaceConnectorReads(new WorkspaceScripts(fluidCadServer, options.workspacePath ?? ''));
  // A part's rename reaches every file that imports it, not just its own:
  // the refactor finds them across the workspace and sends their edits
  // ahead of the declaring file's.
  const refactor = options.dispatcher
    ? new DeclarationRefactor(fluidCadServer, options.workspacePath ?? '', options.dispatcher)
    : null;

  router.post('/rollback', async (req, res) => {
    const { index, scope } = req.body;
    if (typeof index !== 'number' || index < 0) {
      res.status(400).json({ error: 'Invalid index' });
      return;
    }
    // 'part' scopes the rollback to the target's enclosing part (the
    // timeline's one-click preview); absent keeps the global prefix
    // (edit-session boundaries, MCP, older clients).
    if (scope !== undefined && scope !== 'part') {
      res.status(400).json({ error: "scope must be 'part' when present" });
      return;
    }
    const data = await fluidCadServer.rollbackFromUI(index, scope);
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
      ...(data.assembly ? { assembly: data.assembly } : {}),
      // The last full render's paused state — a refresh replays whatever
      // scene message went out last, and the indicator must survive it.
      breakpointHit: data.breakpointHit,
      objectWarnings: data.objectWarnings,
    });
    // Features inside the rollback scope that failed to build are still
    // broken — a rollback re-emits them, it doesn't repair them.
    res.json({
      success: true,
      state: data.objectErrors.length > 0 ? 'build-error' : 'rendered',
      objectErrors: data.objectErrors,
    });
  });

  // Timeline "Remove". Three forms: `dryRun` analyzes the server's copy of
  // the file and answers the dependants the removal would take along (the
  // UI's "Delete / Cancel" warning) and the connectors it would orphan,
  // without touching the buffer; `cascade` deletes the statement, that whole
  // closure and those connectors through the acked edit dispatcher; the
  // plain form is the legacy host-side single-statement removal (sketch
  // geometry and assembly sweeps happen there).
  router.post('/remove-feature', async (req, res) => {
    const { sourceLocation, dryRun, cascade } = req.body;
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (dryRun || cascade) {
      if (sourceLocation.filePath !== fluidCadServer.getCurrentFileName()) {
        res.status(422).json({ success: false, reason: 'dependants can only be analyzed for the currently rendered file' });
        return;
      }
      const code = fluidCadServer.getCurrentCode();
      if (code === null) {
        res.status(422).json({ success: false, reason: 'no rendered code to analyze — is the file in sync with the last render?' });
        return;
      }
      // A removed hole's connectors go with it unless something reads them —
      // and an assembly reads a part's connectors by name, from its own file.
      const removeFeature = await RemoveFeature.capture(
        code,
        sourceLocation.line,
        (connectors) => connectorReads.unread(sourceLocation.filePath, connectors),
      );
      if ('error' in removeFeature) {
        res.status(422).json({ success: false, reason: removeFeature.error });
        return;
      }
      if (dryRun) {
        const analysis = await RemoveFeature.analyze(code, removeFeature);
        if (analysis.ok === false) {
          res.status(422).json({ success: false, reason: analysis.reason });
        } else {
          res.json({ success: true, dependents: analysis.dependents, connectors: analysis.connectors });
        }
        return;
      }
      if (!options.dispatcher) {
        res.status(503).json({ success: false, reason: 'this server has no edit dispatcher to apply the removal' });
        return;
      }
      const spec: ApplyFeatureEditSpec = {
        feature: 'sketch',
        filePath: sourceLocation.filePath,
        producers: [],
        parts: [],
        imports: [],
        removeFeature,
      };
      await options.dispatcher.dispatch(res, spec, { success: true });
      return;
    }
    sendToExtension({
      type: 'remove-feature',
      filePath: sourceLocation.filePath,
      line: sourceLocation.line,
    });
    res.json({ success: true });
  });

  router.post('/rename-feature', (req, res) => {
    const { sourceLocation, name } = req.body;
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number' ||
      (name !== null && typeof name !== 'string')
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'rename-feature',
      filePath: sourceLocation.filePath,
      line: sourceLocation.line,
      name,
    });
    res.json({ success: true });
  });

  // The part row's Rename: rewrite the name `part('…', …)` takes and rename
  // the variable the part is bound to after it. The files that import the
  // part follow first, so the model never builds against a name that is gone.
  router.post('/rename-part', async (req, res) => {
    const { sourceLocation, name } = req.body ?? {};
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      !Number.isInteger(sourceLocation.line) || sourceLocation.line < 1 ||
      typeof name !== 'string' || name.trim() === ''
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (!options.dispatcher || !refactor) {
      res.status(503).json({ success: false, reason: 'this server has no edit dispatcher to apply the edit' });
      return;
    }
    const { filePath, line } = sourceLocation;
    const code = await refactor.readFile(filePath);
    const plan = code === null ? null : await PartRename.plan(code, filePath, line, name);
    if (plan?.declaration) {
      const specs = await refactor.renameSpecs(plan.declaration, plan.variable, null, plan.variableExport);
      if (!await refactor.dispatchConsumers(res, specs)) {
        return;
      }
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'part',
      filePath,
      producers: [],
      parts: [],
      imports: [],
      partRename: { sourceLine: line, name },
    };
    await options.dispatcher.dispatch(res, spec, { success: true });
  });

  // The Finish Sketch button (closed: true) and the reopen-for-edit gesture
  // (closed: false). Acked through the dispatcher, not fire-and-forget: both
  // callers place or clear a breakpoint right after, and a host that reads
  // its buffer for the second edit before the first landed would drop one.
  router.post('/set-sketch-closed', async (req, res) => {
    const { sourceLocation, closed } = req.body ?? {};
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number' ||
      typeof closed !== 'boolean'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (!options.dispatcher) {
      res.status(503).json({ success: false, reason: 'this server has no edit dispatcher to apply the edit' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: sourceLocation.filePath,
      producers: [],
      parts: [],
      imports: [],
      sketchClosed: { sourceLine: sourceLocation.line, closed },
    };
    await options.dispatcher.dispatch(res, spec, { success: true });
  });

  // The sketch toolbar's Image tool: a new picture in a sketch body
  // (`sketch` + an image record), or the `image()` statement at `target`
  // rewritten. (A picture is deleted from its timeline row, through the
  // generic remove-statement route.) Acked through the dispatcher
  // like set-sketch-closed so the tool can close on the re-render that
  // shows the picture from code.
  router.post('/sketch-image', async (req, res) => {
    const { sketch, target, image } = req.body ?? {};
    const isLocation = (loc: any) => !!loc && typeof loc.filePath === 'string' && typeof loc.line === 'number';
    const creating = isLocation(sketch) && target === undefined && isSketchImageEdit(image);
    const editing = isLocation(target) && sketch === undefined && isSketchImageEdit(image);
    if (!creating && !editing) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (!options.dispatcher) {
      res.status(503).json({ success: false, reason: 'this server has no edit dispatcher to apply the edit' });
      return;
    }
    const record = sketchImageEditOf(image);
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: creating ? sketch.filePath : target.filePath,
      producers: [],
      parts: [],
      imports: [],
      sketchImage: creating
        ? { sketchLine: sketch.line, image: record }
        : { imageLine: target.line, image: record },
    };
    await options.dispatcher.dispatch(res, spec, { success: true });
  });

  // The part row menu's "Set material…" (a material id) and its "None"
  // (null). Acked through the dispatcher like set-sketch-closed so the
  // panel can refresh its mass properties once the re-render has landed.
  router.post('/set-part-material', async (req, res) => {
    const { sourceLocation, material } = req.body ?? {};
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number' ||
      (material !== null && (typeof material !== 'string' || material.trim() === ''))
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (!options.dispatcher) {
      res.status(503).json({ success: false, reason: 'this server has no edit dispatcher to apply the edit' });
      return;
    }
    // A global material is copied into fluidcad.json before the source
    // names it, so the render that follows the edit resolves the id (the
    // file is re-read per render) and the project carries what it uses.
    if (typeof material === 'string') {
      try {
        await MaterialCatalog.adoptForPick(fluidCadServer, material, options.loadGlobalMaterials);
      } catch (err: any) {
        res.status(500).json({ success: false, reason: `Could not copy the material into fluidcad.json: ${err?.message || String(err)}` });
        return;
      }
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'part',
      filePath: sourceLocation.filePath,
      producers: [],
      parts: [],
      imports: [],
      partMaterial: { sourceLine: sourceLocation.line, material },
    };
    await options.dispatcher.dispatch(res, spec, { success: true });
  });

  router.post('/add-breakpoint', (req, res) => {
    const { sourceLocation } = req.body;
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'add-breakpoint',
      filePath: sourceLocation.filePath,
      line: sourceLocation.line,
    });
    res.json({ success: true });
  });

  // One atomic edit of the document's breakpoints: a move (`before` + the
  // stops it passes), Continue (`remove: 'active'` — only the stop the build
  // paused on; a stop later in the file stays pending) or continue-to-end
  // (`remove: 'all'`). `filePath` defaults to the rendered document, which
  // is the only one the edit applies to.
  router.post('/timeline-breakpoint', async (req, res) => {
    const { before, remove } = req.body ?? {};
    const filePath = req.body?.filePath ?? fluidCadServer.getCurrentFileName();
    if (typeof filePath !== 'string' || (before !== null && (!before
      || !Number.isInteger(before.line) || before.line < 1
      || !Number.isInteger(before.column) || before.column < 1))
      || (remove !== undefined && !['passed', 'active', 'all'].includes(remove))) {
      res.status(400).json({ error: 'Invalid breakpoint target' });
      return;
    }
    if (!options.dispatcher) {
      res.status(503).json({ success: false, reason: 'No edit dispatcher is available.' });
      return;
    }
    // The bar belongs to this document. Imported parts keep their own stops.
    if (filePath !== fluidCadServer.getCurrentFileName()) {
      res.status(422).json({ success: false, reason: 'Open this model file to move its breakpoint.' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (code === null) {
      res.status(422).json({ success: false, reason: 'Wait for the model to rebuild, then try again.' });
      return;
    }
    const mode = remove ?? (before ? 'passed' : 'all');
    const active = mode === 'active' ? fluidCadServer.getActiveBreakpoint?.() ?? null : null;
    await options.dispatcher.dispatch(res, {
      feature: 'sketch', filePath, producers: [], parts: [], imports: [],
      timelineBreakpoint: TimelineBreakpoint.capture(code, before, mode, active),
    }, { success: true });
  });

  router.post('/clear-breakpoints', (_req, res) => {
    sendToExtension({ type: 'clear-breakpoints' });
    res.json({ success: true });
  });

  // Timeline drag-drop: move the selected feature statements into a part()
  // callback body. Two phases — a dry-run analyzes against the server's copy
  // of the file and answers the companion set (the UI's "Also moves: …"
  // confirm) without touching the buffer; the real call rides the shared
  // edit dispatcher (preflight refusal, editId ack) like every other
  // statement write, never the legacy fire-and-forget path.
  router.post('/move-to-part', async (req, res) => {
    const { filePath, lines, part, dryRun } = req.body ?? {};
    if (
      typeof filePath !== 'string' ||
      !Array.isArray(lines) ||
      lines.length === 0 ||
      !lines.every((l: unknown) => typeof l === 'number' && Number.isInteger(l) && l >= 1) ||
      !part ||
      typeof part.line !== 'number' ||
      typeof part.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (filePath !== fluidCadServer.getCurrentFileName()) {
      res.status(422).json({ success: false, reason: 'features can only be moved within the currently rendered file' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (code === null) {
      res.status(422).json({ success: false, reason: 'no rendered code to move features in — is the file in sync with the last render?' });
      return;
    }
    const captured = await MoveToPart.captureStatements(code, lines);
    if ('error' in captured) {
      if (dryRun) {
        res.json({ success: false, reason: captured.error });
      } else {
        res.status(422).json({ success: false, reason: captured.error });
      }
      return;
    }
    const moveToPart = { statements: captured.statements, part: { line: part.line, column: part.column } };
    if (dryRun) {
      const analysis = await MoveToPart.analyze(code, moveToPart);
      if (analysis.ok === false) {
        res.json({ success: false, reason: analysis.reason, ...(analysis.needs ? { needs: analysis.needs } : {}) });
      } else {
        res.json({ success: true });
      }
      return;
    }
    if (!options.dispatcher) {
      res.status(503).json({ success: false, reason: 'this server has no edit dispatcher to apply the move' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath,
      producers: [],
      parts: [],
      imports: [],
      moveToPart,
    };
    await options.dispatcher.dispatch(res, spec, { success: true });
  });


  return router;
}
