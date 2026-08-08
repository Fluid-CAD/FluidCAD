import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { Vector3d } from "../math/vector3d.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { RibOps } from "../oc/rib-ops.js";
import { WireOps } from "../oc/wire-ops.js";

/** The dialog values a ghost rib is built from, all resolved to numbers. */
export type RibGhostOptions = {
  /** Wall thickness; the sign picks the side of the sketch plane. Nonzero. */
  thickness: number;
  /** Extrude in-plane, perpendicular to the spine. */
  parallel: boolean;
  /** Push the spine endpoints out into the surrounding walls. */
  extend: boolean;
  /** Draft angle in degrees, or null for straight walls. */
  draft: number | null;
};

export type RibGhostSolids = {
  /** The bodies to mesh — empty when the spine yields nothing in the cavity. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
};

/**
 * Build the standalone ghost bodies for a rib: the conformed wall the
 * statement would build, from the spine and the scope solids alone — no
 * fusion, no scene mutation. The branching mirrors `Rib.build` (rib.ts):
 * extend, profile, prism, conform. Unlike the other swept ghosts a rib is
 * inherently scene-bound — its extrude distance and its trim both come from
 * the scope solids — so the caller resolves and passes them in.
 *
 * One knowing approximation: normal-mode draft is skipped. The kernel drafts
 * the conformed rib via face classification and OCC's draft maker (rib.ts's
 * post-conform pass), which is too heavy to re-run per keystroke; the ghost
 * shows the undrafted wall — honest about position and reach, approximate
 * about the taper. Parallel-mode draft IS exact: it rides the same tapered
 * prism the kernel builds.
 *
 * The caller owns disposal: every returned shape, `scratch` included, must be
 * `dispose()`d once meshed. None of it is reachable from scene state, so
 * `SceneDisposal` never collects it.
 */
export function buildRibGhostSolids(
  spine: { getGeometries(): Edge[]; getPlane(): Plane },
  scopeShapes: Shape[],
  options: RibGhostOptions,
): RibGhostSolids {
  const scratch: Shape[] = [];
  try {
    return { solids: buildSolids(spine, scopeShapes, options, scratch), scratch };
  } catch (err) {
    // A throw strands the scratch out of the caller's reach — free it here so
    // a failed ghost costs nothing.
    for (const shape of scratch) {
      shape.dispose();
    }
    throw err;
  }
}

function buildSolids(
  spine: { getGeometries(): Edge[]; getPlane(): Plane },
  scopeShapes: Shape[],
  options: RibGhostOptions,
  scratch: Shape[],
): Shape[] {
  const plane = spine.getPlane();
  const geometries = spine.getGeometries();
  if (!plane || geometries.length === 0 || scopeShapes.length === 0 || options.thickness === 0) {
    return [];
  }

  const originalSpineWire = WireOps.makeWireFromEdges(geometries);
  scratch.push(originalSpineWire);
  let spineWire = originalSpineWire;
  if (options.extend) {
    spineWire = RibOps.extendSpineWire(spineWire, scopeShapes, plane);
    scratch.push(spineWire);
  }

  // Sign convention mirrors Rib.build: thickness > 0 extrudes opposite the
  // sketch normal. The ghost never renders inside a mirror clone, so the
  // pseudovector flip the kernel applies there does not arise.
  const dirSign = -Math.sign(options.thickness);
  let direction: Vector3d;
  let distance: number;
  if (options.parallel) {
    const perpDir = RibOps.computeSpinePerpendicularDirection(spineWire, plane);
    direction = perpDir.multiply(dirSign);
    distance = RibOps.computeExtrudeDistanceAlongDirection(direction, plane.origin, scopeShapes);
  } else {
    direction = plane.normal.multiply(dirSign);
    distance = RibOps.computeExtrudeDistance(plane, scopeShapes);
  }
  if (distance === 0) {
    return [];
  }

  const useTaperedLoft = options.parallel && options.draft !== null;
  let solid: Shape;
  let firstFace: Shape;
  let lastFace: Shape;
  if (useTaperedLoft) {
    const angleRad = (options.draft! * Math.PI) / 180;
    ({ solid, firstFace, lastFace } = RibOps.makeTaperedRibPrism(
      spineWire, options.thickness, plane, direction, distance, angleRad,
    ));
  } else {
    const profileFace = options.parallel
      ? RibOps.makeRibProfileParallel(spineWire, options.thickness, plane)
      : RibOps.makeRibProfile(spineWire, options.thickness, plane);
    scratch.push(profileFace);
    ({ solid, firstFace, lastFace } = ExtrudeOps.makePrismFromVec(
      profileFace, direction.multiply(distance),
    ));
  }
  scratch.push(solid, firstFace, lastFace);

  const conformed = RibOps.conformRibToScope(
    solid, scopeShapes, originalSpineWire, firstFace, lastFace, direction,
  );
  scratch.push(
    ...conformed.startFaces, ...conformed.endFaces,
    ...conformed.sideFaces, ...conformed.internalFaces,
  );
  return conformed.solids;
}
