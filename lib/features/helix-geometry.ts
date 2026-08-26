import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { BuildError } from "../common/build-error.js";
import { HelixOps } from "../oc/helix-ops.js";
import { FaceQuery } from "../oc/face-query.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Convert } from "../oc/convert.js";
import { CoordinateSystem } from "../math/coordinate-system.js";
import { Vector3d } from "../math/vector3d.js";
import { Axis } from "../math/axis.js";

const DEFAULT_RADIUS = 20;
const DEFAULT_HEIGHT = 50;
const DEFAULT_TURNS = 1;
const EPS = 1e-7;
const TANGENCY_BREAK_EPSILON = 1e-6;

/**
 * What a helix is built around, once the source shape has been read: an axis,
 * a cylindrical or conical face's frame, or the frame a line/circle edge
 * defines. Resolving a scene object down to one of these is the only part of
 * the helix that needs the scene — everything past it is pure geometry, which
 * is what lets the live dialog preview ("ghost") build the same curve the
 * statement will.
 */
export type HelixSourceKind =
  | { kind: 'axis'; axis: Axis }
  | { kind: 'cylinder-face'; cs: CoordinateSystem; radius: number; vMin: number; vMax: number }
  | { kind: 'cone-face'; cs: CoordinateSystem; semiAngle: number; refRadius: number; vMin: number; vMax: number }
  | { kind: 'line-edge'; axis: Axis; length: number }
  | { kind: 'circle-edge'; cs: CoordinateSystem; radius: number };

/**
 * The chained helix configurators, all optional — an omitted one falls to the
 * API default, or to whatever the source's own geometry says.
 */
export type HelixDimensions = {
  pitch?: number;
  turns?: number;
  startOffset?: number;
  endOffset?: number;
  height?: number;
  radius?: number;
  endRadius?: number;
  /** Wind counter-clockwise (right-handed) instead of the default clockwise. */
  ccw?: boolean;
};

/**
 * The helical edge a source and a set of dimensions describe.
 *
 * `warn` reports the option combinations a source overrides (a face fixes its
 * own radii): the statement passes `console.warn`, the ghost passes nothing —
 * a preview that re-ran per keystroke would otherwise fill the log with the
 * same line.
 */
