// Accessor handles on macro shapes (`r.bottom()`, `r.corner(0)` and their
// points): the macro's sub-entities only get solver ids at the pre-solve
// pass, so — like projected references — these carry {owner, slot} and
// constraints targeting them register deferred with placeholder ids.

import { LazyVertex } from "../../../lazy-vertex.js";
import { Vertex } from "../../../../common/vertex.js";
import type { PointRole } from "../../../../sketch-solver/index.js";
import type { MacroShapeBase } from "./base.js";

/**
 * One named edge of a macro shape as a constraint target. Point
 * accessors mirror the solved primitives' (`.start()/.end()` on lines
 * and arcs, `.center()` on arcs).
 */
export class MacroEdgeRef {
  constructor(readonly owner: MacroShapeBase, readonly slot: string) {}

  start(): MacroPointRef {
    return new MacroPointRef(this.owner, this.slot, 'start');
  }

  end(): MacroPointRef {
    return new MacroPointRef(this.owner, this.slot, 'end');
  }

  center(): MacroPointRef {
    return new MacroPointRef(this.owner, this.slot, 'center');
  }
}

/**
 * A named point of a macro edge. LazyVertex-compatible so it resolves
 * as a plain point wherever one is accepted — reading the recipe
 * guess before the pre-solve pass, the solver params after.
 */
export class MacroPointRef extends LazyVertex {
  constructor(
    readonly owner: MacroShapeBase,
    readonly slot: string,
    readonly role: PointRole,
  ) {
    super(`${owner.getType()}-${slot}-${role}`, () => {
      return [Vertex.fromPoint2D(owner.slotPointValue(slot, role))];
    });
  }
}
