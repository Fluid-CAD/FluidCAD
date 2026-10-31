import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import { collectEntryFiles, entryPath, type EntryFiles } from '../files/entry-files.ts';

/** What the UI turns into a viewer link: the engine pin, the model to render first, its source tree. */
export interface ShareFilesResponse {
  fluidcadVersion: string;
  entry: string;
  files: EntryFiles;
}

/**
 * `GET /api/share-files` — the currently rendered model's source tree, ready
 * for the viewer's `#v=&entry=&files=` link (the UI compresses and opens
 * it). Only the entry's transitive workspace imports travel, with the asset
 * files its last render read (a `load()`'s imported geometry, a workspace
 * font), not the whole workspace: a link has to stay short and must not
 * leak files the model never touches. A binary file comes as `{ b64 }`, the
 * form the link's file map carries it in, so the UI passes the tree on as
 * it is.
 */
export function createShareRouter(
  fluidCadServer: FluidCadServer,
  workspacePath: string,
  fluidcadVersion: string,
): Router {
  const router = Router();

  router.get('/share-files', async (_req, res) => {
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene to share' });
      return;
    }
    try {
      const files = await collectEntryFiles(currentFile, workspacePath, { assets: fluidCadServer.getRenderAssets() });
      const entry = entryPath(currentFile, workspacePath);
      const body: ShareFilesResponse = { fluidcadVersion, entry, files };
      res.json(body);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
