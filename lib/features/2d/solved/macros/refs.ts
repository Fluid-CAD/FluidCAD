// Accessor handles on macro shapes (`r.bottom()`, `r.corner(0)` and their
// points): the macro's sub-entities only get solver ids at the pre-solve
// pass, so — like projected references — these carry {owner, slot} and
// constraints targeting them register deferred with placeholder ids.

import { SketchPointVertex } from "../../../sketch-point-ref.js";
import type { SceneObject } from "../../../../common/scene-object.js";
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
export class MacroPointRef extends SketchPointVertex {
  constructor(
    readonly owner: MacroShapeBase,
    readonly slot: string,
    readonly role: PointRole,
  ) {
    super(owner, role, `${owner.getType()}-${slot}-${role}`, () => owner.slotPointValue(slot, role));
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const owner = (remap.get(this.owner) ?? this.owner) as MacroShapeBase;
    return new MacroPointRef(owner, this.slot, this.role);
  }
}
