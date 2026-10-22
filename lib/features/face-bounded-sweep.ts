import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceOps } from "../oc/face-ops.js";
import { FaceQuery } from "../oc/face-query.js";
import { FaceReach } from "../oc/face-reach.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { mmTol } from "../units/tolerance.js";
import { Extruder } from "./simple-extruder.js";

/** The modifiers that shape a face-bounded sweep besides its two faces. */
export type FaceBoundedSweepOptions = {
  /** Draft per side in degrees, or null/undefined for straight walls. */
  draft?: [number, number] | null;
  /** `.endOffset()` — how far short of the target the sweep stops. */
  endOffset?: number;
};

export type FaceBoundedSweepResult = {
  /** The swept bodies, one per piece the profile face yields. */
  solids: Shape[];
  /**
   * The extruder that swept them, when the target is a parallel plane and the
   * sweep is a plain prism: its classified start/end/side faces are the
   * caller's to record or free. Null on the split path, whose end face is a
   * patch of the target surface and has no extruder classification.
   */
  extruder: Extruder | null;
};

/**
 * The geometry of an extrusion that ends on a face instead of at a distance,
 * shared by the applied feature (`ExtrudeToFace`) and the extrude ghost so
 * the preview sweeps exactly what the apply will. Nothing here reads scene
 * state: the caller resolves the profile faces and the target, and owns
 * every shape it passes in and gets back.
 *
 * Two constructions, chosen per profile face by {@link endsWithPrism}:
 * - A target plane parallel to the sketch plane ends the sweep with a plain
 *   prism of the signed distance between the planes.
 * - Anything else — a tilted plane, a cylinder, a cone — is reached by
 *   sweeping past the target's far extent, splitting the prism with the
 *   target surface grown to cover it, and keeping the piece still standing
 *   on the sketch plane.
 */
export class FaceBoundedSweep {
  /** The target ends the sweep with a plain prism: a plane parallel to the sketch plane. */
  static endsWithPrism(startFace: Face, targetFace: Face): boolean {
    return FaceQuery.isPlanarFace(targetFace) && FaceQuery.areFacePlanesParallel(startFace, targetFace);
  }

  /** Sweep one profile face up to the target. */
  static sweep(startFace: Face, targetFace: Face, sketchPlane: Plane, options: FaceBoundedSweepOptions): FaceBoundedSweepResult {
    if (FaceBoundedSweep.endsWithPrism(startFace, targetFace)) {
      return FaceBoundedSweep.prism(startFace, targetFace, sketchPlane, options);
    }
    return { solids: FaceBoundedSweep.split(startFace, targetFace, sketchPlane, options), extruder: null };
  }

  /**
   * The nearest ('first') or farthest ('last') candidate the profile's sweep
   * runs into along the sketch normal, or null when it meets none. The
   * profile is swept past every candidate and only the faces that sweep
   * actually encloses count; a face beside the path, however close its
   * centre, never stops the extrusion. Among faces met at the same distance
   * a planar one wins: it ends the extrusion with a plain prism.
   */
  static pickReached(
    candidates: Face[],
    plane: Plane,
    mode: 'first' | 'last',
    profile: Face[],
    draft?: [number, number] | null,
  ): Face | null {
    if (candidates.length === 0 || profile.length === 0) {
      return null;
    }

    // Sweep past the farthest candidate corner ahead of the plane.
    let reach = 0;
    for (const face of candidates) {
      for (const corner of ShapeOps.boundingBoxCorners(ShapeOps.getBoundingBox(face))) {
        reach = Math.max(reach, plane.signedDistanceToPoint(corner));
      }
    }
    const same = mmTol(1e-5);
    if (reach <= same) {
      return null;
    }

    const sweep = new FaceReach(profile, plane, reach * 1.1 + mmTol(1), draft ?? undefined);
    try {
      let best: Face | null = null;
      let bestDistance = mode === 'first' ? Infinity : -Infinity;
      let bestPlanar = false;
      for (const face of candidates) {
        const hit = sweep.measure(face);
        if (!hit) {
          continue;
        }
        const distance = mode === 'first' ? hit.entry : hit.exit;
        const closer = mode === 'first' ? distance < bestDistance - same : distance > bestDistance + same;
        const tied = Math.abs(distance - bestDistance) <= same;
        const planar = FaceQuery.isPlanarFace(face);
        if (closer || (tied && planar && !bestPlanar)) {
          best = face;
          bestDistance = distance;
          bestPlanar = planar;
        }
      }
      return best;
    } finally {
      sweep.dispose();
    }
  }

  /** A plain prism from the sketch plane to the parallel target plane. */
  private static prism(startFace: Face, targetFace: Face, sketchPlane: Plane, options: FaceBoundedSweepOptions): FaceBoundedSweepResult {
    const targetPlane = FaceQuery.getSurfacePlane(targetFace);
    const distance = sketchPlane.signedDistanceToPoint(targetPlane.origin);
    const extruder = new Extruder([startFace], sketchPlane, distance, options.draft ?? undefined, options.endOffset);
    return { solids: extruder.extrude(), extruder };
  }

