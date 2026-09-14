// The handle MirrorShape2D.instance(source) returns: a lazy whole-geometry
// selection over the stamped image of `source` (offset/fillet operands
// keep working), and a constraint target — the image is a real solver
// entity rigidly tied to its source across the mirror line, with
// .start()/.end()/.center() point accessors modeled on Copy2DInstance.
// Resolution lives on the mirror (MirrorShape2D.instanceSolverRef) and
// every failure throws statement-speak errors the constraint emission
// path stashes on the constraint statement.

import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { LazyVertex } from "./lazy-vertex.js";
import { Vertex } from "../common/vertex.js";
import type { SceneObject } from "../common/scene-object.js";
import type { MirrorShape2D } from "./mirror-shape2d.js";
import type { PointRole, SolverRef } from "../sketch-solver/index.js";

export class Mirror2DInstance extends LazySelectionSceneObject {

  constructor(
    private readonly instanceName: string,
    readonly mirrorOwner: MirrorShape2D,
    readonly source: SceneObject,
  ) {
    super(instanceName, (parent) => {
      return (parent as MirrorShape2D).getInstanceShapes(source);
    }, mirrorOwner);
  }

  /** Solver ref naming the image entity of `source`. Throws statement-speak
   * errors when the source has no image in this mirror. */
  solverRef(what: string, role?: PointRole): SolverRef {
    return this.mirrorOwner.instanceSolverRef(this.source, what, role);
  }

  start(): Mirror2DInstancePointRef {
    return new Mirror2DInstancePointRef(this, 'start');
  }

  end(): Mirror2DInstancePointRef {
    return new Mirror2DInstancePointRef(this, 'end');
  }

  center(): Mirror2DInstancePointRef {
    return new Mirror2DInstancePointRef(this, 'center');
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const owner = (remap.get(this.mirrorOwner) as MirrorShape2D | undefined) ?? this.mirrorOwner;
    const source = remap.get(this.source) ?? this.source;
    return new Mirror2DInstance(this.instanceName, owner, source);
  }
}

/**
 * A named point of a mirror image (`m.instance(l).start()`).
 * LazyVertex-compatible so it resolves as a plain point wherever one is
 * accepted — reading the image entity's CURRENT solver params (guesses
 * until the solve, solved values after).
 */
export class Mirror2DInstancePointRef extends LazyVertex {
  constructor(
    readonly instance: Mirror2DInstance,
    readonly role: PointRole,
  ) {
    super(`mirror-instance-${role}`, () => {
      const point = instance.mirrorOwner.instancePointValue(instance.source, role);
      return [Vertex.fromPoint2D(point)];
    });
  }
}
