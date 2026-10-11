import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { ASSET_TYPES } from './feature-catalog.ts';
import { loadPreferences } from '../preferences.ts';
import { PackageArchive, PackageArchiveError } from '../packages/package-archive.ts';
import { PackageInstallError, PackageInstaller } from '../packages/package-installer.ts';
import { LibraryMove } from '../packages/library-move.ts';
import { PackageIdentity } from '../packages/package-identity.ts';
import { PackageName } from '../packages/package-name.ts';
import { PackagePinError, PackagePins } from '../packages/package-pins.ts';
import { PackageRoots, type PackageTarget } from '../packages/package-roots.ts';
import { ProjectPackages } from '../packages/project-packages.ts';
import { PackageTypeLibs } from '../packages/package-editor-types.ts';
import { Semver } from '../packages/semver.ts';

export type PackagesRouterOptions = {
  /** The open project; empty when the server runs without one (no project target, no pins). */
  workspacePath: string;
  /** The running engine's version, compared with a package's `minEngine`. */
  engineVersion: string;
  /** The largest archive `inspect` accepts. */
  maxArchiveBytes?: number;
};

/** A package archive is source files and small images; this is far above any real one. */
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * The package install routes (research §3, "The install flow"), for the
 * engine page's install dialog and Settings → Packages:
 *
 * - `POST /api/packages/inspect[?as=@scope/name]`: the raw `.fluidpkg` as
 *   the body. Answers the consent summary — `{ token, manifest, integrity,
 *   warnings, bytes, installsAs }` — with the archive extracted into
 *   scratch, waiting for its install. `installsAs` is the public name it
 *   installs under (`PackageIdentity.forInstall`: `as`, else the project's
 *   single matching pin, else `@local/<name>`); a name it can't take is a
 *   400 with its code, and nothing waits.
 * - `POST /api/packages/install { token, target, replace?, pin?, as? }`:
 *   renames it into the user library or the project copy under that name,
 *   and pins it into the open project when the target is `project` or `pin`
 *   is true.
 * - `GET /api/packages`: both roots and the project's pins, each with where
 *   it is installed (`availability`).
 * - `POST /api/packages/copy { name, version, to }`: Copy into project
 *   (`to: 'project'`) and Add to my library (`to: 'library'`).
 * - `DELETE /api/packages/@scope/name/<version>?target=library|project`
 *   (the version may be left out when only one is installed).
 * - `GET /api/packages/inspected-icon?token=&id=`: a feature's icon from an
 *   inspected archive, for the consent dialog; `POST /api/packages/discard
 *   { token }` drops an inspection the user declined.
 * - `GET /api/packages/types`: the pinned packages' sources, for the
 *   in-page editor's language service (`PackageTypeLibs`).
 * - `POST /api/packages/library-offer`: copy what the folder the library was
 *   in before the last Settings change holds into the library;
 *   `DELETE /api/packages/library-offer` declines that (`GET` shows the offer
 *   as `libraryOffer`).
 *
 * A refusal is a 4xx whose `error` is the sentence the CLI prints, with its
 * `code`; a pin that would change is a 409 and leaves everything as it was.
 */
