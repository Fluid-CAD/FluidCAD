import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { packModel } from '../model-package/pack.ts';
import type { ModelPackageCamera } from '../model-package/types.ts';
import type { CameraStateMessage } from '../ws-protocol.ts';

/**
 * `POST /api/pack` — produce a `.fluidpkg` (zip) archive of the currently
 * rendered file. Pulls live param overrides and the last-known camera state
 * from the running server so the archive matches what the user is seeing.
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
    const { name, description } = (req.body ?? {}) as { name?: string; description?: string };
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
        paramOverrides: fluidCadServer.getParamOverrides(currentFile),
        camera,
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
