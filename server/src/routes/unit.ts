import { Router } from 'express';
import { sceneUnitFields } from '../fluidcad-server.ts';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { setDocumentUnit } from '../code-editor.ts';
import { detectKind } from '../file-kind.ts';
import { parseProjectUnit, writeProjectUnit } from '../project-config.ts';
import { ASSEMBLY_UNIT_MESSAGE, unknownUnitMessage } from '../unit-lint.ts';

export type UnitRouterDeps = {
  workspacePath: string;
  fluidCadServer: Pick<FluidCadServer, 'recomputeCurrentFile'>;
  /** The editor host channel — the same one every UI-triggered source edit rides. */
  sendToExtension: (msg: any) => boolean | void;
  broadcastToUI: (msg: any) => void;
};

/**
 * The unit chip's two write paths (docs/unit-system-plan.md): a part file
 * declares its own unit in source, an assembly is measured in the project
 * unit. Neither touches a number — the design is that a document's numbers
 * ARE its unit, so "switching" only changes what the numbers are labelled.
 *
 * - `POST /api/code/set-unit` is the pure transform the editor hosts
 *   round-trip through, like every other `/api/code/*` rewrite.
 * - `POST /api/set-unit` is what the UI calls: it relays to the host, which
 *   POSTs its live buffer to the transform above and re-renders (the same
 *   fire-and-forget path as `add-breakpoint`).
 * - `POST /api/project/unit` writes `fluidcad.json` and recomputes the
 *   current file so the next `scene-rendered` carries the new unit.
 */
export function createUnitRouter(deps: UnitRouterDeps): Router {
  const { workspacePath, fluidCadServer, sendToExtension, broadcastToUI } = deps;
  const router = Router();

  // `unit: null` on both routes is the chip's "Same as project": the
  // declaration is removed instead of written.
  router.post('/code/set-unit', async (req, res) => {
    const { code, unit, filePath } = req.body ?? {};
    if (typeof code !== 'string' || (typeof unit !== 'string' && unit !== null) || (filePath !== undefined && typeof filePath !== 'string')) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await setDocumentUnit(code, unit, filePath);
      if (result.error) {
        // A refusal is not a 200 with the old code: the hosts apply whatever
        // `newCode` comes back, and a no-op apply still saves and re-renders.
        res.status(422).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/set-unit', (req, res) => {
    const { filePath, unit } = req.body ?? {};
    if (typeof filePath !== 'string' || (typeof unit !== 'string' && unit !== null)) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    // Refuse here what the transform would refuse, so the UI hears it
    // instead of the host's log: the relay itself is fire-and-forget.
    const canonical = unit === null ? null : parseProjectUnit(unit);
    if (unit !== null && canonical === null) {
      res.status(422).json({ success: false, reason: unknownUnitMessage(unit) });
      return;
    }
    if (detectKind(filePath) === 'assembly') {
      res.status(422).json({ success: false, reason: ASSEMBLY_UNIT_MESSAGE });
      return;
    }
    sendToExtension({ type: 'set-unit', filePath, unit: canonical });
    res.json({ success: true });
  });

  router.post('/project/unit', async (req, res) => {
    const { unit } = req.body ?? {};
    const canonical = parseProjectUnit(unit);
    if (canonical === null) {
      res.status(422).json({ success: false, reason: unknownUnitMessage(String(unit)) });
      return;
    }
    if (!workspacePath) {
      res.status(409).json({ success: false, reason: 'No workspace is open — there is no fluidcad.json to write.' });
      return;
    }
    let configPath: string;
    try {
      configPath = writeProjectUnit(workspacePath, canonical);
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message || String(err) });
      return;
    }
    // The render re-reads fluidcad.json (FluidCadServer.processFileInternal),
    // so a recompute is what makes the new unit visible. A workspace with
    // nothing rendered yet just gets the file written.
    const data = await fluidCadServer.recomputeCurrentFile(true);
    if (data) {
      sendToExtension({
        type: 'scene-rendered',
        absPath: data.absPath,
        sceneKind: data.sceneKind,
        ...sceneUnitFields(data),
        result: data.result,
        rollbackStop: data.rollbackStop,
        ...(data.assembly ? { assembly: data.assembly } : {}),
      });
      broadcastToUI({
        type: 'scene-rendered',
        result: data.result,
        absPath: data.absPath,
        sceneKind: data.sceneKind,
        ...sceneUnitFields(data),
        breakpointHit: data.breakpointHit,
        params: data.params,
        ...(data.assembly ? { assembly: data.assembly } : {}),
      });
    }
    res.json({ success: true, unit: canonical, configPath, recomputed: data !== null });
  });

  return router;
}