export function createPackagesRouter(options: PackagesRouterOptions): Router {
  const router = Router();
  const project = options.workspacePath || null;
  const rawBody = express.raw({ type: () => true, limit: options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES });

  router.post('/packages/inspect', rawBody, async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Send the .fluidpkg file as the request body.' });
      return;
    }
    const as = typeof req.query.as === 'string' && req.query.as !== '' ? req.query.as : null;
    let token: string | null = null;
    try {
      const target = await defaultTarget(req.query.target);
      const inspection = await PackageArchive.inspect(body, {
        root: PackageRoots.rootFor(target, project),
        engineVersion: options.engineVersion,
      });
      token = inspection.token;
      const installsAs = PackageIdentity.forInstall(inspection.manifest.name, { as, project });
      res.json({ ...inspection, defaultTarget: target, installsAs });
    } catch (err) {
      // A name it can't install under: nothing waits for an install.
      if (token !== null) {
        PackageArchive.discard(token);
      }
      PackageRefusal.send(res, err);
    }
  });

  router.post('/packages/install', async (req, res) => {
    const { token, target, replace, pin, as } = req.body ?? {};
    if (typeof token !== 'string' || !PackageRoots.isTarget(target) || (as !== undefined && as !== null && typeof as !== 'string')) {
      res.status(400).json({ error: 'Expected { token, target: "library" | "project", as?: "@scope/name" }.' });
      return;
    }
    if (target === 'project' && !project) {
      res.status(400).json({ error: 'There is no open project to install into.' });
      return;
    }
    try {
      res.json(await ProjectPackages.installInspected({ token, target, project, replace: replace === true, pin: pin === true, as: as ?? null }));
    } catch (err) {
      PackageRefusal.send(res, err);
    }
  });

  router.post('/packages/discard', (req, res) => {
    const { token } = req.body ?? {};
    if (typeof token !== 'string') {
      res.status(400).json({ error: 'Expected { token }.' });
      return;
    }
    PackageArchive.discard(token);
    res.json({ success: true });
  });

  router.get('/packages/inspected-icon', async (req, res) => {
    const { token, id } = req.query;
    if (typeof token !== 'string' || typeof id !== 'string') {
      res.status(400).json({ error: 'Expected ?token=&id=.' });
      return;
    }
    const icon = PackageArchive.iconOf(token, id);
    if ('error' in icon) {
      res.status(icon.status).json({ error: icon.error });
      return;
    }
    const type = ASSET_TYPES[extname(icon.file).toLowerCase()];
    if (!type) {
      res.status(415).json({ error: `${id}'s icon is not an image.` });
      return;
    }
    try {
      const content = await readFile(icon.file);
      // The feature asset route's headers: an SVG served alone stays inert.
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(content);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/packages', async (_req, res) => {
    try {
      // `problems`: the pins installed in neither root, structured for an
      // Install action (empty without a project). `libraryOffer`: what the
      // folder the library just left still holds.
      res.json({
        ...ProjectPackages.overview(project),
        problems: PackagePins.problems(project),
        defaultTarget: await defaultTarget(undefined),
        libraryOffer: LibraryMove.offer(),
      });
    } catch (err) {
      PackageRefusal.send(res, err);
    }
  });

  router.get('/packages/types', (_req, res) => {
    try {
      // The pins' sources for the in-page editor's language service: it
      // re-registers them only when `key` changes, so no-cache is enough.
      res.setHeader('Cache-Control', 'no-cache');
      res.json(PackageTypeLibs.of(project));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/packages/copy', async (req, res) => {
    const { name, version, to } = req.body ?? {};
    if (!PackageName.isValid(name) || !Semver.isValid(version) || !PackageRoots.isTarget(to)) {
      res.status(400).json({ error: 'Expected { name: "@scope/name", version, to: "library" | "project" }.' });
      return;
    }
    if (!project) {
      res.status(400).json({ error: 'Copying between the library and a project needs an open project.' });
      return;
    }
    try {
      res.json(await PackageInstaller.copy(name, version, to, project));
    } catch (err) {
      PackageRefusal.send(res, err);
    }
  });

  router.post('/packages/library-offer', async (_req, res) => {
    try {
      const copied = await LibraryMove.copy(project);
      if (!copied) {
        res.status(404).json({ error: 'The library folder hasn\'t changed, so there is nothing to copy.' });
        return;
      }
      if (copied.copies.every((copy) => copy.status !== 'refused')) {
        LibraryMove.dismiss();
      }
      res.json(copied);
    } catch (err) {
      PackageRefusal.send(res, err);
    }
  });

  router.delete('/packages/library-offer', (_req, res) => {
    LibraryMove.dismiss();
    res.json({ success: true });
  });

  router.delete('/packages/:scope/:name{/:version}', (req, res) => {
    const name = `${req.params.scope}/${req.params.name}`;
    const version = req.params.version ?? null;
    const target = req.query.target ?? 'library';
    if (!PackageName.isValid(name) || (version !== null && !Semver.isValid(version)) || !PackageRoots.isTarget(target)) {
      res.status(400).json({ error: 'Expected DELETE /api/packages/@scope/name/<version>?target=library|project.' });
      return;
    }
    if (target === 'project' && !project) {
      res.status(400).json({ error: 'There is no open project to remove a package from.' });
      return;
    }
    try {
      res.json(ProjectPackages.remove(name, version, target, project));
    } catch (err) {
      PackageRefusal.send(res, err);
    }
  });

  // An archive over the limit fails inside express.raw, before the handler:
  // answer it in the same shape as every other refusal.
  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: `The archive is larger than ${Math.round((options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES) / (1024 * 1024))} MB.` });
      return;
    }
    next(err);
  });

  /** The target a request names, else the "New packages go to" setting; the project only when one is open. */
  async function defaultTarget(asked: unknown): Promise<PackageTarget> {
    if (PackageRoots.isTarget(asked)) {
      return asked === 'project' && !project ? 'library' : asked;
    }
    const preferred = (await loadPreferences()).packageInstallTarget;
    return preferred === 'project' && project ? 'project' : 'library';
  }

  return router;
}

/** How the package routes answer a refusal: 409 for what conflicts with what is there, 404 for a token that is gone, 400 otherwise. */
class PackageRefusal {
  static send(res: Response, err: unknown): void {
    const status = PackageRefusal.status(err);
    if (status === null) {
      res.status(500).json({ error: (err as Error)?.message ?? String(err) });
      return;
    }
    const { message, code } = err as { message: string; code: string };
    res.status(status).json({ error: message, code });
  }

  private static status(err: unknown): number | null {
    if (err instanceof PackageArchiveError) {
      return 400;
    }
    if (err instanceof PackageInstallError) {
      if (err.code === 'unknown-token') {
        return 404;
      }
      return err.code === 'conflict' || err.code === 'not-a-package-folder' ? 409 : 400;
    }
    if (err instanceof PackagePinError) {
      return err.code === 'version-change' || err.code === 'integrity-mismatch' ? 409 : 400;
    }
    return null;
  }
}
