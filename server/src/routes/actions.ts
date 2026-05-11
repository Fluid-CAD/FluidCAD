import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import {
  addBreakpoint,
  removeBreakpoint,
  toggleBreakpoint,
  clearBreakpoints,
  insertPoint,
  removePoint,
  addPick,
  removePick,
  setPickPoints,
  insertGeometryCall,
  updateGeometryPosition,
  setLinePosition,
  updateDimension,
  updateDimensionExpression,
  getDimensionExpression,
  extractVariablesInScope,
} from '../code-editor.ts';

export function createActionsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
  workspacePath: string,
): Router {
  const router = Router();

  router.post('/hit-test', (req, res) => {
    const { shapeId, rayOrigin, rayDir, edgeThreshold } = req.body;
    if (
      typeof shapeId !== 'string' ||
      !Array.isArray(rayOrigin) || rayOrigin.length !== 3 ||
      !Array.isArray(rayDir) || rayDir.length !== 3 ||
      typeof edgeThreshold !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const result = fluidCadServer.hitTest(
      shapeId,
      rayOrigin as [number, number, number],
      rayDir as [number, number, number],
      edgeThreshold,
    );
    res.json(result);
  });

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

  router.post('/rollback', async (req, res) => {
    const { index } = req.body;
    if (typeof index !== 'number' || index < 0) {
      res.status(400).json({ error: 'Invalid index' });
      return;
    }
    const data = await fluidCadServer.rollbackFromUI(index);
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
      rollbackStop: data.rollbackStop,
    });
    res.json({ success: true });
  });

  router.post('/recompute', async (_req, res) => {
    const data = await fluidCadServer.recomputeCurrentFile();
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
    });
    res.json({ success: true });
  });

  router.post('/clear-breakpoints', (_req, res) => {
    sendToExtension({ type: 'clear-breakpoints' });
    res.json({ success: true });
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

  router.post('/import-file', async (req, res) => {
    const { fileName, data } = req.body;
    if (typeof fileName !== 'string' || typeof data !== 'string') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    try {
      await fluidCadServer.importFile(workspacePath, fileName, data);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
      return;
    }

    const loadName = fileName.replace(/\.(step|stp)$/i, '');
    res.json({ success: true, fileName: loadName });
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

  router.post('/insert-geometry', (req, res) => {
    const { statement, sketchSourceLocation } = req.body;
    if (
      typeof statement !== 'string' ||
      !sketchSourceLocation || typeof sketchSourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'insert-geometry',
      statement,
      sketchSourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/code/insert-geometry', async (req, res) => {
    const { code, sketchSourceLine, statement } = req.body;
    if (
      typeof code !== 'string' || typeof sketchSourceLine !== 'number' ||
      typeof statement !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await insertGeometryCall(code, sketchSourceLine, statement);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/update-position', (req, res) => {
    const { newPosition, sourceLocation, pointIndex } = req.body;
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
    });
    res.json({ success: true });
  });

  router.post('/code/update-position', async (req, res) => {
    const { code, sourceLine, newPosition, pointIndex } = req.body;
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
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
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

  router.post('/update-dimension-expression', (req, res) => {
    const { expression, sourceLocation } = req.body;
    if (
      typeof expression !== 'string' ||
      !sourceLocation || typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'update-dimension-expression',
      expression,
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/code/update-dimension-expression', async (req, res) => {
    const { code, sourceLine, expression } = req.body;
    if (
      typeof code !== 'string' || typeof sourceLine !== 'number' ||
      typeof expression !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await updateDimensionExpression(code, sourceLine, expression);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/scope-variables', async (req, res) => {
    const { sketchSourceLine } = req.body;
    if (typeof sketchSourceLine !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      res.json({ variables: [] });
      return;
    }
    try {
      const variables = await extractVariablesInScope(code, sketchSourceLine);
      res.json({ variables });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/dimension-expression', async (req, res) => {
    const { sourceLine } = req.body;
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
      const result = await getDimensionExpression(code, sourceLine);
      res.json({ expression: result?.expression ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
