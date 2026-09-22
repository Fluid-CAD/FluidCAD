import type { TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { BooleanOps } from "../boolean-ops.js";
import { Explorer } from "../explorer.js";
import { FaceOps } from "../face-ops.js";
import { ShapeOps } from "../shape-ops.js";
import { ShapeValidator } from "../shape-validator.js";
import { Shape } from "../../common/shape.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { Wire } from "../../common/wire.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Vector3d } from "../../math/vector3d.js";
import { mmTol } from "../../units/tolerance.js";
import { CornerJoins } from "./corner-joins.js";
import { PipeRun, type PipeRunResult, type PipeSection } from "./pipe-run.js";
import type { SpineAnalysis, SpineCorner, SpineTrihedron } from "./spine-analysis.js";

/** The pipe over one run, with the overshoot its corners asked for. */
interface Leg extends PipeRunResult {
  startExtension: number;
  endExtension: number;
}

/**
 * Sweeps a section along a spine with sharp corners: one MakePipeShell call
 * per G1 run, each run's start section derived from the previous run's end
 * section turned through the corner, and the legs joined by a mitre (two
 * lines) or a round wedge (a curved leg) — see {@link CornerJoins}.
 */
export class CorneredSweep {
  /** Extra overshoot past the exact mitre reach, so the trim never grazes the pipe's own end. */
  private static readonly REACH_MARGIN = 0.05;

  static build(
    spine: SpineAnalysis,
    profile: TopoDS_Wire,
    trihedron: SpineTrihedron,
    withCorrection: boolean,
  ): PipeRunResult {
    const radius = spine.sectionRadius(profile);
    const extensions = CorneredSweep.cornerExtensions(spine, radius);

    const legs: Leg[] = [];
    let section: PipeSection = { wire: profile, placed: false, withCorrection };
    for (let k = 0; k < spine.runs.length; k++) {
      const startExtension = CorneredSweep.extensionAt(spine.startCorner(k), spine, extensions);
      const endExtension = CorneredSweep.extensionAt(spine.endCorner(k), spine, extensions);

      // Run 0 of a closed spine starts at the closing corner. Its start
      // section is only known once OCC has placed the profile, so sweep the
      // bare run first and re-sweep it with that section moved out to the
      // overshoot.
      if (k === 0 && startExtension > 0) {
        const bare = PipeRun.sweep(spine.runWire(0, 0, 0), section, trihedron);
        section = CorneredSweep.placed(
          CorneredSweep.translated(FaceOps.outerWireRaw(Explorer.toFace(bare.firstFace)), spine.startTangent, -startExtension),
        );
      }

      const run = PipeRun.sweep(spine.runWire(k, startExtension, endExtension), section, trihedron);
      legs.push({ ...run, startExtension, endExtension });

      const corner = spine.endCorner(k);
      if (corner && k + 1 < spine.runs.length) {
        const nextStart = CorneredSweep.extensionAt(corner, spine, extensions);
        section = CorneredSweep.placed(CorneredSweep.turnSection(run.lastFace, corner, endExtension, nextStart));
      }
    }

    return CorneredSweep.join(spine, legs, radius, extensions);
  }

  /**
   * The section the next run starts with: the previous run's end section
   * pulled back from its overshoot to the corner, turned through the corner,
   * then pushed out to the next run's overshoot.
   */
  private static turnSection(endFace: TopoDS_Shape, corner: SpineCorner, backExtension: number, forwardExtension: number): TopoDS_Wire {
    let wire = FaceOps.outerWireRaw(Explorer.toFace(endFace));
    wire = CorneredSweep.translated(wire, corner.inTangent, -backExtension);
    wire = CorneredSweep.transformed(wire, Matrix4.fromRotationAroundAxis(corner.point, corner.axis, corner.angle));
    return CorneredSweep.translated(wire, corner.outTangent, -forwardExtension);
  }

