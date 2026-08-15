import { AssemblyOccurrence } from "../rendering/assembly-scene.js";
import { PoseHandle } from "./pose-handle.js";

/**
 * Handle for one inserted sub-assembly — the Assembly counterpart of
 * `Instance`. Returned by `insert(assembly('name', () => {...}))`.
 *
 * `.grounded()` grounds this occurrence's FRAME in the parent scope: the
 * sub-assembly's declared-grounded instances (its anchors) become
 * world-grounded when the chain of grounded frames reaches the root scene.
 * An ungrounded occurrence leaves the whole cluster free — the parent
 * decides grounding, which is what removes the old "pass grounded=false
 * when composing" parameter hack.
 */
export class Occurrence<T = unknown> extends PoseHandle<AssemblyOccurrence> {
  constructor(
    record: AssemblyOccurrence,
    /**
     * The callback's return value — whatever instance/occurrence handles the
     * assembly chose to expose (e.g. `{ left: { p1, p2 } }`), created fresh
     * for this occurrence, so deep references like
     * `gantry.parts.left.p1.connectors.start` bind to THIS occurrence only.
     */
    public readonly parts: T,
  ) {
    super(record);
  }
}
