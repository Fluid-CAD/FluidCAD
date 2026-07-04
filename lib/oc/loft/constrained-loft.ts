import type { TopoDS_Shape } from "ocjs-fluidcad";
import { Wire } from "../../common/wire.js";
import { Solid } from "../../common/solid.js";
import { FaceOps } from "../face-ops.js";
import { SectionCompatibility, CompatibleSections } from "./section-compatibility.js";
import { Skinning, LoftEndCondition, SkinnedGrid } from "./skinning.js";

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
    const compatible = ConstrainedLoft.skinWires(wires);
    const skinned = Skinning.skinSections(compatible, startCondition, endCondition);
    return [Skinning.buildLoftSolid(compatible, skinned.grid, skinned.vBasis)];
  }

  /**
   * Thin-walled conditioned loft, assembled directly: outer wall, inner
   * wall, and two planar ring caps sewn into one solid. Cutting the inner
   * loft out of the outer with a boolean instead takes OCC seconds — two
   * nearly-parallel B-spline shells are the pave-filler's worst case — and
   * the walls are already exact offsets, so no boolean is needed.
   */
  static buildThin(
    outerWires: Wire[],
    innerWires: Wire[],
    startCondition: LoftEndCondition | undefined,
    endCondition: LoftEndCondition | undefined,
  ): Solid[] {
    const outer = ConstrainedLoft.skinWires(outerWires);
    const inner = ConstrainedLoft.skinWires(innerWires);
    const outerSkin = Skinning.skinSections(outer, startCondition, endCondition);
    const innerSkin = Skinning.skinSections(inner, startCondition, endCondition);

    const faces = [
      ...Skinning.sideFaces(outer, outerSkin.grid, outerSkin.vBasis),
      ...Skinning.sideFaces(inner, innerSkin.grid, innerSkin.vBasis),
      ConstrainedLoft.ringCap(outer, outerSkin, inner, innerSkin, false),
      ConstrainedLoft.ringCap(outer, outerSkin, inner, innerSkin, true),
    ];
    return [Skinning.sewSolid(faces)];
  }

  private static skinWires(wires: Wire[]): CompatibleSections {
    for (const wire of wires) {
      if (!wire.isClosed()) {
        throw new Error("Loft with start/end conditions requires closed profiles.");
      }
    }
    return SectionCompatibility.build(wires.map(w => w.getShape()));
  }

  /** Planar ring between the outer and inner wall boundaries at one end. */
  private static ringCap(
    outer: CompatibleSections,
    outerSkin: SkinnedGrid,
    inner: CompatibleSections,
    innerSkin: SkinnedGrid,
    isEnd: boolean,
  ): TopoDS_Shape {
    const column = (grid: number[][][]) =>
      grid.map(row => row[isEnd ? row.length - 1 : 0]);

    const outerWire = new Wire(Skinning.capWire(outer, column(outerSkin.grid)));
    const innerWire = new Wire(Skinning.capWire(inner, column(innerSkin.grid)));
    const ring = FaceOps.makeFaceWithHoles(outerWire, [innerWire]);
    return FaceOps.fixFaceOrientation(ring).getShape();
  }
}
