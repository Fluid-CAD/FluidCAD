import { Router } from 'express';
import { describeOcException } from '../../../lib/dist/index.js';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import {
  addBreakpoint,
  removeBreakpoint,
  toggleBreakpoint,
  clearBreakpoints,
  insertPoint,
  removePoint,
  addGuide,
  removeGuide,
  removeStatement,
  setFeatureName,
  insertGeometryCallWithVariable,
  insertLoadCall,
  updateSketchPositions,
  type SketchPositionEdit,
  updateDimension,
  updateDimensionExpressionWithVariable,
  getDimensionExpression,
  getPointExpression,
  extractVariablesInPart,
  extractVariablesInAssembly,
  extractVariablesInScope,
  RenderedProperties,
  type ScopeGlobals,
  type VariableInfo,
} from '../code-editor/index.ts';
import { FeatureNames } from '../feature-names.ts';
import { SketchDeleteSweep } from '../sketch-delete-sweep.ts';
import { validateSketchPositionEdit } from '../sketch-position-validate.ts';
import { updateInsertChain, type InsertChainEdit } from '../insert-chain-edit.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import { GlobalImports } from '../apply-feature-edit/global-imports.ts';
import type { GlobalParamCatalog } from '../global-params/catalog.ts';

const NEW_VAR_NAME_RE = /^[a-zA-Z_$][\w$]*$/;

function validateOneNewVariable(input: unknown): { name: string; initializer: string } | false {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  const obj = input as { name?: unknown; initializer?: unknown };
  if (typeof obj.name !== 'string' || !NEW_VAR_NAME_RE.test(obj.name)) {
    return false;
  }
  if (typeof obj.initializer !== 'string' || obj.initializer.trim() === '') {
    return false;
  }
  return { name: obj.name, initializer: obj.initializer };
}

function validateNewVariable(
  input: unknown,
): { name: string; initializer: string } | { name: string; initializer: string }[] | null | false {
  if (input === undefined || input === null) {
    return null;
  }
  if (Array.isArray(input)) {
    const items = input.map(validateOneNewVariable);
    if (items.some((v) => v === false)) {
      return false;
    }
    const valid = items as { name: string; initializer: string }[];
    return valid.length === 0 ? null : valid;
  }
  return validateOneNewVariable(input);
}

