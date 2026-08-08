import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { SweepOps } from "../oc/sweep-ops.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";

/** The dialog values a ghost sweep is built from, all resolved. */
export type SweepGhostOptions = {
  op: 'add' | 'remove' | 'new';
  /** `.thin()` offsets, or null for a solid profile. */
  thin: [number] | [number, number] | null;
  /** The spine to run along, already resolved from the dialog's path slot. */
  path: Wire;
};

export type SweepGhostSolids = {
  /** The bodies to mesh — empty when the profile yields no region. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
};

/**
 * Inner closed regions of the profile are holes. The dialog can't say
 * otherwise — `.drill(false)` is API-only, and the edit transform rewrites the
 * statement from op + thin + sources, so it would drop the chain anyway.
 */
const DRILL_HOLES = true;

/**
 * Build the standalone ghost bodies for a sweep: the solid(s) the statement
 * would run along its path, from a profile and a spine alone — no scene, no
 * boolean against anything outside this function. For a cut that is the
 * *tool*, the way SolidWorks previews a cut, not the boolean result; a swept
 * tool is the same body either way, so only the overlay's color changes.
 *
 * The branching mirrors `Sweep.build` (sweep.ts) minus everything scene-bound
 * — face classification, fusion scope, `removeShapes`, the cut itself. Nothing
 * here honors `.extend()`: the dialog has no field for it, and an edit rewrites
 * the statement without it, so a ghost that ran past the path would show
 * geometry the apply can't produce.
 *
 * The caller owns disposal: every returned shape, `scratch` included, must be
 * `dispose()`d once meshed. None of it is reachable from scene state, so
 * `SceneDisposal` never collects it and leaks compound per keystroke.
 */
export function buildSweepGhostSolids(
  profile: { getGeometries(): Edge[]; getPlane(): Plane },
  options: SweepGhostOptions,
): SweepGhostSolids {
  const scratch: Shape[] = [];
  const solids: Shape[] = [];
  try {
    collectSolids(profile, options, solids, scratch);
    return { solids, scratch };
  } catch (err) {
    // A throw strands everything built so far out of the caller's reach —
    // free it here so a failed ghost costs nothing. One region can sweep
    // before a later one fails, so the solids go too.
    for (const shape of [...solids, ...scratch]) {
      shape.dispose();
    }
    throw err;
  }
}

function collectSolids(
  profile: { getGeometries(): Edge[]; getPlane(): Plane },
  options: SweepGhostOptions,
  solids: Shape[],
  scratch: Shape[],
): void {
  const plane = profile.getPlane();
  const geometries = profile.getGeometries();
  if (!plane || geometries.length === 0) {
    return;
  }

  // Thin profiles sweep their offset shell — for a cut too, where the thin
  // faces are the tool's source (sweep.ts:65).
  const faces = options.thin
    ? ThinFaceMaker.make(geometries, plane, options.thin[0], options.thin[1]).faces
    : FaceMaker2.getRegions(geometries, plane, DRILL_HOLES);
  scratch.push(...faces);
  if (faces.length === 0) {
    return;
  }

  // One body per region, as the kernel builds them (sweep-ops.ts:70) — no fuse
  // here, unlike the revolve: separate regions stay separate bodies through
  // the apply too, so the ghost has no coincident walls to merge away.
  solids.push(...SweepOps.makeSweep(options.path, faces).solids);
}
