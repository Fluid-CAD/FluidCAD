import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { rad } from "../helpers/math-helpers.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";

/** The dialog values a ghost revolution is built from, all resolved. */
export type RevolveGhostOptions = {
  op: 'add' | 'remove' | 'new';
  /** Sweep angle in degrees; 360 is a full revolution. */
  angle: number;
  /** `.symmetric()` — the sweep splits equally across the sketch plane. */
  symmetric: boolean;
  /** `.thin()` offsets, or null for a solid profile. */
  thin: [number] | [number, number] | null;
  /** The axis to sweep around, already resolved from the dialog's slot. */
  axis: Axis;
};

export type RevolveGhostSolids = {
  /** The bodies to mesh — empty when the profile yields no region. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
};

/**
 * Build the standalone ghost bodies for a revolve: the solid(s) the statement
 * would sweep around its axis, from a profile alone — no scene, no boolean
 * against anything outside this function. For a cut that is the *tool*, the
 * way SolidWorks previews a cut, not the boolean result; a revolved tool is
 * the same body either way, so only the overlay's color changes.
 *
 * The branching mirrors `Revolve.build` (revolve.ts) minus everything
 * scene-bound — face classification, fusion scope, `removeShapes`, the cut
 * itself. `.symmetric()` rotates each body back by half the angle, exactly
 * as the kernel does — with history off there are no faces to remap.
 *
 * The caller owns disposal: every returned shape, `scratch` included, must be
 * `dispose()`d once meshed. None of it is reachable from scene state, so
 * `SceneDisposal` never collects it and leaks compound per keystroke.
 */
export function buildRevolveGhostSolids(
  profile: { getGeometries(): Edge[]; getPlane(): Plane },
  options: RevolveGhostOptions,
): RevolveGhostSolids {
  const scratch: Shape[] = [];
  const solids: Shape[] = [];
  try {
    collectSolids(profile, options, solids, scratch);
    return { solids, scratch };
  } catch (err) {
    // A throw strands everything built so far out of the caller's reach —
    // free it here so a failed ghost costs nothing. One region can revolve
    // before a later one fails, so the solids go too.
    for (const shape of [...solids, ...scratch]) {
      shape.dispose();
    }
    throw err;
  }
}

function collectSolids(
  profile: { getGeometries(): Edge[]; getPlane(): Plane },
  options: RevolveGhostOptions,
  solids: Shape[],
  scratch: Shape[],
): void {
  const plane = profile.getPlane();
  const geometries = profile.getGeometries();
  if (!plane || geometries.length === 0 || !options.angle) {
    return;
  }

  const faces = options.thin
    ? ThinFaceMaker.make(geometries, plane, options.thin[0], options.thin[1]).faces
    : FaceMaker2.getRegions(geometries, plane);
  scratch.push(...faces);
  if (faces.length === 0) {
    return;
  }

  const angle = rad(options.angle);
  const symmetricMatrix = options.symmetric
    ? Matrix4.fromRotationAroundAxis(options.axis.origin, options.axis.direction, -angle / 2)
    : null;
  for (const face of fusedProfileFaces(faces, scratch)) {
    // History off: the ghost wants the body, not the start/end/side-face
    // classification the real revolve builds its selection accessors from.
    let solid = ExtrudeOps.makeRevol(face, options.axis, angle, { history: false }).solid;
    if (symmetricMatrix) {
      scratch.push(solid);
      solid = ShapeOps.transform(solid, symmetricMatrix);
    }
    solids.push(solid);
  }
}

/**
 * The profile faces to sweep, overlapping regions merged the way the kernel
 * merges them (revolve.ts:133) — separate bodies for regions that really are
 * separate, one body where they touch, so no coincident wall z-fights under
 * the ghost's transparency. A lone region needs no boolean: the fuse would
 * hand it straight back.
 */
function fusedProfileFaces(faces: Face[], scratch: Shape[]): Face[] {
  if (faces.length < 2) {
    return faces;
  }
  const fused = BooleanOps.fuseFaces(faces).result as Face[];
  for (const face of fused) {
    if (!faces.includes(face)) {
      scratch.push(face);
    }
  }
  return fused;
}
