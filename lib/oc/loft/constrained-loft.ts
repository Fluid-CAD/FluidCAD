import { Wire } from "../../common/wire.js";
import { Solid } from "../../common/solid.js";
import { SectionCompatibility } from "./section-compatibility.js";
import { Skinning, LoftEndCondition } from "./skinning.js";

export type { LoftConditionKind, LoftEndCondition } from "./skinning.js";

/**
 * Loft with start/end conditions. OCC's `BRepOffsetAPI_ThruSections` cannot
 * constrain end tangency, so this path skins the surface itself: profiles
 * become compatible B-spline sections (`SectionCompatibility`), matching pole
 * columns are interpolated along the loft with the end derivatives pinned,
 * and the resulting surface is capped and sewn into a solid (`Skinning`).
 *
 * Conditions:
 * - `normal`: the surface leaves the profile along the profile's plane
 *   normal — a perpendicular takeoff.
 * - `tangent`: the surface leaves the profile inside the profile's plane,
 *   directed outward — profiles become tangency planes (e.g. a barrel from
 *   two stacked circles). Negative magnitudes direct it inward.
 */
export class ConstrainedLoft {
  static build(
    wires: Wire[],
    startCondition: LoftEndCondition | undefined,
    endCondition: LoftEndCondition | undefined,
  ): Solid[] {
    for (const wire of wires) {
      if (!wire.isClosed()) {
        throw new Error("Loft with start/end conditions requires closed profiles.");
      }
    }

    const compatible = SectionCompatibility.build(wires.map(w => w.getShape()));
    const skinned = Skinning.skinSections(compatible, startCondition, endCondition);
    return [Skinning.buildLoftSolid(compatible, skinned.grid, skinned.vBasis)];
  }
}