  /**
   * Sweep past the target, split with the target surface grown to cover the
   * prism, keep the piece on the sketch plane. A planar target is overshot
   * by half again so a tilted plane is crossed over the whole profile.
   */
  private static split(startFace: Face, targetFace: Face, sketchPlane: Plane, options: FaceBoundedSweepOptions): Shape[] {
    const isPlanar = FaceQuery.isPlanarFace(targetFace);
    let distance = FaceBoundedSweep.signedDistanceToFace(targetFace, sketchPlane);
    if (isPlanar) {
      distance *= 1.5;
    }

    const extruder = new Extruder([startFace], sketchPlane, distance, options.draft ?? undefined, 0);
    const extrusions = extruder.extrude();
    // The probe's classified faces never reach a caller — only the split
    // pieces do.
    extruder.dispose();

    const cutter = FaceBoundedSweep.growToCover(targetFace, isPlanar, sketchPlane, options.endOffset);
    try {
      return FaceBoundedSweep.keepOnPlane(extrusions, cutter, sketchPlane);
    } finally {
      if (cutter !== targetFace) {
        cutter.dispose();
      }
      for (const extrusion of extrusions) {
        extrusion.dispose();
      }
    }
  }

  /**
   * The target surface as a face large enough to split the whole prism — a
   * plane, cylinder or cone grown to infinity, pulled back by the end offset
   * toward the sketch. Other surface types split with the face as it is.
   */
  private static growToCover(targetFace: Face, isPlanar: boolean, sketchPlane: Plane, endOffset: number | undefined): Face {
    if (isPlanar) {
      return endOffset
        ? FaceQuery.makeInfinitePlanarFace(targetFace, endOffset, sketchPlane.normal.reverse())
        : FaceQuery.makeInfinitePlanarFace(targetFace);
    }
    const surfaceType = FaceQuery.getSurfaceType(targetFace);
    if (surfaceType === 'cylinder') {
      return FaceQuery.makeInfiniteCylindricalFace(targetFace, endOffset);
    }
    if (surfaceType === 'cone') {
      return FaceQuery.makeInfiniteConicalFace(targetFace, endOffset);
    }
    return targetFace;
  }

  /**
   * The signed distance from the sketch plane to the farthest bounding-box
   * corner of the target face, measured along the sketch normal. A target
   * with any extent in front of the plane extrudes along the normal; only a
   * target lying entirely behind the plane extrudes backwards. A target
   * straddling the plane — a cylinder surrounding the sketch, a crossing
   * plane — is reachable both ways, and must not flip direction just because
   * its far wall is deeper behind the sketch than in front.
   */
  private static signedDistanceToFace(targetFace: Face, sketchPlane: Plane): number {
    const bbox = ShapeOps.getBoundingBox(targetFace);
    const corners = [
      new Point(bbox.minX, bbox.minY, bbox.minZ),
      new Point(bbox.maxX, bbox.minY, bbox.minZ),
      new Point(bbox.minX, bbox.maxY, bbox.minZ),
      new Point(bbox.minX, bbox.minY, bbox.maxZ),
      new Point(bbox.maxX, bbox.maxY, bbox.minZ),
      new Point(bbox.maxX, bbox.minY, bbox.maxZ),
      new Point(bbox.minX, bbox.maxY, bbox.maxZ),
      new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
    ];

    let forward = 0;
    let backward = 0;
    for (const corner of corners) {
      const d = sketchPlane.signedDistanceToPoint(corner);
      if (d > forward) {
        forward = d;
      }
      if (d < backward) {
        backward = d;
      }
    }

    return forward > 0 ? forward : backward;
  }

  /**
   * Split each prism with the cutter and keep the piece still standing on
   * the sketch plane, cleaned. The pieces are wrappers of their own, so all
   * of them are freed once the kept one has been cleaned into the result.
   */
  private static keepOnPlane(extrusions: Shape[], cutter: Face, sketchPlane: Plane): Shape[] {
    const result: Shape[] = [];
    for (const shape of extrusions) {
      const pieces = BooleanOps.splitShape(shape, cutter);
      try {
        const keep = pieces.length === 1 ? pieces[0] : FaceBoundedSweep.pieceOnPlane(pieces, sketchPlane);
        if (!keep) {
          throw new Error("Could not find modified shape with source face");
        }
        result.push(ShapeOps.cleanShape(keep));
      } finally {
        for (const piece of pieces) {
          piece.dispose();
        }
      }
    }
    return result;
  }

  /** The split piece with a face lying on the sketch plane — the one the profile still stands on. */
  private static pieceOnPlane(pieces: Shape[], sketchPlane: Plane): Shape | null {
    for (const piece of pieces) {
      const faces = Explorer.findFacesWrapped(piece);
      try {
        if (faces.some(f => FaceOps.faceOnPlaneWrapped(f, sketchPlane))) {
          return piece;
        }
      } finally {
        for (const face of faces) {
          face.dispose();
        }
      }
    }
    return null;
  }
}
