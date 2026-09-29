import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import { MaterialCatalog } from '../material-catalog.ts';
import type { ProjectMaterials } from '../project-config.ts';

/**
 * Property routes answer in the document's unit — the kernel runs in it, so
 * `volumeMm3` / `surfaceAreaMm2` / `areaMm2` are field NAMES only (kept for
 * compatibility): an inch document reports in³ / in² under those names.
 * Each response carries `unit` so callers can label the values.
 */
export function createPropertiesRouter(
  fluidCadServer: FluidCadServer,
  options: {
    /** The user's global materials (Settings → Materials); tests inject a map, the app reads the preferences file. */
    loadGlobalMaterials?: () => Promise<ProjectMaterials>;
  } = {},
): Router {
  const router = Router();
  const loadGlobalMaterials = options.loadGlobalMaterials ?? MaterialCatalog.loadGlobal;

  // The merged materials list: built-ins (`fluidcad-…` ids, `source:
  // 'builtin'`), the project's `fluidcad.json` map (`source: 'project'`; an
  // entry reusing a built-in id replaces it in place), then the user's
  // global materials the project does not hold yet (`source: 'global'`).
  router.get('/materials', async (_req, res) => {
    try {
      res.json(MaterialCatalog.merged(fluidCadServer.getProjectMaterials(), await loadGlobalMaterials()));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // A part's mass properties over its final solids, with `material` /
  // `massG` when its `.material(id)` resolves and `warning` when it does not.
  router.get('/part-properties', (req, res) => {
    const partId = (req.query.partId as string) || '';
    if (!partId) {
      res.status(400).json({ error: 'Missing partId' });
      return;
    }
    const props = fluidCadServer.getPartProperties(partId);
    if (!props) {
      res.status(404).json({ error: 'Part not found' });
      return;
    }
    res.json({ ...props, unit: fluidCadServer.getSceneUnit() });
  });

  router.get('/shape-properties', (req, res) => {
    const shapeId = (req.query.shapeId as string) || '';
    const props = fluidCadServer.getShapeProperties(shapeId);
    if (!props) {
      res.status(404).json({ error: 'Shape not found' });
      return;
    }
    res.json({ ...props, unit: fluidCadServer.getSceneUnit() });
  });

  router.get('/face-properties', (req, res) => {
    const shapeId = (req.query.shapeId as string) || '';
    const faceIndex = parseInt((req.query.faceIndex as string) || '', 10);
    if (!shapeId || isNaN(faceIndex) || faceIndex < 0) {
      res.status(400).json({ error: 'Missing or invalid shapeId / faceIndex' });
      return;
    }
    const props = fluidCadServer.getFaceProperties(shapeId, faceIndex);
    if (!props) {
      res.status(404).json({ error: 'Face not found' });
      return;
    }
    res.json({ ...props, unit: fluidCadServer.getSceneUnit() });
  });

  router.get('/edge-properties', (req, res) => {
    const shapeId = (req.query.shapeId as string) || '';
    const edgeIndex = parseInt((req.query.edgeIndex as string) || '', 10);
    if (!shapeId || isNaN(edgeIndex) || edgeIndex < 0) {
      res.status(400).json({ error: 'Missing or invalid shapeId / edgeIndex' });
      return;
    }
    const props = fluidCadServer.getEdgeProperties(shapeId, edgeIndex);
    if (!props) {
      res.status(404).json({ error: 'Edge not found' });
      return;
    }
    res.json({ ...props, unit: fluidCadServer.getSceneUnit() });
  });

  return router;
}
