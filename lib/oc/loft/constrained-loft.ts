import type { TopoDS_Shape } from "ocjs-fluidcad";
import { Wire } from "../../common/wire.js";
import { Solid } from "../../common/solid.js";
import { FaceOps } from "../face-ops.js";
import { SectionCompatibility, CompatibleSections } from "./section-compatibility.js";
import { Skinning, LoftEndCondition, SkinnedGrid } from "./skinning.js";
import { Point } from "../../math/point.js";
import { ConnectionResolver } from "./connection-resolver.js";
import { ThinConnections } from "./thin-connections.js";

export type { LoftConditionKind, LoftEndCondition } from "./skinning.js";

/** One thin profile's two walls, with the profile they offset for carrying connections across. */
export interface ThinLoftWalls {
  outer: Wire;
  inner: Wire;
  source: Wire;
  /** Unsigned offsets of each wall from `source`. */
  outerDistance: number;
  innerDistance: number;
}

/**
 * Loft with vertex connections or start/end conditions. OCC's
 * `BRepOffsetAPI_ThruSections` cannot enforce either constraint, so this
 * path skins the surface itself: profiles
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
    connections?: Point[][],
  ): Solid[] {
    const compatible = ConstrainedLoft.skinWires(wires, connections);
    const skinned = Skinning.skinSections(compatible, startCondition, endCondition);
    return [Skinning.buildLoftSolid(compatible, skinned.grid, skinned.vBasis)];
  }

  /**
   * Thin-walled conditioned loft, assembled directly: outer wall, inner
   * wall, and two planar ring caps sewn into one solid. Cutting the inner
   * loft out of the outer with a boolean instead takes OCC seconds — two
   * nearly-parallel B-spline shells are the pave-filler's worst case — and
   * the walls are already exact offsets, so no boolean is needed.
   *
   * Connections are stated on the profiles; each wall receives its own
   * image of every connection vertex (`ThinConnections`).
   */
  static buildThin(
    walls: ThinLoftWalls[],
    startCondition: LoftEndCondition | undefined,
    endCondition: LoftEndCondition | undefined,
    connections?: Point[][],
  ): Solid[] {
    const rebuilt: Wire[] = [];
    try {
      const wall = (side: 'outer' | 'inner'): { wires: Wire[]; connections?: Point[][] } => {
        const wires = walls.map(w => w[side]);
        if (!connections?.length) {
          return { wires };
        }
        const mapped = ThinConnections.map(walls.map(w => ({
          wall: w[side], source: w.source, distance: side === 'outer' ? w.outerDistance : w.innerDistance,
        })), connections, side);
        rebuilt.push(...mapped.rebuilt);
        return mapped;
      };
      const outerWall = wall('outer');
      const innerWall = wall('inner');
      const outer = ConstrainedLoft.skinWires(outerWall.wires, outerWall.connections);
      const inner = ConstrainedLoft.skinWires(innerWall.wires, innerWall.connections);
      const outerSkin = Skinning.skinSections(outer, startCondition, endCondition);
      const innerSkin = Skinning.skinSections(inner, startCondition, endCondition);

      const faces = [
        ...Skinning.sideFaces(outer, outerSkin.grid, outerSkin.vBasis),
        ...Skinning.sideFaces(inner, innerSkin.grid, innerSkin.vBasis),
        ConstrainedLoft.ringCap(outer, outerSkin, inner, innerSkin, false),
        ConstrainedLoft.ringCap(outer, outerSkin, inner, innerSkin, true),
      ];
      return [Skinning.sewSolid(faces)];
    } finally {
      for (const wire of rebuilt) {
        wire.dispose();
      }
    }
  }

  private static skinWires(wires: Wire[], connections?: Point[][]): CompatibleSections {
    if (connections?.length) {
      const pins = ConnectionResolver.resolve(wires, connections);
      return SectionCompatibility.build(wires.map(wire => wire.getShape()), pins);
    }
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
