import type { TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Explorer } from "./explorer.js";
import { FaceOps } from "./face-ops.js";
import { FaceQuery } from "./face-query.js";
import { ShapeOps } from "./shape-ops.js";
import { ShapeInterference } from "./shape-interference.js";
import { Extruder } from "../features/simple-extruder.js";

/** Where a probe meets a face, as signed distances from the probe's plane. */
export interface FaceReachHit {
  /** Distance to the nearest point of the face the probe encloses. */
  entry: number;
  /** Distance to the farthest point of the face the probe encloses. */
  exit: number;
}

/**
 * The faces an extrusion would run into: a probe prism sweeps the profile
 * `length` along the plane normal, and {@link measure} reports where that
 * prism encloses a face — the signed distances from the plane to the
 * nearest and farthest enclosed point. A face the prism misses, or one it
 * only runs along (a plane parallel to the sweep, a cylinder coaxial with
 * it, a face flat on the sketch plane) is not a hit: nothing about it could
 * end the extrusion.
 *
 * The distances are measured on the enclosed region itself, against
 * square faces on the plane and on its `length` offset, so they hold for
 * any sweep direction, not only the world axes a bounding box aligns with.
 */
export class FaceReach {
  private readonly probe: Shape;
  private readonly solids: Shape[];
  private readonly extruder: Extruder;
  private readonly nearFace: TopoDS_Face;
  private readonly farFace: TopoDS_Face;
  private readonly tolerance: number;

  constructor(
    profile: Face[],
    private readonly plane: Plane,
    private readonly length: number,
    draft?: [number, number],
  ) {
    const oc = getOC();
    this.tolerance = oc.Precision.Confusion();

    let extruder = new Extruder(profile, plane, length, draft, 0);
    let solids: Shape[];
    try {
      solids = extruder.extrude();
    } catch (error) {
      // A draft the probe's length collapses: the undrafted sweep still
      // tells which faces lie ahead.
      if (!draft) throw error;
      extruder = new Extruder(profile, plane, length, undefined, 0);
      solids = extruder.extrude();
    }
    this.extruder = extruder;
    this.solids = solids;
    this.probe = ShapeOps.makeCompound(solids);

    // The measuring squares must cover the probe's footprint wherever the
    // plane's origin sits relative to it.
    const bounds = ShapeOps.getBoundingBox(this.probe);
    const center = new Point(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    );
    const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
    const halfSize = diagonal + plane.origin.distanceTo(center) + 1;
    this.nearFace = FaceOps.makeSquareFace(plane, halfSize);
    this.farFace = FaceOps.makeSquareFace(plane.translateAlongNormal(length), halfSize);
  }

  measure(face: Face): FaceReachHit | null {
    const raw = face.getShape();
    if (this.runsAlongSweep(raw)) {
      return null;
    }

    const oc = getOC();
    const faceBounds = new oc.Bnd_Box();
    const probeBounds = new oc.Bnd_Box();
    oc.BRepBndLib.Add(raw, faceBounds, false);
    oc.BRepBndLib.Add(this.probe.getShape(), probeBounds, false);
    const apart = faceBounds.IsOut(probeBounds);
    faceBounds.delete();
    probeBounds.delete();
    if (apart) {
      return null;
    }

    const hit = ShapeInterference.withCommon(raw, this.probe.getShape(), (shape) => {
      const pieces = Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE as any);
      try {
        if (pieces.length === 0) {
          return null;
        }
        let entry = Infinity;
        let exit = -Infinity;
        for (const piece of pieces) {
          entry = Math.min(entry, this.distance(piece, this.nearFace));
          exit = Math.max(exit, this.length - this.distance(piece, this.farFace));
        }
        return { entry, exit };
      } finally {
        Explorer.deleteAll(pieces);
      }
    });

    // Flat on the sketch plane: the face the sketch sits on, or the
    // probe's own start cap where a coplanar face overlaps it.
    if (!hit || hit.exit <= this.tolerance) {
      return null;
    }
    return { entry: Math.max(hit.entry, 0), exit: hit.exit };
  }

  /**
   * A surface the sweep direction lies in can only be grazed, never
   * crossed: a plane whose normal is perpendicular to the sweep, or a
   * cylinder whose axis follows it.
   */
  private runsAlongSweep(raw: TopoDS_Shape): boolean {
    const type = FaceQuery.getSurfaceTypeRaw(raw);
    if (type === "plane") {
      const pln = FaceQuery.getSurfaceAdaptorPlaneRaw(raw);
      const dir = pln.Axis().Direction();
      const dot = dir.X() * this.plane.normal.x + dir.Y() * this.plane.normal.y + dir.Z() * this.plane.normal.z;
      dir.delete();
      pln.delete();
      return Math.abs(dot) < 1e-6;
    }
    if (type === "cylinder") {
      const axis = FaceOps.axialSurfaceAxisRaw(raw as TopoDS_Face);
      if (!axis) return false;
      return Math.abs(axis.direction.normalize().dot(this.plane.normal)) > 1 - 1e-6;
    }
    return false;
  }

  private distance(a: TopoDS_Shape, b: TopoDS_Shape): number {
    const oc = getOC();
    const progress = new oc.Message_ProgressRange();
    const calc = new oc.BRepExtrema_DistShapeShape(
      a, b,
      oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
      oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
      progress,
    );
    const value = calc.IsDone() ? calc.Value() : Infinity;
    calc.delete();
    progress.delete();
    return value;
  }

  dispose(): void {
    this.nearFace.delete();
    this.farFace.delete();
    this.extruder.dispose();
    this.probe.dispose();
    for (const solid of this.solids) {
      solid.dispose();
    }
  }
}
