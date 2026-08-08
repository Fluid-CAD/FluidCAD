import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Plane, PlaneTransformOptions } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { FaceOps } from "../oc/face-ops.js";
import { sampleEdgeFrame } from "./plane-from-object.js";

/**
 * One resolved base of the offset and mid forms: the plane it contributes,
 * and the point its quad is drawn around — a face base centers on the face, an
 * origin plane on the world origin, an existing plane feature on whatever it
 * already centers on.
 */
export type PlaneGhostBase = { plane: Plane; center?: Point };

/**
 * What the dialog's three forms build from, already resolved against the
 * scene: the kernel never reads a source location or a pick here, exactly as
 * the revolve ghost takes an `Axis` rather than its slot.
 */
export type PlaneGhostSource =
  | { form: 'offset'; base: PlaneGhostBase }
  | { form: 'mid'; bases: [PlaneGhostBase, PlaneGhostBase] }
  /** The edge form: a curve, and the normalized 0–1 position along it. */
  | { form: 'edge'; edge: Edge; position: number };

export type PlaneGhostQuad = {
  /** The quad to mesh — the very face a rendered `plane()` puts in the scene. */
  face: Face;
  /** The plane's own frame; the overlay draws its normal arrow from these. */
  normal: Vector3d;
  center: Point;
};

/**
 * Build the ghost quad for a construction plane: the face the statement would
 * put in the scene, from resolved bases alone — no scene lookups, no code.
 *
 * Each form mirrors its own feature exactly, because a plane's whole content
 * is *where it lands*: the offset form follows `PlaneFromObject.build`
 * (offset and rotations composed into one matrix that moves the quad's center
 * with the plane), the mid form `PlaneMiddleRenderable.build` (the midpoint of
 * the two origins, wearing the first base's frame), and the edge form
 * `PlaneFromObject.buildFromEdge` (the tangent at the sampled position, flipped
 * at the start so the plane faces outward). A ghost that derived any of them
 * its own way would preview a plane the apply doesn't build.
 *
 * The caller owns disposal: the returned face must be `dispose()`d once
 * meshed. It is not reachable from scene state, so `SceneDisposal` never
 * collects it and it would leak per keystroke.
 */
export function buildPlaneGhostQuad(
  source: PlaneGhostSource,
  options: PlaneTransformOptions,
): PlaneGhostQuad {
  const frame = source.form === 'edge'
    ? edgeFrame(source.edge, source.position)
    : source.form === 'mid'
      ? midFrame(source.bases, options)
      : offsetFrame(source.base, options);
  const face = FaceOps.planeToFace(frame.plane, frame.center);
  face.markAsMetaShape();
  return { face, normal: frame.plane.normal, center: frame.center };
}

/** A plane and the point its quad centers on. */
type PlaneFrame = { plane: Plane; center: Point };

/**
 * The offset form: the base's own plane, moved by the dialog's offset and
 * rotations. The center rides the same matrix, so the quad stays on the plane
 * instead of floating at its pre-transform position
 * (plane-from-object.ts:66-75).
 */
function offsetFrame(base: PlaneGhostBase, options: PlaneTransformOptions): PlaneFrame {
  const matrix = base.plane.getTransformMatrix(options);
  const plane = base.plane.applyMatrix(matrix);
  const center = base.center ? base.center.transform(matrix) : plane.origin;
  return { plane, center };
}

/**
 * The mid form: halfway between the two origins, wearing the first base's
 * frame. It keeps no center of its own — the quad sits on the midpoint, which
 * is what `PlaneMiddleRenderable` renders.
 */
function midFrame(
  bases: [PlaneGhostBase, PlaneGhostBase],
  options: PlaneTransformOptions,
): PlaneFrame {
  const [first, second] = bases;
  const midpoint = first.plane.origin.add(second.plane.origin).multiplyScalar(0.5);
  const plane = new Plane(midpoint, first.plane.xDirection, first.plane.normal)
    .transform(options);
  return { plane, center: plane.origin };
}

/**
 * The edge form: the plane normal to the curve at `position`, centered on the
 * sampled point. The forward tangent points *into* the edge at the start, so
 * it is flipped there — the plane faces outward at both ends, like an
 * extrude's start cap. The dialog writes no offset or rotation for this form
 * (the second argument slot is the position), so none is applied.
 */
function edgeFrame(edge: Edge, position: number): PlaneFrame {
  const frame = sampleEdgeFrame(edge, position);
  const normal = position <= 0 ? frame.tangent.negate() : frame.tangent;
  return { plane: Plane.fromPointAndNormal(frame.point, normal), center: frame.point };
}
