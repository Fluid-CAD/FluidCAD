import { Router } from 'express';
import { describeOcException } from '../../../lib/dist/index.js';
import type { FluidCadServer } from '../fluidcad-server.ts';
import {
  addBreakpoint,
  removeBreakpoint,
  toggleBreakpoint,
  clearBreakpoints,
  insertPoint,
  removePoint,
  addGuide,
  removeGuide,
  addPick,
  removePick,
  removeStatement,
  setFeatureName,
  setPickPoints,
  insertGeometryCallWithVariable,
  insertLoadCall,
  updateGeometryPosition,
  setLinePosition,
  setChainPositions,
  updateSketchPositions,
  type SketchPositionEdit,
  updateDimension,
  updateDimensionExpressionWithVariable,
  getDimensionExpression,
  getPointExpression,
  updatePointExpressionWithVariable,
  extractVariablesInScope,
  setRectDimensions,
} from '../code-editor.ts';
import { updateInsertChain, type InsertChainEdit } from '../insert-chain-edit.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';

/** One statement's worth of a solved-sketch drag write-back (P4). */
function validateSketchPositionEdit(input: unknown): SketchPositionEdit | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.sourceLine !== 'number') {
    return null;
  }
  const edit: SketchPositionEdit = { sourceLine: obj.sourceLine };
  if (obj.points !== undefined) {
    if (!Array.isArray(obj.points)) {
      return null;
    }
    const points: SketchPositionEdit['points'] = [];
    for (const p of obj.points) {
      if (typeof p !== 'object' || p === null
        || typeof (p as any).pointIndex !== 'number'
        || !validPoint((p as any).position)
        || ((p as any).expected !== undefined && !validPoint((p as any).expected))) {
        return null;
      }
      points.push({
        pointIndex: (p as any).pointIndex,
        position: (p as any).position,
        ...((p as any).expected !== undefined ? { expected: (p as any).expected } : {}),
      });
    }
    edit.points = points;
  }
  if (obj.scalar !== undefined) {
    const s = obj.scalar as Record<string, unknown> | null;
    if (typeof s !== 'object' || s === null || typeof s.value !== 'number'
      || (s.expected !== undefined && typeof s.expected !== 'number')) {
      return null;
    }
    edit.scalar = { value: s.value, ...(s.expected !== undefined ? { expected: s.expected as number } : {}) };
  }
  return edit;
}

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

/** A [x, y] pair of finite numbers, or null for anything else. */
function validPoint(input: unknown): [number, number] | null {
  if (Array.isArray(input) && input.length === 2
    && typeof input[0] === 'number' && Number.isFinite(input[0])
    && typeof input[1] === 'number' && Number.isFinite(input[1])) {
    return [input[0], input[1]];
  }
  return null;
}

