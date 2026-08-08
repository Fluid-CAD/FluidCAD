import { Router } from 'express';
import { dirname, relative } from 'path';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';
import { listCandidateFiles } from '../part-catalog/walk.ts';
import { PartScanCache } from '../part-catalog/cache.ts';

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The Insert dialog's backend: enumerate candidate part files, scan one file
 * for its exported parts (evaluation serialized with renders on the OCC
 * mutex, cached by dependency mtimes), and write the chosen part's
 * `insert()` statement into the current assembly file through the shared
 * edit dispatcher.
 */
export function createPartCatalogRouter(
  fluidCadServer: FluidCadServer,
  workspacePath: string,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();
  const cache = new PartScanCache();

  const inWorkspace = (absPath: string): boolean =>
    workspacePath !== '' && (absPath === workspacePath || absPath.startsWith(workspacePath + '/'));

  router.get('/part-catalog/files', async (_req, res) => {
    if (!workspacePath) {
      res.status(404).json({ error: 'No workspace path configured' });
      return;
    }
    try {
      const files = await listCandidateFiles(workspacePath, p => fluidCadServer.getLiveBuffer(p));
      res.json({ workspacePath, files });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/part-catalog/scan', async (req, res) => {
    const { file } = req.body ?? {};
    if (typeof file !== 'string' || file.length === 0) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const absPath = normalizePath(file);
    if (!inWorkspace(absPath)) {
      res.status(400).json({ error: 'File is outside the workspace' });
      return;
    }

    // A live editor buffer (the file being edited, or one of its imports)
    // overlays the disk content, so mtime-keyed cache entries can't vouch for
    // it — rescan. `deps` includes the file itself.
    const cached = cache.get(absPath);
    if (cached && !cached.deps.some(d => fluidCadServer.hasLiveBuffer(d))) {
      res.json(cached);
      return;
    }

    try {
      const result = await fluidCadServer.scanPartsInFile(absPath);
      if (!result) {
        res.status(503).json({ error: 'Engine not initialized yet' });
        return;
      }
      if (!result.deps.some(d => fluidCadServer.hasLiveBuffer(d))) {
        cache.set(absPath, result);
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/part-catalog/insert', async (req, res) => {
    const { file, exportName, kind } = req.body ?? {};
    if (
      typeof file !== 'string' || file.length === 0
      || typeof exportName !== 'string' || !IDENTIFIER_RE.test(exportName)
      || (kind !== 'value' && kind !== 'factory' && kind !== 'assembly')
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    if (detectKind(currentFile) !== 'assembly') {
      res.status(422).json({ success: false, reason: 'Insert targets an assembly — open a *.assembly.js file first.' });
      return;
    }
    const partAbs = normalizePath(file);
    const importFrom = partAbs === normalizePath(currentFile)
      ? null
      : relativeSpecifier(currentFile, partAbs);
    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as paramEdit rides the round trip: the
      // insertPart side-channel supersedes every other field.
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      insertPart: { importFrom, exportName, kind },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  return router;
}

/** `./`-prefixed posix module specifier from the assembly file to the part file. */
function relativeSpecifier(fromFile: string, toFile: string): string {
  let rel = relative(dirname(fromFile), toFile).replace(/\\/g, '/');
  if (!rel.startsWith('.')) {
    rel = './' + rel;
  }
  return rel;
}
