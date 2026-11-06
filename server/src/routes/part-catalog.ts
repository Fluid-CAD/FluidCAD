import { Router } from 'express';
import { relativeSpecifier } from '../files/relative-specifier.ts';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';
import { CatalogInsertRequest } from '../part-catalog/insert-request.ts';
import { GeneratedAssets, GeneratedCatalog, GeneratedListing } from '../part-catalog/generated.ts';
import { listCandidateFiles, PackagePartFiles } from '../part-catalog/walk.ts';
import { PartScanCache } from '../part-catalog/cache.ts';
import type { PartScanResult } from '../part-catalog/scan.ts';
import { ImageAssets } from '../files/image-assets.ts';
import { readProjectConfig } from '../project-config.ts';
import { PackageAdoption } from '../packages/package-adoption.ts';
import { PackageRoots, type PackageLocation } from '../packages/package-roots.ts';

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
 *
 * Generated definitions (`definePart`, `defineAssembly`) are listed from
 * their schemas, never built ({@link GeneratedCatalog}); their images are
 * served by `GET /part-catalog/asset`, confined to the package or workspace
 * that owns the module each resolves against ({@link GeneratedAssets}).
 * Inserting one writes its values by id through the same planner
 * ({@link CatalogInsertRequest}) every insert uses. `GET
 * /part-catalog/generated` lists every generated definition the project can
 * insert in one answer ({@link GeneratedListing}), scanning only the files
 * that can define one — the assembly toolbar's Custom dropdown.
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

  // One file's scan: the cached answer while no editor buffer overlays any
  // file it read (a live buffer changes without touching disk, so mtimes
  // can't vouch for it — `deps` includes the file itself), else a fresh one.
  // A package's files are in the package's own unit (its fluidcad.json),
  // never the project's. Null while the engine is not up.
  const scanned = async (absPath: string, owner: PackageLocation | null): Promise<PartScanResult | null> => {
    const live = (result: PartScanResult) => result.deps.some(d => fluidCadServer.hasLiveBuffer(d));
    const cached = cache.get(absPath);
    if (cached && !live(cached)) {
      return cached;
    }
    const fallbackUnit = owner ? readProjectConfig(owner.directory).unit ?? 'mm' : projectUnit();
    const result = await fluidCadServer.scanPartsInFile(absPath, fallbackUnit);
    if (result && !live(result)) {
      cache.set(absPath, result);
    }
    return result;
  };

  // Where a module's images may be read: inside the installed package that
  // owns it, else inside the workspace; nowhere for a module beyond both.
  const imageRoot = (module: string): string | null => {
    const owner = packageOf(module);
    if (owner) {
      return owner.directory;
    }
    return workspacePath !== '' && (inWorkspace(module) || GeneratedAssets.isInside(module, workspacePath)) ? workspacePath : null;
  };

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

  // Every generated definition the project can insert: `{ entries: [{ file,
  // path, exportName, kind, schema, assetUrls, unit, package? }] }`. Only the
  // files that call definePart( / defineAssembly( (and the packages' modules
  // whose manifests list one) are scanned, each through the scan cache.
  router.get('/part-catalog/generated', async (_req, res) => {
    if (!workspacePath) {
      res.status(404).json({ error: 'No workspace path configured' });
      return;
    }
    try {
      const files = [
        ...await listCandidateFiles(workspacePath, p => fluidCadServer.getLiveBuffer(p), projectUnit(), { generatedOnly: true }),
        ...PackagePartFiles.list(workspacePath, { generatedOnly: true }),
      ];
      let engineDown = false;
      const entries = await GeneratedListing.collect(files, async (file) => {
        const result = await scanned(file.absPath, packageOf(file.absPath));
        engineDown ||= result === null;
        return result;
      });
      if (engineDown && entries.length === 0 && files.length > 0) {
        res.status(503).json({ error: 'Engine not initialized yet' });
        return;
      }
      res.json({ entries });
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
    try {
      const result = await scanned(absPath, owner);
      if (!result) {
        res.status(503).json({ error: 'Engine not initialized yet' });
        return;
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
    // A generated definition's `params` are its values by id.
    const request = CatalogInsertRequest.parse(req.body);
    if (!request) {
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
    const plan = CatalogInsertRequest.plan(currentFile, request.inserts, workspacePath, request.newVariables);
    if ('reason' in plan) {
      res.status(422).json({ success: false, reason: plan.reason });
      return;
    }
    // Each library package a part comes from, pinned before the edit lands.
    await dispatcher.dispatch(res, plan.spec, { success: true }, plan.adoptions.length > 0 && workspacePath
      ? {
        beforeSend: PackageAdoption.step(async () => {
          for (const owner of plan.adoptions) {
            await PackageAdoption.adoptForUse(workspacePath, owner.name, owner.version);
          }
        }),
      }
      : {});
  });

  // `?file=…&export=…&base=definition|class&path=…` — one image a generated
  // definition's schema declares (its icon, an option's picture, a layout
  // image), `path` exactly as declared under `base` (the URLs the scan's
  // `assetUrls` list). Served from inside the package or workspace that
  // owns the module the path resolves against, never beyond
  // (`GeneratedAssets`); the feature asset route's headers keep an SVG inert.
  router.get('/part-catalog/asset', async (req, res) => {
    const { file, export: exportName, base, path } = req.query;
    if (typeof file !== 'string' || file === '' || typeof exportName !== 'string' || exportName === ''
      || !GeneratedCatalog.isBase(base) || typeof path !== 'string' || path === '') {
      res.status(400).json({ error: 'file, export, base (definition or class) and path must be given' });
      return;
    }
    const absPath = normalizePath(file);
    const owner = packageOf(absPath);
    if (!inWorkspace(absPath) && owner === null) {
      res.status(400).json({ error: 'File is outside the workspace' });
      return;
    }
    try {
      const scan = await scanned(absPath, owner);
      if (scan === null) {
        res.status(503).json({ error: 'Engine not initialized yet' });
        return;
      }
      const entry = [...scan.parts, ...scan.assemblies]
        .find(candidate => candidate.exportName === exportName && candidate.definitionKind === 'generated');
      if (!entry?.schema || !entry.assetModules) {
        res.status(404).json({ error: `${exportName} is no generated definition of this file` });
        return;
      }
      const found = GeneratedAssets.locate({ schema: entry.schema, assetModules: entry.assetModules }, base, path, imageRoot);
      if ('error' in found) {
        res.status(found.status).json({ error: found.error });
        return;
      }
      await ImageAssets.send(res, found.file, `'${entry.schema.label}': '${path}' is not an image`);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}

export { relativeSpecifier };
