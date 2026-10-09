import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { loadPreferences } from '../preferences.ts';
import { PackageArchive, PackageArchiveError } from '../packages/package-archive.ts';
import { PackageInstallError, PackageInstaller } from '../packages/package-installer.ts';
import { PackageName } from '../packages/package-name.ts';
import { PackagePinError } from '../packages/package-pins.ts';
import { PackageRoots, type PackageTarget } from '../packages/package-roots.ts';
import { ProjectPackages } from '../packages/project-packages.ts';
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
 * - `POST /api/packages/inspect`: the raw `.fluidpkg` as the body. Answers
 *   the consent summary — `{ token, manifest, integrity, warnings, bytes }`
 *   — with the archive extracted into scratch, waiting for its install.
 * - `POST /api/packages/install { token, target, replace?, pin? }`: renames
 *   it into the user library or the project copy, and pins it into the open
 *   project when the target is `project` or `pin` is true.
 * - `GET /api/packages`: both roots and the project's pins, each with where
 *   it is installed (`availability`).
 * - `POST /api/packages/copy { name, version, to }`: Copy into project
 *   (`to: 'project'`) and Add to my library (`to: 'library'`).
 * - `DELETE /api/packages/@scope/name/<version>?target=library|project`
 *   (the version may be left out when only one is installed).
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
    try {
      const target = await defaultTarget(req.query.target);
      const inspection = await PackageArchive.inspect(body, {
        root: PackageRoots.rootFor(target, project),
        engineVersion: options.engineVersion,
      });
      res.json({ ...inspection, defaultTarget: target });
    } catch (err) {
      PackageRefusal.send(res, err);
    }
  });

  router.post('/packages/install', async (req, res) => {
    const { token, target, replace, pin } = req.body ?? {};
    if (typeof token !== 'string' || !PackageRoots.isTarget(target)) {
      res.status(400).json({ error: 'Expected { token, target: "library" | "project" }.' });
      return;
    }
    if (target === 'project' && !project) {
      res.status(400).json({ error: 'There is no open project to install into.' });
      return;
    }
    try {
      res.json(await ProjectPackages.installInspected({ token, target, project, replace: replace === true, pin: pin === true }));
    } catch (err) {
      PackageRefusal.send(res, err);
    }
  });

  router.get('/packages', async (_req, res) => {
    try {
      res.json({ ...ProjectPackages.overview(project), defaultTarget: await defaultTarget(undefined) });
    } catch (err) {
      PackageRefusal.send(res, err);
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
