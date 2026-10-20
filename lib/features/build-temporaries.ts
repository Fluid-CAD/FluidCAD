import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { SceneDisposal } from "../rendering/scene-disposal.js";

/**
 * Free the wrappers a build made for itself once the feature's state is
 * final: the profile faces it built, the tool solids a fuse or cut consumed,
 * the as-built faces a bucket remap replaced. Whatever the feature's state
 * still reaches — its final shapes, its buckets, its history — is the
 * scene's and stays, as does every sub-shape wrapper such a survivor links
 * to; a raw handle a survivor shares with a temporary stays alive with it.
 *
 * `candidates` must be wrappers this build created: a face picked from
 * another feature belongs to that feature whether or not this one kept it.
 */
export function disposeBuildTemporaries(owner: SceneObject, candidates: Iterable<Shape>): void {
  const kept = SceneDisposal.collectShapes([owner]);
  const retainedRaw = new Set<object>();
  for (const shape of kept) {
    shape.collectRawHandles(retainedRaw);
  }

  // A temporary's cached sub-shape wrappers (a face's edges, a solid's
  // faces) are temporaries too, unless the state reached them on its own.
  const doomed = new Set<Shape>();
  const visit = (shape: Shape) => {
    if (kept.has(shape) || doomed.has(shape)) {
      return;
    }
    doomed.add(shape);
    for (const linked of shape.getLinkedShapes()) {
      visit(linked);
    }
  };
  for (const candidate of candidates) {
    visit(candidate);
  }

  const deletedRaw = new Set<object>();
  for (const shape of doomed) {
    shape.release(retainedRaw, deletedRaw);
  }
}
