import type { BRepAlgoAPI_Common, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { ShapeValidator } from "./shape-validator.js";
import type { MeasurePose } from "./measure/measure-types.js";

/** Axis-aligned world bounds of a body, corners as [x, y, z]. */
export type WorldBounds = { min: [number, number, number]; max: [number, number, number] };

/** A shape placed in the world: the raw shape, its bounds, and a disposer for the location it borrowed. */
export type PosedShape = { shape: TopoDS_Shape; bounds: WorldBounds; dispose: () => void };

/**
 * Kernel-level interference of two solids: the volume they share.
 * Stateless; every OCCT handle it creates is deleted before it returns.
 *
 * The check is two-stage so a scene with many bodies never pays for a
 * boolean on a pair that cannot touch: {@link boundsOverlap} on the world
 * bounds first, then {@link commonVolume} (`BRepAlgoAPI_Common`) integrated
 * with the same GProp path {@link ShapeValidator.signedVolume} uses.
 *
 * Bodies are posed by location only (`TopoDS_Shape.Moved`), the way
 * `SceneManager.measure` and `SelectionResolver` pose assembly entities: no
 * geometry is copied, and every kernel call reads through the
 * `TopLoc_Location`.
 */
export class ShapeInterference {

  /**
   * The shape placed at `pose` (identity when omitted), with its world
   * bounds. Call `dispose` once the shape is no longer needed; the returned
   * shape shares its geometry with the input.
   */
  static pose(shape: TopoDS_Shape, pose?: MeasurePose): PosedShape {
    if (!pose) {
      return { shape, bounds: ShapeInterference.bounds(shape), dispose: () => {} };
    }
    const [trsf, disposeTrsf] = Convert.toGpTrsfPose(pose.position, pose.quaternion);
    const location = new (getOC().TopLoc_Location)(trsf);
    const moved = shape.Moved(location, false);
    return {
      shape: moved,
      bounds: ShapeInterference.bounds(moved),
      dispose: () => {
        location.delete();
        disposeTrsf();
      },
    };
  }

  /** Exact (non-triangulation) world bounds, so an unmeshed body is still bounded. */
  static bounds(shape: TopoDS_Shape): WorldBounds {
    const oc = getOC();
    const box = new oc.Bnd_Box();
    try {
      oc.BRepBndLib.Add(shape, box, false);
      const min = box.CornerMin();
      const max = box.CornerMax();
      return {
        min: [min.X(), min.Y(), min.Z()],
        max: [max.X(), max.Y(), max.Z()],
      };
    } finally {
      box.delete();
    }
  }

  /**
   * True when the two boxes, each grown by `gap`, share space. Touching
   * boxes overlap at any gap >= 0, so a face-to-face pair still reaches the
   * boolean and is judged by its common volume rather than by its bounds.
   */
  static boundsOverlap(a: WorldBounds, b: WorldBounds, gap: number): boolean {
    for (let axis = 0; axis < 3; axis++) {
      if (a.max[axis] + gap < b.min[axis] || b.max[axis] + gap < a.min[axis]) {
        return false;
      }
    }
    return true;
  }

  /**
   * The volume the two solids share, in the kernel's units cubed. Zero for
   * disjoint or merely touching solids. Throws with the kernel's message
   * when the boolean fails; the caller decides whether to continue.
   */
  static commonVolume(a: TopoDS_Shape, b: TopoDS_Shape): number {
    const oc = getOC();
    const progress = new oc.Message_ProgressRange();
    let common: BRepAlgoAPI_Common | null = null;
    try {
      common = new oc.BRepAlgoAPI_Common(a, b, progress);
      common.SetRunParallel(true);
      common.Build(progress);
      if (!common.IsDone() || common.HasErrors()) {
        throw new Error('Common failed: the boolean operation reported an error.');
      }
      return ShapeValidator.signedVolume(common.Shape());
    } finally {
      if (common) {
        common.delete();
      }
      progress.delete();
    }
  }
}