export function buildHelixEdge(
  source: HelixSourceKind,
  dimensions: HelixDimensions,
  warn?: (message: string) => void,
): Edge {
  const { pitch, turns: requestedTurns, height, radius, endRadius: requestedEndRadius } = dimensions;
  const startOffset = dimensions.startOffset ?? 0;
  const endOffset = dimensions.endOffset ?? 0;

  let startRadius: number;
  let endRadius: number;
  let cs: CoordinateSystem;
  let zStart: number;
  let zEnd: number;
  let offsetsAlreadyApplied = false;

  switch (source.kind) {
    case 'axis': {
      cs = helixAxisFrame(source.axis);
      startRadius = radius ?? DEFAULT_RADIUS;
      endRadius = requestedEndRadius ?? startRadius;
      zStart = 0;
      zEnd = resolveAxisHeight(height, pitch, requestedTurns);
      break;
    }
    case 'cylinder-face': {
      if (requestedEndRadius !== undefined && requestedEndRadius !== (radius ?? source.radius)) {
        warn?.("helix: .endRadius() is ignored when source is a cylindrical face — for a tapered helix, use a conical face or axis input.");
      }
      cs = source.cs;
      // Nudge inward by TANGENCY_BREAK_EPSILON when falling back to the
      // face's natural radius. A helix exactly on the cylinder's surface
      // produces a swept tube that's tangent to the cylinder along helical
      // curves, and OCC's BOPAlgo (BRepAlgoAPI_Fuse/Cut) silently fails on
      // tangent contact along curves — fuse returns the inputs as a
      // compound, cut is a no-op. The 1e-6mm nudge is sub-nanometer
      // (visually identical) but produces transversal intersections that
      // BOPAlgo handles cleanly. Sweep also passes skipSimplify=true to
      // avoid SimplifyResult/UnifySameDomain hanging on the resulting
      // tangent-curve topology.
      startRadius = radius ?? (source.radius - TANGENCY_BREAK_EPSILON);
      endRadius = startRadius;
      if (height !== undefined) {
        zStart = 0;
        zEnd = height;
      } else {
        zStart = source.vMin;
        zEnd = source.vMax;
      }
      break;
    }
    case 'cone-face': {
      if (radius !== undefined || requestedEndRadius !== undefined) {
        warn?.("helix: .radius()/.endRadius() are ignored when source is a conical face — radii are derived from the face geometry.");
      }
      cs = source.cs;
      const cosA = Math.cos(source.semiAngle);
      const sinA = Math.sin(source.semiAngle);
      const zMinFace = source.vMin * cosA;
      const zMaxFace = source.vMax * cosA;
      const zLow = Math.min(zMinFace, zMaxFace);
      const zHigh = Math.max(zMinFace, zMaxFace);
      if (height !== undefined) {
        zStart = zLow;
        zEnd = zLow + height;
      } else {
        zStart = zLow;
        zEnd = zHigh;
      }
      // Apply offsets here so the radii follow the cone's surface at the
      // extended positions (offsets extend along the cone's natural taper,
      // not as a cylindrical extension).
      zStart += startOffset;
      zEnd += endOffset;
      startRadius = source.refRadius + (zStart / cosA) * sinA;
      endRadius = source.refRadius + (zEnd / cosA) * sinA;
      offsetsAlreadyApplied = true;
      break;
    }
    case 'line-edge': {
      cs = helixAxisFrame(source.axis);
      startRadius = radius ?? DEFAULT_RADIUS;
      endRadius = requestedEndRadius ?? startRadius;
      zStart = 0;
      zEnd = height ?? source.length;
      break;
    }
    case 'circle-edge': {
      if (requestedEndRadius !== undefined) {
        warn?.("helix: .endRadius() is ignored when source is a circular edge — both radii equal the circle radius.");
      }
      cs = source.cs;
      startRadius = radius ?? source.radius;
      endRadius = startRadius;
      zStart = 0;
      zEnd = height ?? DEFAULT_HEIGHT;
      break;
    }
  }

  if (!offsetsAlreadyApplied) {
    zStart += startOffset;
    zEnd += endOffset;
  }

  if (pitch !== undefined && Math.abs(pitch) < EPS) {
    throw new BuildError(`helix: .pitch() must be non-zero.`);
  }
  if (requestedTurns !== undefined && requestedTurns <= 0) {
    throw new BuildError(
      `helix: .turns() must be > 0, got ${requestedTurns}.`,
      `Pass a positive number to .turns().`,
    );
  }

  const turns = requestedTurns ?? deriveTurnsFromHeight(zEnd - zStart, pitch);

  if (!Number.isFinite(turns) || turns <= 0) {
    throw new BuildError(
      `helix: turns must be > 0, got ${turns}.`,
      `Pass a positive number to .turns() or .pitch().`,
    );
  }

  if (Math.abs(zEnd - zStart) < EPS) {
    throw new BuildError(
      `helix: resulting axial height is zero (zStart=${zStart}, zEnd=${zEnd}).`,
      `Check .startOffset()/.endOffset()/.height() values.`,
    );
  }

  if (startRadius <= 0) {
    throw new BuildError(`helix: start radius must be > 0, got ${startRadius}.`);
  }
  if (endRadius <= 0) {
    throw new BuildError(
      `helix: end radius would be ≤ 0 (got ${endRadius}). For a conical helix, the end radius must stay positive.`,
      `Reduce .endOffset() or use a smaller turns/height combination.`,
    );
  }

  return HelixOps.makeHelix(cs, startRadius, endRadius, zStart, zEnd, turns, dimensions.ccw ?? false);
}