  /** Trims the mitred legs, builds the round wedges, and fuses everything into one solid. */
  private static join(spine: SpineAnalysis, legs: Leg[], radius: number, extensions: number[]): PipeRunResult {
    const solids = legs.map(leg => leg.solid);
    const wedges: Shape[] = [];
    spine.corners.forEach((corner, i) => {
      const before = i;
      const after = (i + 1) % legs.length;
      const extent = radius + extensions[i];
      if (corner.join === "mitre") {
        const normal = CornerJoins.mitreNormal(corner);
        solids[before] = CornerJoins.trimBeyondPlane(solids[before], corner.point, normal, extent);
        solids[after] = CornerJoins.trimBeyondPlane(solids[after], corner.point, normal.negate(), extent);
      } else {
        wedges.push(...CornerJoins.roundWedge(legs[before].lastFace, corner, extent));
      }
    });

    const fused = BooleanOps.fuse([...solids.map(s => ShapeFactory.fromShape(s)), ...wedges]);
    try {
      const joined = fused.result.flatMap(s => Explorer.findShapes(s.getShape(), Explorer.getOcShapeType("solid")));
      if (joined.length !== 1) {
        throw new Error(`Sweep corner join failed: the legs did not fuse into one solid (${joined.length} pieces).`);
      }
      const validation = ShapeValidator.validate(joined[0]);
      if (validation.findings.length > 0) {
        throw new Error(`Sweep corner join produced an invalid solid: ${validation.findings.map(f => f.message).join("; ")}`);
      }
      return {
        solid: joined[0],
        firstFace: ShapeOps.trackFace(fused.maker, legs[0].firstFace, joined[0]),
        lastFace: ShapeOps.trackFace(fused.maker, legs[legs.length - 1].lastFace, joined[0]),
      };
    } finally {
      fused.dispose();
    }
  }

  /**
   * Per corner, how far each leg overshoots it: the mitre reach plus a
   * margin, or nothing for a round join. Refuses a line edge shorter than
   * the overshoots at its ends, which would leave the mitre planes crossing
   * inside the pipe.
   */
  private static cornerExtensions(spine: SpineAnalysis, radius: number): number[] {
    const extensions = spine.corners.map(corner => {
      if (corner.join !== "mitre") {
        return 0;
      }
      const reach = CornerJoins.mitreReach(corner, radius);
      return reach + Math.max(reach * CorneredSweep.REACH_MARGIN, mmTol(0.1));
    });

    spine.runs.forEach((run, k) => {
      const first = run.edges[0];
      const last = run.edges[run.edges.length - 1];
      const startExtension = CorneredSweep.extensionAt(spine.startCorner(k), spine, extensions);
      const endExtension = CorneredSweep.extensionAt(spine.endCorner(k), spine, extensions);
      const budget = [
        { edge: first, used: startExtension + (run.edges.length === 1 ? endExtension : 0) },
        { edge: last, used: endExtension + (run.edges.length === 1 ? startExtension : 0) },
      ];
      for (const { edge, used } of budget) {
        if (used > 0 && edge.length - used <= mmTol(1e-3)) {
          throw new Error(
            `Sweep path segment of length ${edge.length.toFixed(3)} is too short for this profile: ` +
            `its mitred corner(s) reach ${used.toFixed(3)} along it. Shorten the profile or lengthen the segment.`,
          );
        }
      }
    });

    return extensions;
  }

  private static extensionAt(corner: SpineCorner | null, spine: SpineAnalysis, extensions: number[]): number {
    return corner ? extensions[spine.corners.indexOf(corner)] : 0;
  }

  private static placed(wire: TopoDS_Wire): PipeSection {
    return { wire, placed: true, withCorrection: false };
  }

  private static translated(wire: TopoDS_Wire, direction: Vector3d, distance: number): TopoDS_Wire {
    if (distance === 0) {
      return wire;
    }
    return CorneredSweep.transformed(wire, Matrix4.fromTranslationVector(direction.multiply(distance)));
  }

  private static transformed(wire: TopoDS_Wire, matrix: Matrix4): TopoDS_Wire {
    return ShapeOps.transform(Wire.fromTopoDSWire(wire), matrix).getShape() as TopoDS_Wire;
  }
}
