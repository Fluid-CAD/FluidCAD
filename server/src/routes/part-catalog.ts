import { Router } from 'express';
import { relativeSpecifier } from '../files/relative-specifier.ts';
import { ModuleSpecifiers } from '../files/module-specifiers.ts';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';
import { DEFAULT_CONFIGURATION_NAME, findInvalidParam, type InsertPartEntry } from '../part-catalog/insert-edit.ts';
import { listCandidateFiles, PackagePartFiles } from '../part-catalog/walk.ts';
import { PartScanCache } from '../part-catalog/cache.ts';
import { readProjectConfig } from '../project-config.ts';
import { PackageAdoption } from '../packages/package-adoption.ts';
import { PackageRoots, type PackageLocation } from '../packages/package-roots.ts';

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The Insert dialog's backend: enumerate candidate part files, scan one file
 * for its exported parts (evaluation serialized with renders on the OCC
 * mutex, cached by dependency mtimes), and write the chosen part's
 * `insert()` statement into the current assembly file through the shared
 * edit dispatcher.
 *
 * Installed packages' parts are candidates too, listed under their package
 * (research §5): the packages the project pins, and the library's newest
 * version of each one it doesn't (K7). A package part is imported by the
 * package's bare name, and inserting one from a library package pins the
 * package first ({@link PackageAdoption}); no file is copied.
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
  // A file of an installed package — the project copy (inside the
  // workspace anyway) or the library — by location plus marker.
  const packageOf = (absPath: string): PackageLocation | null =>
    workspacePath !== '' ? PackageRoots.owner(absPath, workspacePath) : null;

  // Read per request: `fluidcad.json` may change while the server runs, and
  // a stale project unit would mislabel every file without its own `unit()`.
  const projectUnit = () => readProjectConfig(workspacePath).unit ?? 'mm';

  router.get('/part-catalog/files', async (_req, res) => {
    if (!workspacePath) {
      res.status(404).json({ error: 'No workspace path configured' });
      return;
    }
    try {
      const files = [
        ...await listCandidateFiles(workspacePath, p => fluidCadServer.getLiveBuffer(p), projectUnit()),
        ...PackagePartFiles.list(workspacePath),
      ];
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
    const owner = packageOf(absPath);
    if (!inWorkspace(absPath) && owner === null) {
      res.status(400).json({ error: 'File is outside the workspace' });
      return;
    }
    // A package's files are in the package's own unit (its fluidcad.json),
    // never the project's.
    const fallbackUnit = owner ? readProjectConfig(owner.directory).unit ?? 'mm' : projectUnit();

    // A live editor buffer (the file being edited, or one of its imports)
    // overlays the disk content, so mtime-keyed cache entries can't vouch for
    // it — rescan. `deps` includes the file itself.
    const cached = cache.get(absPath);
    if (cached && !cached.deps.some(d => fluidCadServer.hasLiveBuffer(d))) {
      res.json(cached);
      return;
    }

    try {
      const result = await fluidCadServer.scanPartsInFile(absPath, fallbackUnit);
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
    // Batch body: { inserts: [{ file, exportName, kind, params?, configuration? }] }
    // — the dialog's whole basket in one edit, one editor round trip, one
    // render. `configuration` names a row of the export's configurations()
    // table (`insert(x, 'Wide')`); 'Default' means the literals and is dropped.
    const { inserts, newVariables } = req.body ?? {};
    if (!Array.isArray(inserts) || inserts.length === 0
      || (newVariables !== undefined && !Array.isArray(newVariables))) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    for (const entry of inserts) {
      const { file, exportName, kind, params, configuration } = entry ?? {};
      if (
        typeof file !== 'string' || file.length === 0
        || typeof exportName !== 'string' || !IDENTIFIER_RE.test(exportName)
        || (kind !== 'value' && kind !== 'factory' && kind !== 'assembly')
        || findInvalidParam(params) !== null
        || (configuration !== undefined && (typeof configuration !== 'string' || configuration.trim() === ''))
      ) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
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
    const currentAbs = normalizePath(currentFile);
    // One answer per request for which specifier reaches each part: a
    // relative path, or the package's bare name (only for a name its entry
    // exports, at the version the project pins, if it pins one).
    const specifiers = workspacePath ? new ModuleSpecifiers(workspacePath) : ModuleSpecifiers.LOCAL;
    const entries: InsertPartEntry[] = [];
    // Each library package a part comes from, pinned before the edit lands.
    const adoptions = new Map<string, PackageLocation>();
    for (const entry of inserts) {
      const partAbs = normalizePath(entry.file);
      let importFrom: string | null = null;
      if (partAbs !== currentAbs) {
        importFrom = specifiers.specifierFor(currentFile, partAbs, entry.exportName);
        if (importFrom === null) {
          res.status(422).json({
            success: false,
            reason: specifiers.unreachableReason(partAbs, entry.exportName) ?? `${entry.exportName} can't be imported here.`,
          });
          return;
        }
      }
      const owner = packageOf(partAbs);
      if (owner) {
        adoptions.set(owner.name, owner);
      }
      entries.push({
        importFrom,
        exportName: entry.exportName,
        kind: entry.kind,
        ...(entry.params && Object.keys(entry.params).length > 0 ? { params: entry.params } : {}),
        ...(typeof entry.configuration === 'string' && entry.configuration !== DEFAULT_CONFIGURATION_NAME
          ? { configuration: entry.configuration }
          : {}),
      });
    }
    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as paramEdit rides the round trip: the
      // insertPart side-channel supersedes every other field.
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      newVariables,
      insertPart: { inserts: entries },
    };
    await dispatcher.dispatch(res, spec, { success: true }, adoptions.size > 0 && workspacePath
      ? {
        beforeSend: PackageAdoption.step(async () => {
          for (const owner of adoptions.values()) {
            await PackageAdoption.adoptForUse(workspacePath, owner.name, owner.version);
          }
        }),
      }
      : {});
  });

  return router;
}

export { relativeSpecifier };
