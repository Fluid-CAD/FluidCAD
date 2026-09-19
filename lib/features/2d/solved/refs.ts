// Point accessors on solved entities: LazyVertex-compatible (they resolve to
// a Vertex anywhere a point is accepted, reading the entity's *current*
// solver params — guesses during module evaluation, solved values after the
// build's solve), and carrying {owner, role} so the constraint statement
// layer resolves them to solver refs without any numeric round trip.

import { SketchPointVertex } from "../../sketch-point-ref.js";
import type { SceneObject } from "../../../common/scene-object.js";
import type { SolvedGeometryBase, SolvedPointRole } from "./solved-base.js";

export class SolvedPointRef extends SketchPointVertex {
  constructor(
    readonly owner: SolvedGeometryBase,
    readonly role: SolvedPointRole,
    uniqueName: string,
  ) {
    super(owner, role, uniqueName, () => owner.pointValue(role));
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const owner = (remap.get(this.owner) ?? this.owner) as SolvedGeometryBase;
    return new SolvedPointRef(owner, this.role, this.referenceName);
  }
}
