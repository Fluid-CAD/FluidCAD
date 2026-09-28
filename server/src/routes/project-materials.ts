import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import { getMaterials } from '../../../lib/dist/common/materials.js';
import { parseProjectMaterials, writeProjectMaterials } from '../project-config.ts';
import { broadcastProjectRecompute, type UnitRouterDeps } from './unit.ts';

export type ProjectMaterialsRouterDeps = Omit<UnitRouterDeps, 'fluidCadServer'> & {
  fluidCadServer: Pick<FluidCadServer, 'recomputeCurrentFile' | 'reloadProjectMaterials'>;
};

/**
 * The Manage materials… dialog's write: `POST /api/project/materials` takes
 * the WHOLE project map — `{ materials: { [id]: { name, density,
 * densityUnit? } } }`, an empty map clears it — validated by the same rules
 * `fluidcad.json` is read with (400 with the problem otherwise), merges it
 * into `fluidcad.json` keeping every other key, and answers the merged
 * built-in + project list so the UI refreshes without a second request.
 * The current file is recomputed like the project unit's write: a part
 * whose `.material(id)` names an id that just appeared loses its warning
 * on that render.
 */
export function createProjectMaterialsRouter(deps: ProjectMaterialsRouterDeps): Router {
  const { workspacePath, fluidCadServer, sendToExtension, broadcastToUI } = deps;
  const router = Router();

  router.post('/project/materials', async (req, res) => {
    const raw = req.body?.materials;
    const parsed = parseProjectMaterials(raw);
    if ('problem' in parsed) {
      res.status(400).json({ success: false, reason: `The "materials" map ${parsed.problem}.` });
      return;
    }
    if (!workspacePath) {
      res.status(409).json({ success: false, reason: 'No workspace is open — there is no fluidcad.json to write.' });
      return;
    }
    let configPath: string;
    try {
      configPath = writeProjectMaterials(workspacePath, parsed.materials);
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message || String(err) });
      return;
    }
    // The file is re-read before every render, but a workspace with nothing
    // rendered yet would keep serving the old map to GET /api/materials.
    fluidCadServer.reloadProjectMaterials();
    const data = await fluidCadServer.recomputeCurrentFile(true);
    if (data) {
      broadcastProjectRecompute({ sendToExtension, broadcastToUI }, data);
    }
    res.json({
      success: true,
      materials: getMaterials(parsed.materials),
      configPath,
      recomputed: data !== null,
    });
  });

  return router;
}
