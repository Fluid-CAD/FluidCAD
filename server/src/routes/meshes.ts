import { Router } from 'express';
import { MeshStore, type MeshLookup } from '../scene-meshes/mesh-store.ts';

/** The longest key the route reads: a mesh key is a few dozen characters. */
const MAX_KEY_LENGTH = 128;

/**
 * `POST /api/meshes { keys: string[] }` → `{ meshes: { [key]: { meshes,
 * vertices?, faceVertices? } }, missing: string[] }` — the fallback of the
 * scene wire's mesh references (S6b). A page that was sent a `meshRef` it
 * no longer holds asks for its payload here before it draws that scene.
 * Answered from the scenes most recently broadcast ({@link MeshStore}): a
 * key of the newest scene is always there; a missing key belongs only to a
 * scene a newer one replaced, which the page draws instead.
 *
 * 400 `{ error }` when `keys` is not an array of at most
 * {@link MeshStore.MAX_LOOKUP} strings.
 */
export class MeshesRoute {
  /** The keys a request asks for, or a reason it is refused. */
  static keysOf(body: unknown): string[] | { error: string } {
    const keys = (body as { keys?: unknown } | null | undefined)?.keys;
    if (!Array.isArray(keys)) {
      return { error: 'keys must be an array of mesh keys.' };
    }
    if (keys.length > MeshStore.MAX_LOOKUP) {
      return { error: `At most ${MeshStore.MAX_LOOKUP} keys per request.` };
    }
    if (!keys.every(key => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH)) {
      return { error: 'Every key must be a non-empty string of at most 128 characters.' };
    }
    return keys as string[];
  }

  static router(store: Pick<MeshStore, 'lookup'>): Router {
    const router = Router();
    router.post('/meshes', (req, res) => {
      const keys = MeshesRoute.keysOf(req.body);
      if (!Array.isArray(keys)) {
        res.status(400).json(keys);
        return;
      }
      const answer: MeshLookup = store.lookup(keys);
      res.json(answer);
    });
    return router;
  }
}