export function createSketchEditsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  workspacePath: string,
  dispatcher?: FeatureEditDispatcher,
  globals?: GlobalParamCatalog,
): Router {
  const router = Router();

  /** The project parameters an expression field offers in the current file (§2.8), or none without a catalog. */
  const scopeGlobals = async (): Promise<ScopeGlobals | undefined> => {
    if (!globals) {
      return undefined;
    }
    const snapshot = await globals.snapshot();
    return {
      params: snapshot.files.flatMap((f) => f.params),
      filePath: fluidCadServer.getCurrentFileName(),
      projectUnit: snapshot.projectUnit,
    };
  };

  /**
   * The file a buffer edit addresses: the request's `filePath` when the host
   * names one, else the rendered model — the sketcher edits the open file.
   */
  const editedFile = (body: { filePath?: unknown }): string =>
    typeof body.filePath === 'string' && body.filePath !== '' ? body.filePath : fluidCadServer.getCurrentFileName();

  /** Write the params-file imports the expressions of a buffer edit need (§2.8). */
  const withGlobalImports = async <T extends { newCode: string; error?: string }>(
    result: T,
    filePath: string,
    expressions: readonly (string | null | undefined)[],
  ): Promise<T> => {
    if (!globals || result.error !== undefined) {
      return result;
    }
    return { ...result, newCode: await GlobalImports.ensure(result.newCode, filePath, expressions, globals) };
  };

  // ---------------------------------------------------------------------------
  // /api/import-file — file I/O for STEP/STP imports
  // ---------------------------------------------------------------------------

  router.post('/import-file', async (req, res) => {
    const { fileName, data } = req.body;
    if (typeof fileName !== 'string' || typeof data !== 'string') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    // Older engines return nothing from importFile; the report fields are
    // then simply absent from the response.
    let report: { solidCount?: number; sourceUnits?: { length: string[]; angle: string[] } } | undefined;
    try {
      report = (await fluidCadServer.importFile(workspacePath, fileName, data)) as typeof report;
    } catch (err: any) {
      res.status(500).json({ error: describeOcException(err) });
      return;
    }

    const loadName = fileName.replace(/\.(step|stp)$/i, '');
    sendToExtension({
      type: 'insert-load',
      filePath: fluidCadServer.getCurrentFileName(),
      fileName: loadName,
    });
    res.json({
      success: true,
      fileName: loadName,
      ...(report?.solidCount !== undefined ? { solidCount: report.solidCount } : {}),
      ...(report?.sourceUnits ? { sourceUnits: report.sourceUnits } : {}),
    });
  });

  // ---------------------------------------------------------------------------
  // Sketch interactive — IPC pass-through to the extension
  // ---------------------------------------------------------------------------

  router.post('/insert-point', (req, res) => {
    const { point, sourceLocation } = req.body;
    if (
      !Array.isArray(point) || point.length !== 2 ||
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'insert-point',
      point: point as [number, number],
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/remove-point', (req, res) => {
    const { point, sourceLocation } = req.body;
    if (
      !Array.isArray(point) || point.length !== 2 ||
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'remove-point',
      point: point as [number, number],
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/add-guide', (req, res) => {
    const { sourceLocation } = req.body;
    if (
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'add-guide',
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/remove-guide', (req, res) => {
    const { sourceLocation } = req.body;
    if (
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'remove-guide',
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/insert-geometry', (req, res) => {
    const { statement, sketchSourceLocation, newVariable } = req.body;
    if (
      typeof statement !== 'string' ||
      !sketchSourceLocation || typeof sketchSourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const nv = validateNewVariable(newVariable);
    if (nv === false) {
      res.status(400).json({ error: 'Invalid newVariable' });
      return;
    }
    sendToExtension({
      type: 'insert-geometry',
      statement,
      sketchSourceLocation,
      newVariable: nv,
    });
    res.json({ success: true });
  });

  // Solved-sketch batch write-back (sketch-rewrite P4): every drifted literal
  // across multiple statements in one edit (one undo step). Unlike the legacy
  // fire-and-forget position routes this one answers with the edit's true
  // outcome: a preflight dry-run refuses drift fast, then the editor's
  // edit-ack settles the request (422 on refusal, 504 on a silent editor,
  // 503 with no editor attached).
  router.post('/update-sketch-positions', async (req, res) => {
    const { filePath, edits } = req.body ?? {};
    if (!Array.isArray(edits) || edits.length === 0
      || (filePath !== undefined && typeof filePath !== 'string')) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const validated: SketchPositionEdit[] = [];
    for (const edit of edits) {
      const v = validateSketchPositionEdit(edit);
      if (!v) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      validated.push(v);
    }

    if (!filePath || filePath === fluidCadServer.getCurrentFileName()) {
      const code = fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await updateSketchPositions(code, validated);
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
          }
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }

    if (!dispatcher) {
      sendToExtension({ type: 'update-sketch-positions', filePath, edits: validated });
      res.json({ success: true });
      return;
    }
    await dispatcher.dispatchAction(res, (editId) => ({
      type: 'update-sketch-positions',
      editId,
      filePath,
      edits: validated,
    }));
  });

  router.post('/update-dimension', (req, res) => {
    const { newValue, sourceLocation } = req.body;
    if (
      typeof newValue !== 'number' ||
      !sourceLocation || typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'update-dimension',
      newValue,
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/update-dimension-expression', (req, res) => {
    const { expression, sourceLocation, sketchSourceLine, newVariable, dimensionOffset, dimensionCall } = req.body;
    if (
      typeof expression !== 'string' ||
      !sourceLocation || typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const nv = validateNewVariable(newVariable);
    if (nv === false) {
      res.status(400).json({ error: 'Invalid newVariable' });
      return;
    }
    if (nv && typeof sketchSourceLine !== 'number') {
      res.status(400).json({ error: 'sketchSourceLine required when newVariable is provided' });
      return;
    }
    sendToExtension({
      type: 'update-dimension-expression',
      expression,
      sourceLocation,
      sketchSourceLine: typeof sketchSourceLine === 'number' ? sketchSourceLine : null,
      newVariable: nv,
      dimensionOffset: typeof dimensionOffset === 'number' ? dimensionOffset : 0,
      dimensionCall: typeof dimensionCall === 'string' ? dimensionCall : null,
    });
    res.json({ success: true });
  });

  // ---------------------------------------------------------------------------
  // Sketch queries — read current code and answer; no mutation, but only
  // useful to the sketch tooling so categorized here.
  // ---------------------------------------------------------------------------

  router.post('/scope-variables', async (req, res) => {
    // A null/absent line is the feature dialogs' create mode: the statement
    // is appended to the active part's body when `part` names one (its
    // statement line) — the scope is then that body, `param()`s included —
    // and after the file's last line otherwise.
    const { sketchSourceLine, part, assembly } = req.body;
    if (sketchSourceLine !== undefined && sketchSourceLine !== null
      && typeof sketchSourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const partLine = part?.line;
    if (part !== undefined && part !== null
      && (typeof part !== 'object' || !Number.isInteger(partLine) || partLine < 1)) {
      res.status(400).json({ error: 'part must be {line} of the part() statement' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      res.json({ variables: [] });
      return;
    }
    try {
      // An instance's or a part definition's binding also offers the
      // properties its last render computed, so a field can complete
      // `drawer.properties.<name>` and `box.properties.<name>`.
      const rendered = new RenderedProperties(fluidCadServer.getCurrentFileName(), {
        instances: fluidCadServer.getRenderedInstances(),
        parts: fluidCadServer.getRenderedParts(),
      });
      const offered = await scopeGlobals();
      let variables: VariableInfo[];
      if (typeof sketchSourceLine === 'number') {
        variables = await extractVariablesInScope(code, sketchSourceLine, rendered, offered);
      } else if (assembly === true) {
        variables = await extractVariablesInAssembly(code, rendered, offered);
      } else if (typeof partLine === 'number') {
        variables = await extractVariablesInPart(code, partLine, rendered, offered);
      } else {
        variables = await extractVariablesInScope(code, Number.MAX_SAFE_INTEGER, rendered, offered);
      }
      res.json({ variables });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/point-expression', async (req, res) => {
    const { sourceLine, pointIndex } = req.body;
    if (typeof sourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      res.json({ point: null });
      return;
    }
    try {
      const result = await getPointExpression(code, sourceLine,
        typeof pointIndex === 'number' ? pointIndex : 0);
      res.json({ point: result ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/dimension-expression', async (req, res) => {
    const { sourceLine, dimensionOffset, dimensionCall } = req.body;
    if (typeof sourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      res.json({ expression: null });
      return;
    }
    try {
      const result = await getDimensionExpression(code, sourceLine,
        typeof dimensionOffset === 'number' ? dimensionOffset : 0,
        typeof dimensionCall === 'string' ? dimensionCall : null);
      res.json({ expression: result?.expression ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // /api/code/* — editor hosts send the current buffer text plus operation
  // params; the server returns the fully edited text. All source-text
  // manipulation lives here so every host shares one implementation.
  // ---------------------------------------------------------------------------

  router.post('/code/add-breakpoint', async (req, res) => {
    const { code, referenceRow } = req.body;
    if (typeof code !== 'string' || typeof referenceRow !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await addBreakpoint(code, referenceRow);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/remove-breakpoint', async (req, res) => {
    const { code, line } = req.body;
    if (typeof code !== 'string' || typeof line !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await removeBreakpoint(code, line);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/toggle-breakpoint', async (req, res) => {
    const { code, cursorRow } = req.body;
    if (typeof code !== 'string' || typeof cursorRow !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await toggleBreakpoint(code, cursorRow);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/clear-breakpoints', async (req, res) => {
    const { code } = req.body;
    if (typeof code !== 'string') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await clearBreakpoints(code);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/insert-point', async (req, res) => {
    const { code, sourceLine, point } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      !Array.isArray(point) || point.length !== 2
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await insertPoint(code, sourceLine, point as [number, number]);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/remove-point', async (req, res) => {
    const { code, sourceLine, point } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      !Array.isArray(point) || point.length !== 2
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await removePoint(code, sourceLine, point as [number, number]);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/update-insert-chain', (req, res) => {
    const { sourceLocation, edit } = req.body;
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number' ||
      !edit || typeof edit !== 'object'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'update-insert-chain',
      sourceLocation,
      edit,
    });
    res.json({ success: true });
  });

  router.post('/code/update-insert-chain', async (req, res) => {
    const { code, sourceLine, edit } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      !edit || typeof edit !== 'object'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await updateInsertChain(code, sourceLine, edit as InsertChainEdit);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/add-guide', async (req, res) => {
    const { code, sourceLine } = req.body;
    if (typeof code !== 'string' || typeof sourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await addGuide(code, sourceLine);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/remove-guide', async (req, res) => {
    const { code, sourceLine } = req.body;
    if (typeof code !== 'string' || typeof sourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await removeGuide(code, sourceLine);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/remove-statement', async (req, res) => {
    const { code, sourceLine } = req.body;
    if (typeof code !== 'string' || typeof sourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      // The removal sweeps what it orphans: sketch geometry takes the
      // constraints and geometry referencing it along, an assembly insert()
      // its mates and replicates, a mate() its replicate column.
      const result = await SketchDeleteSweep.removeStatement(code, sourceLine);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/set-feature-name', async (req, res) => {
    const { code, sourceLine, name } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      (name !== null && typeof name !== 'string')
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      // An empty rename keeps the current name (D4): clearing a name is
      // not reachable from the timeline, only from the code. A name another
      // statement of the file already holds is refused with the clash (D3)
      // — the hosts surface `error` the way they surface any edit refusal.
      const value = FeatureNames.normalize(name);
      if (value === '') {
        res.json({ newCode: code });
        return;
      }
      const clash = await FeatureNames.conflictIn(code, value, sourceLine);
      if (clash) {
        res.json({ newCode: code, error: FeatureNames.conflictMessage(value, clash) });
        return;
      }
      const result = await setFeatureName(code, sourceLine, value);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/insert-load', async (req, res) => {
    const { code, fileName } = req.body;
    if (typeof code !== 'string' || typeof fileName !== 'string') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await insertLoadCall(code, fileName);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/goto-source', (req, res) => {
    const { filePath, line, column, revealEditor } = req.body;
    if (
      typeof filePath !== 'string' ||
      typeof line !== 'number' ||
      typeof column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'goto-source',
      filePath,
      line,
      column,
      // Absent (an older UI, or an explicit "show me the code") reveals.
      revealEditor: revealEditor !== false,
    });
    res.json({ success: true });
  });

  router.post('/code/insert-geometry', async (req, res) => {
    const { code, sketchSourceLine, statement, newVariable } = req.body;
    if (
      typeof code !== 'string' || typeof sketchSourceLine !== 'number' ||
      typeof statement !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const nv = validateNewVariable(newVariable);
    if (nv === false) {
      res.status(400).json({ error: 'Invalid newVariable' });
      return;
    }
    try {
      const inserted = await insertGeometryCallWithVariable(code, sketchSourceLine, statement, nv);
      const result = await withGlobalImports(inserted, editedFile(req.body), [
        statement, ...(nv === null ? [] : [nv].flat().map((v) => v.initializer)),
      ]);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/update-sketch-positions', async (req, res) => {
    const { code, edits } = req.body ?? {};
    if (typeof code !== 'string' || !Array.isArray(edits) || edits.length === 0) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const validated: SketchPositionEdit[] = [];
    for (const edit of edits) {
      const v = validateSketchPositionEdit(edit);
      if (!v) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      validated.push(v);
    }
    try {
      const result = await updateSketchPositions(code, validated);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/update-dimension', async (req, res) => {
    const { code, sourceLine, newValue } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      typeof newValue !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await updateDimension(code, sourceLine, newValue);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/update-dimension-expression', async (req, res) => {
    const { code, sourceLine, expression, sketchSourceLine, newVariable, dimensionOffset, dimensionCall } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      typeof expression !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const nv = validateNewVariable(newVariable);
    if (nv === false) {
      res.status(400).json({ error: 'Invalid newVariable' });
      return;
    }
    if (nv && typeof sketchSourceLine !== 'number') {
      res.status(400).json({ error: 'sketchSourceLine required when newVariable is provided' });
      return;
    }
    const offset = typeof dimensionOffset === 'number' ? dimensionOffset : 0;
    try {
      const updated = await updateDimensionExpressionWithVariable(
        code, sourceLine, expression,
        typeof sketchSourceLine === 'number' ? sketchSourceLine : sourceLine,
        nv,
        offset,
        typeof dimensionCall === 'string' ? dimensionCall : null,
      );
      const result = await withGlobalImports(updated, editedFile(req.body), [
        expression, ...(nv === null ? [] : [nv].flat().map((v) => v.initializer)),
      ]);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
