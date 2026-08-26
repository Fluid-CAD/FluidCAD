// The handle Copy2DBase.instance(k) returns: still a lazy whole-geometry
// selection over grid slot k (offset/fillet operands keep working), but
// ALSO a constraint target — when the slot holds exactly one solver-backed
// edge it resolves to that duplicate's solver entity (the ORIGINAL's slot
// resolves to the source statement itself), with .start()/.end()/.center()
// point accessors modeled on the P6 ReferenceEntityRef/ReferencePointRef
// pair. Resolution lives on the copy (Copy2DBase.instanceSolverRef) and
// every failure throws statement-speak errors the constraint emission path
// stashes on the constraint statement.

import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { LazyVertex } from "./lazy-vertex.js";
import { Vertex } from "../common/vertex.js";
import type { SceneObject } from "../common/scene-object.js";
import type { Copy2DBase } from "./copy2d-base.js";
import type { PointRole, SolverRef } from "../sketch-solver/index.js";

export class Copy2DInstance extends LazySelectionSceneObject {

  constructor(
    private readonly instanceName: string,
    readonly copyOwner: Copy2DBase,
    readonly slot: number,
  ) {
    super(instanceName, (parent) => {
      return (parent as Copy2DBase).getInstanceEdges(slot);
    }, copyOwner);
  }

  /** Solver ref naming the slot's single solver-backed entity — the
   * duplicate for a copied slot, the SOURCE entity for the original's
   * slot. Throws statement-speak errors for every other slot make-up. */
  solverRef(what: string, role?: PointRole): SolverRef {
    return this.copyOwner.instanceSolverRef(this.slot, what, role);
  }

  start(): Copy2DInstancePointRef {
    return new Copy2DInstancePointRef(this, 'start');
  }

  end(): Copy2DInstancePointRef {
    return new Copy2DInstancePointRef(this, 'end');
  }

  center(): Copy2DInstancePointRef {
    return new Copy2DInstancePointRef(this, 'center');
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const owner = (remap.get(this.copyOwner) as Copy2DBase | undefined) ?? this.copyOwner;
    return new Copy2DInstance(this.instanceName, owner, this.slot);
  }
}

/**
 * A named point of a copy instance (`cp.instance(2).start()`).
 * LazyVertex-compatible so it resolves as a plain point wherever one is
 * accepted — reading the resolved entity's CURRENT solver params (guesses
 * until the solve, solved values after).
 */
export class Copy2DInstancePointRef extends LazyVertex {
  constructor(
    readonly instance: Copy2DInstance,
    readonly role: PointRole,
  ) {
    super(`copy-instance-${instance.slot}-${role}`, () => {
      const point = instance.copyOwner.instancePointValue(instance.slot, role);
      return [Vertex.fromPoint2D(point)];
    });
  }
}
