import { Router, type Response } from 'express';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { ASSET_TYPES } from './feature-catalog.ts';
import { loadPreferences } from '../preferences.ts';
import { PackageArchive, PackageArchiveError } from '../packages/package-archive.ts';
import { PackageInstallError, PackageInstaller } from '../packages/package-installer.ts';
import { LibraryMove } from '../packages/library-move.ts';
import { PackageName } from '../packages/package-name.ts';
import { PackagePinError, PackagePins } from '../packages/package-pins.ts';
import { PackageRoots, type PackageTarget } from '../packages/package-roots.ts';
import { ProjectPackages } from '../packages/project-packages.ts';
import { PackageTypeLibs } from '../packages/package-editor-types.ts';
import { Semver } from '../packages/semver.ts';
import type { HubReleases } from '../hub/hub-releases.ts';

export type PackagesRouterOptions = {
  /** The open project; empty when the server runs without one (no project target, no pins). */
  workspacePath: string;
  /**
   * The hub's releases of the pinned packages (hub-plan H10, feeding P10),
   * counted in `GET /api/packages`' `updates`; without it only the library
   * is (the tests that never reach a hub).
   */
  releases?: HubReleases;
};

/**
 * The package routes (research §3), for the engine page's Packages dialog
 * and Settings → Packages. Packages install only from the hub (HD31): no
 * route takes an archive from the page. The hub download inspects the
 * archive inside the engine (`PackageArchive.inspect`), and the token it
 * answers is what `install`, `discard` and `inspected-icon` take: H10's
 * `POST /api/hub/inspect` (`routes/hub.ts`) hands it to the page.
 *
 * - `POST /api/packages/install { token, target, replace?, pin? }`: renames
 *   an inspected archive into the user library or the project copy under
 *   its manifest's name, and pins it into the open project when the target
 *   is `project` or `pin` is true.
 * - `GET /api/packages/inspected-icon?token=&id=`: a feature's icon from an
 *   inspected archive, for the consent dialog; `POST /api/packages/discard
 *   { token }` drops an inspection the user declined.
 * - `GET /api/packages`: both roots and the project's pins, each with where
 *   it is installed (`availability`), and each pin's newer version from the
 *   library or the hub (`updates`, `updatesFrom`).
 * - `POST /api/packages/copy { name, version, to }`: Copy into project
 *   (`to: 'project'`) and Add to my library (`to: 'library'`).
 * - `DELETE /api/packages/@scope/name/<version>?target=library|project`
 *   (the version may be left out when only one is installed).
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
      let overview = ProjectPackages.overview(project);
      if (options.releases && overview.pins && overview.pins.length > 0) {
        overview = ProjectPackages.withHubReleases(overview, await options.releases.newest(overview.pins.map((pin) => pin.name)));
      }
      res.json({
        ...overview,
        problems: PackagePins.problems(project),
        defaultTarget: await preferredTarget(),
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

  /** The "New packages go to" setting; the project only when one is open. */
  async function preferredTarget(): Promise<PackageTarget> {
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
