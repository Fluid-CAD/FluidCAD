import path from 'path';
import { Router } from 'express';
import { ScratchBuildRefusal, ScratchBuildStore, type FluidCadServer, type ScratchBuildRequest } from '../fluidcad-server/index.ts';
import { resolveWorkspaceFile, WorkspacePathError } from '../files/workspace-paths.ts';
import { detectKind } from '../file-kind.ts';
import { normalizePath } from '../normalize-path.ts';

/** The longest candidate a build takes: far past any model file, short of a request that is not one. */
const MAX_SOURCE_LENGTH = 2_000_000;
const MAX_PARAMS = 200;
const MAX_PARAM_NAME_LENGTH = 300;

/**
 * Body validation for `POST /scratch-build`. Everything in the body is
 * untrusted — an agent's candidate, or a page relaying one: the file is
 * confined to the workspace, and the source is only ever evaluated the way
 * a file's text is (the blocked-import scan applies), never written.
 */
export class ScratchBuildRequests {

  /** The build a body asks for, or the refusal with its HTTP status. */
  static parse(body: unknown, workspacePath: string): ScratchBuildRequest | { status: number; error: string } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, error: 'body must be an object: { file: string, source?: string, params?: Record<string, value>, reuse?: boolean }' };
    }
    const { file, source, params, reuse } = body as { file?: unknown; source?: unknown; params?: unknown; reuse?: unknown };
    if (typeof file !== 'string' || file.length === 0) {
      return { status: 400, error: '`file` must be a non-empty string: the model file to build.' };
    }
    if (source !== undefined && (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH)) {
      return { status: 400, error: `\`source\` must be a string of at most ${MAX_SOURCE_LENGTH} characters: the whole candidate text of the file.` };
    }
    if (reuse !== undefined && typeof reuse !== 'boolean') {
      return { status: 400, error: '`reuse` must be a boolean: whether a kept build of the same inputs may answer.' };
    }
    const paramsError = ScratchBuildRequests.paramsError(params);
    if (paramsError) {
      return { status: 400, error: paramsError };
    }
    let absPath: string;
    try {
      // Containment through the symlinks; the build keeps an absolute
      // path's own spelling, which is the one the file's session goes by.
      const resolved = resolveWorkspaceFile(workspacePath, file);
      absPath = path.isAbsolute(file) ? normalizePath(path.resolve(file)) : resolved.absPath;
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return { status: 403, error: error.message };
      }
      throw error;
    }
    if (detectKind(absPath) === null) {
      return { status: 422, error: `${file} is not a model: a scratch build takes a .fluid.js, .part.js or .assembly.js file.` };
    }
    return {
      file: absPath,
      ...(source !== undefined ? { source: source as string } : {}),
      ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
      ...(reuse === true ? { reuse: true } : {}),
    };
  }

  /** What is wrong with `params`, or null: a record of parameter names to scalars or lists of them. */
  private static paramsError(params: unknown): string | null {
    if (params === undefined) {
      return null;
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return '`params` must be an object of parameter label to value.';
    }
    const entries = Object.entries(params);
    if (entries.length > MAX_PARAMS) {
      return `\`params\` takes at most ${MAX_PARAMS} parameters.`;
    }
    const scalar = (value: unknown) =>
      typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
    for (const [name, value] of entries) {
      if (name.length === 0 || name.length > MAX_PARAM_NAME_LENGTH) {
        return '`params` names must be non-empty parameter labels.';
      }
      const list = Array.isArray(value) && value.every(item => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)));
      if (!scalar(value) && !list) {
        return `\`params.${name}\` must be a string, a finite number, a boolean, or a list of strings and numbers.`;
      }
    }
    return null;
  }
}

/**
 * Scratch builds (`FluidCadServer.scratchBuild`): a candidate version of a
 * model file built without writing it and without touching the live
 * session — for an agent comparing alternatives, a chat card showing
 * candidates, an approval card showing what an edit would produce.
 *
 * `POST /scratch-build { file, source?, params? }` → 200 with a
 * `ScratchBuildOutcome`: `state` (`rendered` | `build-error` |
 * `compile-error`) and, unless it did not evaluate, the build's `id`, solid
 * count, bounds, volume and soundness verdict. A candidate that fails is an
 * answer, not an error: 200 either way. 400 for a malformed body, 403 for a
 * file outside the workspace, 404 for a file that cannot be read when no
 * `source` is given, 422 for a file that is no model, 503 before the engine
 * is up. The response is held for as long as the build takes, behind any
 * render in progress.
 *
 * With `reuse: true` a build of the same inputs the engine still keeps is
 * the answer (`reused: true`) and nothing is built: the same file and text,
 * the same session overrides, configuration and `params`, and every other
 * file the build read unchanged.
 *
 * `POST /scratch-build/cost` (the same body) → 200 with a
 * `ScratchBuildCost`, at once and without building: `reusable` (the kept
 * build `reuse` would answer, or null) and `lastBuildMs` (how long the
 * file's last build took in this engine process, or null). The refusals of
 * the build.
 *
 * `GET /scratch-build/:id/meshes` → 200 with the build's `ScratchBuildMeshes`
 * (its rendered rows, every mesh whole — what the page's mesh factory and
 * thumbnail renderer read), or 404 once the store let it go (see
 * `ScratchBuildStore`): build it again.
 */
export function createScratchBuildRouter(fluidCadServer: FluidCadServer, workspacePath: string): Router {
  const router = Router();

  router.post('/scratch-build', async (req, res) => {
    let request: ReturnType<typeof ScratchBuildRequests.parse>;
    try {
      request = ScratchBuildRequests.parse(req.body, workspacePath);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
      return;
    }
    if ('status' in request) {
      res.status(request.status).json({ error: request.error });
      return;
    }
    try {
      const outcome = await fluidCadServer.scratchBuild(request);
      if (!outcome) {
        res.status(503).json({ error: fluidCadServer.describeMissingEngine() ?? 'Engine not initialized yet' });
        return;
      }
      res.json(outcome);
    } catch (err: any) {
      if (err instanceof ScratchBuildRefusal) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/scratch-build/cost', async (req, res) => {
    let request: ReturnType<typeof ScratchBuildRequests.parse>;
    try {
      request = ScratchBuildRequests.parse(req.body, workspacePath);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
      return;
    }
    if ('status' in request) {
      res.status(request.status).json({ error: request.error });
      return;
    }
    try {
      const cost = await fluidCadServer.scratchBuildCost(request);
      if (!cost) {
        res.status(503).json({ error: fluidCadServer.describeMissingEngine() ?? 'Engine not initialized yet' });
        return;
      }
      res.json(cost);
    } catch (err: any) {
      if (err instanceof ScratchBuildRefusal) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/scratch-build/:id/meshes', (req, res) => {
    const id = req.params.id;
    const meshes = ScratchBuildStore.isId(id) ? fluidCadServer.scratchBuilds.get(id) : null;
    if (!meshes) {
      res.status(404).json({ error: 'No such scratch build: it was never made, or its meshes are no longer kept. Build it again.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(meshes);
  });

  return router;
}