export function createSketchEditsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  workspacePath: string,
  dispatcher?: FeatureEditDispatcher,
): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // /api/import-file — file I/O for STEP/STP imports
  // ---------------------------------------------------------------------------

  router.post('/import-file', async (req, res) => {
    const { fileName, data } = req.body;
    if (typeof fileName !== 'string' || typeof data !== 'string') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    try {
      await fluidCadServer.importFile(workspacePath, fileName, data);
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
    res.json({ success: true, fileName: loadName });
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

  router.post('/add-pick', (req, res) => {
    const { sourceLocation } = req.body;
    if (
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'add-pick',
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/remove-pick', (req, res) => {
    const { sourceLocation } = req.body;
    if (
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'remove-pick',
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

  router.post('/set-pick-points', (req, res) => {
    const { points, sourceLocation } = req.body;
    if (
      !Array.isArray(points) ||
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'set-pick-points',
      points: points as [number, number][],
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

  router.post('/update-position', (req, res) => {
    const { newPosition, sourceLocation, pointIndex, oldPosition } = req.body;
    if (
      !Array.isArray(newPosition) || newPosition.length !== 2 ||
      !sourceLocation || typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'update-position',
      newPosition: newPosition as [number, number],
      sourceLocation,
      pointIndex: typeof pointIndex === 'number' ? pointIndex : undefined,
      oldPosition: validPoint(oldPosition),
    });
    res.json({ success: true });
  });

  router.post('/set-line-position', (req, res) => {
    const { newStart, newEnd, sourceLocation } = req.body;
    if (
      !Array.isArray(newStart) || newStart.length !== 2 ||
      !Array.isArray(newEnd) || newEnd.length !== 2 ||
      !sourceLocation || typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'set-line-position',
      newStart: newStart as [number, number],
      newEnd: newEnd as [number, number],
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/set-chain-positions', (req, res) => {
    const { updates, sourceLocation } = req.body;
    if (
      !Array.isArray(updates) || updates.length === 0 ||
      !sourceLocation || typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'set-chain-positions',
      updates,
      sourceLocation,
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
    const { expression, sourceLocation, sketchSourceLine, newVariable, dimensionOffset, dimensionCall, dimensionInsert, dimensionPoint } = req.body;
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
      dimensionInsert: dimensionInsert === true,
      dimensionPoint: validPoint(dimensionPoint),
    });
    res.json({ success: true });
  });

  router.post('/update-point-expression', (req, res) => {
    const { xExpr, yExpr, sourceLocation, sketchSourceLine, newVariable, pointIndex, oldPosition } = req.body;
    if (
      typeof xExpr !== 'string' || typeof yExpr !== 'string' ||
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
      type: 'update-point-expression',
      xExpr,
      yExpr,
      sourceLocation,
      sketchSourceLine: typeof sketchSourceLine === 'number' ? sketchSourceLine : null,
      newVariable: nv,
      pointIndex: typeof pointIndex === 'number' ? pointIndex : 0,
      oldPosition: validPoint(oldPosition),
    });
    res.json({ success: true });
  });

  router.post('/set-rect-dimensions', (req, res) => {
    const { startPoint, width, height, sourceLocation, oldStartPoint } = req.body;
    if (
      typeof width !== 'number' || typeof height !== 'number' ||
      !sourceLocation || typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const sp = Array.isArray(startPoint) && startPoint.length === 2 ? startPoint as [number, number] : null;
    sendToExtension({
      type: 'set-rect-dimensions',
      startPoint: sp,
      width,
      height,
      sourceLocation,
      oldStartPoint: validPoint(oldStartPoint),
    });
    res.json({ success: true });
  });

  // ---------------------------------------------------------------------------
  // Sketch queries — read current code and answer; no mutation, but only
  // useful to the sketch tooling so categorized here.
  // ---------------------------------------------------------------------------

  router.post('/scope-variables', async (req, res) => {
    // null/absent means whole-file scope — the feature dialogs' create mode,
    // where the statement is appended after the last line.
    const { sketchSourceLine } = req.body;
    if (sketchSourceLine !== undefined && sketchSourceLine !== null
      && typeof sketchSourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      res.json({ variables: [] });
      return;
    }
    try {
      const variables = await extractVariablesInScope(
        code, typeof sketchSourceLine === 'number' ? sketchSourceLine : Number.MAX_SAFE_INTEGER,
      );
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
  // /api/code/* — extensions send the current buffer text plus operation
  // params; the server returns the fully edited text. All source-text
  // manipulation lives here so VSCode and Neovim share one implementation.
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

  router.post('/code/add-pick', async (req, res) => {
    const { code, sourceLine } = req.body;
    if (typeof code !== 'string' || typeof sourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await addPick(code, sourceLine);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/remove-pick', async (req, res) => {
    const { code, sourceLine } = req.body;
    if (typeof code !== 'string' || typeof sourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await removePick(code, sourceLine);
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
      const result = await removeStatement(code, sourceLine);
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
      const result = await setFeatureName(code, sourceLine, name);
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
    const { filePath, line, column } = req.body;
    if (
      typeof filePath !== 'string' ||
      typeof line !== 'number' ||
      typeof column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({ type: 'goto-source', filePath, line, column });
    res.json({ success: true });
  });

  router.post('/code/set-pick-points', async (req, res) => {
    const { code, sourceLine, points } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      !Array.isArray(points)
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await setPickPoints(code, sourceLine, points as [number, number][]);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
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
      const result = await insertGeometryCallWithVariable(code, sketchSourceLine, statement, nv);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/update-position', async (req, res) => {
    const { code, sourceLine, newPosition, pointIndex, oldPosition } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      !Array.isArray(newPosition) || newPosition.length !== 2
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await updateGeometryPosition(
        code, sourceLine, newPosition as [number, number],
        typeof pointIndex === 'number' ? pointIndex : 0,
        validPoint(oldPosition),
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/set-line-position', async (req, res) => {
    const { code, sourceLine, newStart, newEnd } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      !Array.isArray(newStart) || newStart.length !== 2 ||
      !Array.isArray(newEnd) || newEnd.length !== 2
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await setLinePosition(
        code, sourceLine,
        newStart as [number, number],
        newEnd as [number, number],
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/set-chain-positions', async (req, res) => {
    const { code, sourceLine, updates } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      !Array.isArray(updates) || updates.length === 0
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await setChainPositions(code, sourceLine, updates);
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
    const { code, sourceLine, expression, sketchSourceLine, newVariable, dimensionOffset, dimensionCall, dimensionInsert, dimensionPoint } = req.body;
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
      const result = await updateDimensionExpressionWithVariable(
        code, sourceLine, expression,
        typeof sketchSourceLine === 'number' ? sketchSourceLine : sourceLine,
        nv,
        offset,
        typeof dimensionCall === 'string' ? dimensionCall : null,
        dimensionInsert === true,
        validPoint(dimensionPoint),
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/update-point-expression', async (req, res) => {
    const { code, sourceLine, xExpr, yExpr, sketchSourceLine, newVariable, pointIndex, oldPosition } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      typeof xExpr !== 'string' || typeof yExpr !== 'string'
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
    try {
      const result = await updatePointExpressionWithVariable(
        code, sourceLine, xExpr, yExpr,
        typeof sketchSourceLine === 'number' ? sketchSourceLine : sourceLine,
        nv,
        typeof pointIndex === 'number' ? pointIndex : 0,
        validPoint(oldPosition),
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/code/set-rect-dimensions', async (req, res) => {
    const { code, sourceLine, startPoint, width, height, oldStartPoint } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      typeof width !== 'number' || typeof height !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const sp = Array.isArray(startPoint) && startPoint.length === 2 ? startPoint as [number, number] : null;
    try {
      const result = await setRectDimensions(
        code, sourceLine, sp, width, height, validPoint(oldStartPoint),
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
