import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import { packModel } from '../model-package/pack.ts';
import type { ModelPackageCamera } from '../model-package/types.ts';
import { readProjectConfig } from '../project-config.ts';
import type { CameraStateMessage } from '../ws-protocol.ts';

/**
 * `POST /api/pack` — produce a `.fluidpkg` (zip) archive of the currently
 * rendered file. Pulls live param overrides and the last-known camera state
 * from the running server so the archive matches what the user is seeing.
 * A model with a `configurations()` table records the table and the row the
 * package opens on in the manifest: the active row, or `configuration` from
 * the body (a name the file does not declare is a 400 listing the rows).
 * Returns the binary archive directly (application/zip).
 */
export function createPackRouter(
  fluidCadServer: FluidCadServer,
  workspacePath: string,
  fluidcadVersion: string,
  getLastCameraState: () => CameraStateMessage | null,
): Router {
  const router = Router();

  router.post('/pack', async (req, res) => {
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene to pack' });
      return;
    }
    const { name, description, configuration: requested } = (req.body ?? {}) as { name?: string; description?: string; configuration?: unknown };
    if (requested !== undefined && (typeof requested !== 'string' || requested.trim() === '')) {
      res.status(400).json({ error: 'configuration must be a non-empty string — a configurations() row name, or Default.' });
      return;
    }
    // The table as the last render declared it. The package opens on the row
    // on screen — tweaks included — or on the row asked for, which records
    // the row alone: the session's tweaks belong to the row they were made on.
    const configuration = requested as string | undefined;
    const table = fluidCadServer.getConfigurations(currentFile);
    const active = table.active;
    if (configuration !== undefined && configuration !== 'Default' && !table.names.includes(configuration)) {
      res.status(400).json({
        error: table.names.length > 0
          ? `Unknown configuration '${configuration}'. Declared: ${table.names.map(n => `'${n}'`).join(', ')} (and Default).`
          : `Unknown configuration '${configuration}': the file declares no configurations() table (only Default).`,
        names: table.names,
      });
      return;
    }
    const packed = configuration ?? active;
    const cameraMsg = getLastCameraState();
    const camera: ModelPackageCamera | undefined = cameraMsg
      ? {
          position: cameraMsg.position,
          target: cameraMsg.target,
          up: cameraMsg.up,
          projection: cameraMsg.projection,
        }
      : undefined;
    try {
      const result = await packModel({
        entryPath: currentFile,
        workspacePath,
        fluidcadVersion,
        name,
        description,
        paramOverrides: packed === active ? fluidCadServer.getParamOverrides(currentFile) : {},
        ...(table.names.length > 0
          ? { configuration: packed, configurations: { names: table.names, rows: table.rows } }
          : {}),
        camera,
        // Read per request, not at boot: `fluidcad.json` may have been edited
        // since the server started, and the package must say what it says now.
        unit: readProjectConfig(workspacePath).unit ?? 'mm',
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('X-FluidCAD-Package-Name', result.manifest.name);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(result.manifest.name)}.fluidpkg"`,
      );
      res.send(result.zip);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
