import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import { PackageBuildError, packPackage } from '../packages/package-builder.ts';
import { PackageLayout } from '../packages/package-manifest.ts';

/**
 * `POST /api/pack` — pack the open workspace's package (`fluidcad.json`
 * `package`) into a `.fluidpkg` (research §2), as `fluidcad pack` does, and
 * return the archive (application/zip). The workspace's running engine
 * evaluates the exports, so nothing boots twice; a file whose editor
 * buffer differs from the disk is refused, because the disk is what ships.
 * Nothing is written to the workspace.
 *
 * A refusal — not a package, or a pack check failing — is a 400 whose
 * `error` is the sentence the CLI prints.
 */
export function createPackRouter(
  fluidCadServer: FluidCadServer,
  workspacePath: string,
  fluidcadVersion: string,
): Router {
  const router = Router();

  router.post('/pack', async (_req, res) => {
    try {
      const { manifest, zip } = await packPackage({ workspacePath, fluidcadVersion, engine: fluidCadServer });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('X-FluidCAD-Package-Name', manifest.name);
      res.setHeader('X-FluidCAD-Package-Version', manifest.version);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${PackageLayout.archiveName(manifest.name, manifest.version)}"`,
      );
      res.send(zip);
    } catch (err: any) {
      if (err instanceof PackageBuildError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
