import { Router } from 'express';
import { sceneUnitFields } from '../fluidcad-server.ts';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import { MoveToPart } from '../move-to-part.ts';

export function createTimelineRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
  options: { dispatcher?: FeatureEditDispatcher } = {},
): Router {
  const router = Router();

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
      rollbackStop: data.rollbackStop,
      ...(data.rollbackScopePartId ? { rollbackScopePartId: data.rollbackScopePartId } : {}),
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      rollbackStop: data.rollbackStop,
      ...(data.rollbackScopePartId ? { rollbackScopePartId: data.rollbackScopePartId } : {}),
      ...(data.assembly ? { assembly: data.assembly } : {}),
      // The last full render's paused state — a refresh replays whatever
      // scene message went out last, and the indicator must survive it.
      breakpointHit: data.breakpointHit,
    });
    // Features inside the rollback scope that failed to build are still
    // broken — a rollback re-emits them, it doesn't repair them.
    res.json({
      success: true,
      state: data.objectErrors.length > 0 ? 'build-error' : 'rendered',
      objectErrors: data.objectErrors,
    });
  });

  router.post('/remove-feature', (req, res) => {
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
