import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Instance } from "../features/instance.js";
import { Occurrence } from "../features/occurrence.js";
import { ReplicateTarget, replicateSeed } from "../features/replicate.js";

/**
 * Copy a mated instance or sub-assembly onto new mate targets — the
 * "replicate" / "copy with mates" of other CADs, not a geometric pattern:
 * every replica gets the seed's mates re-targeted to its own references and
 * moves independently.
 *
 *     const cyl1 = insert(pistonAssembly);
 *     mate('slider', bore1, cyl1.parts.piston.connectors.pin);
 *     mate('revolute', cyl1.parts.rod.connectors.bigEnd, crank.connectors.c2);
 *
 *     replicate(cyl1, [bore1, crank.connectors.c2], [
 *       [bore2, crank.connectors.c3],
 *       [bore3, crank.connectors.c4],
 *     ]);
 *
 * - `seed` — the handle `insert()` returned for the instance or sub-assembly
 *   to copy (inserted in this same assembly body).
 * - `targets` — the seed's OUTER mate sides that vary per replica: the
 *   connectors or exposed geometry on OTHER bodies that the seed's mates
 *   reference. Each entry is one column. Any outer side not listed stays
 *   shared by every replica (a planar mate onto a common base plate).
 * - `rows` — one array per replica, one entry per target: `rows[k][j]`
 *   replaces `targets[j]` in replica `k`'s mates. At least one row.
 *
 * Only mates written BEFORE the statement replicate. Mate options (flip,
 * rotate, offset, limits) are copied verbatim. Replicas start at the seed's
 * pose, are never grounded (their mates place them), and are named
 * `<seed name> (2)`, `(3)`, … Returns the replica handles in row order, so
 * `const [cyl2, cyl3] = replicate(...)` can be mated or named further.
 *
 * @param seed - The instance or sub-assembly to copy.
 * @param targets - The seed's mate targets that change per replica.
 * @param rows - Per replica, the replacement for each target.
 */
function replicate<T>(seed: Instance<T>, targets: ReplicateTarget[], rows: ReplicateTarget[][]): Instance<T>[];
function replicate<T>(seed: Occurrence<T>, targets: ReplicateTarget[], rows: ReplicateTarget[][]): Occurrence<T>[];
function replicate(seed: unknown, targets: unknown, rows: unknown): (Instance<unknown> | Occurrence<unknown>)[] {
  const scene = getCurrentScene();
  if (!(scene instanceof AssemblyScene)) {
    throw new Error("replicate() can only be used in *.assembly.js files.");
  }
  const sourceLocation = captureSourceLocation();
  return replicateSeed(scene, seed, targets, rows, sourceLocation ?? undefined);
}

export default replicate;
