// Point accessors on solved entities: LazyVertex-compatible (they resolve to
// a Vertex anywhere a point is accepted, reading the entity's *current*
// solver params — guesses during module evaluation, solved values after the
// build's solve), and carrying {owner, role} so the constraint statement
// layer resolves them to solver refs without any numeric round trip.

import { LazyVertex } from "../../lazy-vertex.js";
import { Vertex } from "../../../common/vertex.js";
import type { SolvedGeometryBase, SolvedPointRole } from "./solved-base.js";

export class SolvedPointRef extends LazyVertex {
  constructor(
    readonly owner: SolvedGeometryBase,
    readonly role: SolvedPointRole,
    uniqueName: string,
  ) {
    super(uniqueName, () => [Vertex.fromPoint2D(owner.pointValue(role))]);
  }
}