/** A cylindrical or conical face, read as the frame a helix coils around. */
export function resolveHelixFaceSource(face: Face): HelixSourceKind {
  const surfaceType = FaceQuery.getSurfaceType(face);

  if (surfaceType === 'cylinder') {
    const cylinder = FaceQuery.getSurfaceAdaptorCylinderRaw(face.getShape());
    const ax3 = cylinder.Position();
    const cs = Convert.toCoordinateSystemFromGpAx3(ax3, true);
    const radius = cylinder.Radius();
    cylinder.delete();
    const { vMin, vMax } = FaceQuery.getSurfaceVBoundsRaw(face.getShape());
    const canon = canonicalizeAxialBounds(cs, vMin, vMax);
    return { kind: 'cylinder-face', cs: canon.cs, radius, vMin: canon.vMin, vMax: canon.vMax };
  }

  if (surfaceType === 'cone') {
    const cone = FaceQuery.getSurfaceAdaptorConeRaw(face.getShape());
    const ax3 = cone.Position();
    const cs = Convert.toCoordinateSystemFromGpAx3(ax3, true);
    const semiAngle = cone.SemiAngle();
    const refRadius = cone.RefRadius();
    cone.delete();
    const { vMin, vMax } = FaceQuery.getSurfaceVBoundsRaw(face.getShape());
    // For a cone, the V-axis lies along the slant; canonicalizing the
    // CS direction here doesn't simplify the math the same way it does for
    // a cylinder, so leave the cone's frame alone.
    return { kind: 'cone-face', cs, semiAngle, refRadius, vMin, vMax };
  }

  throw new BuildError(
    `helix: face must be cylindrical or conical (got '${surfaceType}').`,
  );
}

/** A line or circular edge, read as the frame a helix coils around. */
export function resolveHelixEdgeSource(edge: Edge): HelixSourceKind {
  const curveType = EdgeQuery.getEdgeCurveType(edge);

  if (curveType === 'line') {
    const axis = EdgeOps.edgeToAxis(edge);
    const params = EdgeQuery.getEdgeCurveParams(edge);
    const length = Math.abs(params.last - params.first);
    return { kind: 'line-edge', axis, length };
  }

  if (curveType === 'circle') {
    const data = EdgeQuery.getCircleDataFromEdge(edge);
    const axis = new Axis(data.center, data.axisDirection);
    return { kind: 'circle-edge', cs: helixAxisFrame(axis), radius: data.radius };
  }

  throw new BuildError(
    `helix: edge must be a line or circle (got '${curveType}').`,
  );
}

/** The frame a helix coils in around a bare axis — any perpendicular X will do. */
export function helixAxisFrame(axis: Axis): CoordinateSystem {
  const dir = axis.direction.normalize();
  const seed = Math.abs(dir.z) < 0.9 ? Vector3d.unitZ() : Vector3d.unitX();
  const xDir = seed.cross(dir).normalize();
  return new CoordinateSystem(axis.origin, dir, xDir);
}

function resolveAxisHeight(
  height: number | undefined,
  pitch: number | undefined,
  turns: number | undefined,
): number {
  if (height !== undefined) {
    return height;
  }
  if (pitch !== undefined && turns !== undefined) {
    return Math.abs(pitch * turns);
  }
  if (pitch !== undefined) {
    return Math.abs(pitch * DEFAULT_TURNS);
  }
  return DEFAULT_HEIGHT;
}

function deriveTurnsFromHeight(height: number, pitch: number | undefined): number {
  if (pitch === undefined) {
    return DEFAULT_TURNS;
  }
  if (Math.abs(pitch) < EPS) {
    throw new BuildError(`helix: .pitch() must be non-zero.`);
  }
  return Math.abs(height / pitch);
}

/**
 * A cylindrical face's `Position()` Ax3 may have its main direction pointing
 * "into" the face's V-extent rather than "out of it" (e.g. an extruded cylinder
 * built from a sketch on z=0 yields mainDir = (0,0,-1) with V-bounds [-50, 0]).
 * Pass through unchanged when V naturally extends in the +mainDir direction;
 * otherwise flip mainDir and negate V-bounds so that V grows along the body's
 * axial extent. This keeps `.startOffset()`/`.endOffset()` semantics intuitive
 * (positive end-offset extends past the cylinder's "top").
 */
function canonicalizeAxialBounds(
  cs: CoordinateSystem,
  vMin: number,
  vMax: number,
): { cs: CoordinateSystem; vMin: number; vMax: number } {
  if (Math.abs(vMin) <= Math.abs(vMax)) {
    return { cs, vMin, vMax };
  }
  const flipped = new CoordinateSystem(
    cs.origin,
    cs.mainDirection.negate(),
    cs.xDirection,
  );
  return { cs: flipped, vMin: -vMax, vMax: -vMin };
}
