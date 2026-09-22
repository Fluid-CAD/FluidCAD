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
 * The loft kernel: profiles become compatible B-spline sections
 * (`SectionCompatibility`), matching pole columns are interpolated along the
 * loft — with the end derivatives pinned when a condition asks for it — and
 * the resulting surface is capped and sewn into a solid (`Skinning`).
 *
 * Every loft runs here, plain ones included, so the topology (cap edges cut
 * from the section curve, walls split at profile creases) is the same
 * whether or not a loft carries connections or conditions; OCC's
 * `BRepOffsetAPI_ThruSections` can enforce neither, and switching kernels
 * per option changed the result's edges and faces along with its shape.
 *
 * Conditions:
 * - `normal`: the surface leaves the profile along the profile's plane
 *   normal — a perpendicular takeoff.
 * - `tangent`: the surface leaves the profile inside the profile's plane,
 *   directed outward — profiles become tangency planes (e.g. a barrel from
 *   two stacked circles). Negative magnitudes direct it inward.
 */
export class SkinnedLoft {
  static build(
    wires: Wire[],
    startCondition?: LoftEndCondition,
    endCondition?: LoftEndCondition,
    connections?: Point[][],
  ): Solid[] {
    const compatible = SkinnedLoft.skinWires(wires, connections);
    const skinned = Skinning.skinSections(compatible, startCondition, endCondition);
    return [Skinning.buildLoftSolid(compatible, skinned.grid, skinned.vBasis)];
  }

  /**
   * Thin-walled loft, assembled directly: outer wall, inner wall, and two
   * planar ring caps sewn into one solid. Cutting the inner loft out of the
   * outer with a boolean instead takes OCC seconds — two nearly-parallel
   * B-spline shells are the pave-filler's worst case — and the walls are
   * already exact offsets, so no boolean is needed.
   *
   * Connections are stated on the profiles; each wall receives its own
   * image of every connection vertex (`ThinConnections`).
   */
  static buildThin(
    walls: ThinLoftWalls[],
    startCondition?: LoftEndCondition,
    endCondition?: LoftEndCondition,
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
      const outer = SkinnedLoft.skinWires(outerWall.wires, outerWall.connections);
      const inner = SkinnedLoft.skinWires(innerWall.wires, innerWall.connections);
      const outerSkin = Skinning.skinSections(outer, startCondition, endCondition);
      const innerSkin = Skinning.skinSections(inner, startCondition, endCondition);

      const faces = [
        ...Skinning.sideFaces(outer, outerSkin.grid, outerSkin.vBasis),
        ...Skinning.sideFaces(inner, innerSkin.grid, innerSkin.vBasis),
        SkinnedLoft.ringCap(outer, outerSkin, inner, innerSkin, false),
        SkinnedLoft.ringCap(outer, outerSkin, inner, innerSkin, true),
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
    for (const [k, wire] of wires.entries()) {
      if (!wire.isClosed()) {
        throw new Error(`Loft requires closed profiles; profile ${k + 1} is open.`);
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
