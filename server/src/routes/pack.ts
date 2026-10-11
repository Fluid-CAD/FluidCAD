import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import { PackageBuildError, packPackage } from '../packages/package-builder.ts';
import { PackageLayout, type PackageContents } from '../packages/package-manifest.ts';

/** `POST /api/pack` with `{ "format": "json" }`: the archive and what it holds, in one JSON body. */
export type PackJsonResponse = {
  /** The author's bare name (`feature-tests`): the hub adds the publisher's handle when it is published. */
  packageName: string;
  version: string;
  fileName: string;
  bytes: number;
  /** The features, parts and assemblies by folder, as `fluidcad pack --json` lists them. */
  contents: PackageContents;
  /** The `.fluidpkg`, base64. */
  archive: string;
};

/**
 * `POST /api/pack` — pack the open workspace's package (`fluidcad.json`
 * `package`, exports from its `features/`, `parts/` and `assemblies/`
 * folders) into a `.fluidpkg` (research §2), as `fluidcad pack` does, and
 * return the archive (application/zip). The workspace's running engine
 * evaluates the exports, so nothing boots twice; a file whose editor
 * buffer differs from the disk is refused, because the disk is what ships.
 * Nothing is written to the workspace.
 *
 * With `{ "format": "json" }` the answer is a {@link PackJsonResponse}
 * instead: the same archive in base64, beside the contents by folder (the
 * MCP `pack` tool's form, so it reports what `fluidcad pack --json` does).
 *
 * A refusal — not a package, or a pack check failing — is a 400 whose
 * `error` is the sentence the CLI prints and whose `code` is the
 * {@link PackageBuildError}'s (`wrong-folder`, `outside-layout`,
 * `no-exports`, else `refused`).
 */
export function createPackRouter(
  fluidCadServer: FluidCadServer,
  workspacePath: string,
  fluidcadVersion: string,
): Router {
  const router = Router();

  router.post('/pack', async (req, res) => {
    const asJson = req.body?.format === 'json';
    try {
      const { manifest, zip } = await packPackage({ workspacePath, fluidcadVersion, engine: fluidCadServer });
      const fileName = PackageLayout.archiveName(manifest.name, manifest.version);
      if (asJson) {
        const body: PackJsonResponse = {
          packageName: manifest.name,
          version: manifest.version,
          fileName,
          bytes: zip.length,
          contents: PackageLayout.contentsOf(manifest),
          archive: zip.toString('base64'),
        };
        res.json(body);
        return;
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('X-FluidCAD-Package-Name', manifest.name);
      res.setHeader('X-FluidCAD-Package-Version', manifest.version);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(zip);
    } catch (err: any) {
      if (err instanceof PackageBuildError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
