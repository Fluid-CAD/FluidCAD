import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { LoftEndCondition, LoftOps, LoftOptions } from "../oc/loft-ops.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";

/**
 * One resolved profile of a ghost loft — the two things a dialog chip can be:
 * a sketch (its edges and plane) or faces picked in the viewport. The caller
 * owns the faces it passes in; every wire read off them here belongs to the
 * returned `scratch`.
 */
export type LoftGhostProfile =
  | { kind: 'sketch'; geometries: Edge[]; plane: Plane }
  | { kind: 'faces'; faces: Face[] };

/** The dialog values a ghost loft is built from, all resolved to numbers. */
export type LoftGhostOptions = {
  op: 'add' | 'remove' | 'new';
  /** `.thin()` offsets, or null for solid sections. */
  thin: [number] | [number, number] | null;
  /** Side rails the surface must follow, already resolved to wires (max two). */
  guides: Wire[];
  /** How the surface leaves the first profile, or null for unconstrained. */
  startCondition: LoftEndCondition | null;
  /** How the surface arrives at the last profile, or null. */
  endCondition: LoftEndCondition | null;
};

export type LoftGhostSolids = {
  /** The bodies to mesh — empty when the profiles yield nothing to loft. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
};

/**
 * Build the standalone ghost bodies for a loft: the solid the statement would
 * skin through its sections, from the profiles alone — no scene, no boolean
 * against anything outside this function. For a cut that is the *tool*, the
 * way SolidWorks previews a cut, not the boolean result; a lofted tool is the
 * same body either way, so only the overlay's color changes.
 *
 * The branching mirrors `Loft.build` (loft.ts) minus everything scene-bound —
 * face classification, fusion scope, `removeShapes`, the cut itself. Where the
 * kernel throws on a combination it can't build (fewer than two profiles, a
 * multi-region section under rails, guides plus thin walls), the ghost simply
 * shows nothing: mid-composition the dialog passes through all of them, and a
 * refusal per keystroke would be noise.
 *
 * The caller owns disposal: every returned shape, `scratch` included, must be
 * `dispose()`d once meshed. None of it is reachable from scene state, so
 * `SceneDisposal` never collects it and leaks compound per keystroke.
 */
export function buildLoftGhostSolids(
  profiles: LoftGhostProfile[],
  options: LoftGhostOptions,
): LoftGhostSolids {
  const scratch: Shape[] = [];
  const solids: Shape[] = [];
  try {
    collectSolids(profiles, options, solids, scratch);
    return { solids, scratch };
  } catch (err) {
    // A throw strands everything built so far out of the caller's reach —
    // free it here so a failed ghost costs nothing.
    for (const shape of [...solids, ...scratch]) {
      shape.dispose();
    }
    throw err;
  }
}

function collectSolids(
  profiles: LoftGhostProfile[],
  options: LoftGhostOptions,
  solids: Shape[],
  scratch: Shape[],
): void {
  // A loft needs two sections, and OCC's rails come in ones and twos
  // (loft.ts:103, :112) — the dialog reaches both states while composing.
  if (profiles.length < 2 || options.guides.length > 2) {
    return;
  }
  const loftOptions = resolveLoftOptions(options);

  if (options.thin) {
    if (options.guides.length > 0) {
      return;
    }
    collectThinSolids(profiles, options.thin, loftOptions, solids, scratch);
    return;
  }

  const wires: Wire[] = [];
  for (const profile of profiles) {
    const sections = sectionWires(profile, scratch);
    if (sections.length === 0) {
      return;
    }
    // Rails and end conditions run the in-house skin, which carries exactly
    // one section per profile (loft.ts:131).
    if (loftOptions && sections.length !== 1) {
      return;
    }
    wires.push(...sections);
  }
  solids.push(...LoftOps.makeLoft(wires, loftOptions));
}

/** Undefined for a plain loft, keeping it on OCC's ThruSections path. */
function resolveLoftOptions(options: LoftGhostOptions): LoftOptions | undefined {
  if (options.guides.length === 0 && !options.startCondition && !options.endCondition) {
    return undefined;
  }
  return {
    startCondition: options.startCondition ?? undefined,
    endCondition: options.endCondition ?? undefined,
    guides: options.guides.length > 0 ? options.guides : undefined,
  };
}

/**
 * The sections one profile contributes: the outer wire of each of its regions,
 * mirroring `Loft.getWiresFromSceneObject` — a sketch is split into regions
 * first, a picked face already is one.
 */
function sectionWires(profile: LoftGhostProfile, scratch: Shape[]): Wire[] {
  if (profile.kind === 'faces') {
    return outerWires(profile.faces, scratch);
  }
  if (!profile.plane || profile.geometries.length === 0) {
    return [];
  }
  const faces = FaceMaker2.getRegions(profile.geometries, profile.plane);
  scratch.push(...faces);
  return outerWires(faces, scratch);
}

/** Each face's outer wire; the inner ones are holes, which a loft ignores. */
function outerWires(faces: Face[], scratch: Shape[]): Wire[] {
  const wires: Wire[] = [];
  for (const face of faces) {
    // Fresh wrappers cached on the face — the caller frees them with the rest.
    const faceWires = face.getWires();
    scratch.push(...faceWires);
    if (faceWires.length > 0) {
      wires.push(faceWires[0]);
    }
  }
  return wires;
}

/**
 * The thin-walled loft, mirroring `Loft.buildThinLoft`: every profile is
 * offset into a ring, and the rings skin into outer and inner walls. With end
 * conditions both walls come from the in-house skin and assemble directly;
 * without them the inner solid is cut out of the outer one.
 *
 * Only sketches offset — a picked face has no edges to run `ThinFaceMaker`
 * over, which is exactly the "Thin loft requires all profiles to be sketches"
 * refusal the apply would raise.
 */
function collectThinSolids(
  profiles: LoftGhostProfile[],
  thin: [number] | [number, number],
  loftOptions: LoftOptions | undefined,
  solids: Shape[],
  scratch: Shape[],
): void {
  const outer: Wire[] = [];
  const inner: Wire[] = [];
  for (const profile of profiles) {
    if (profile.kind !== 'sketch' || !profile.plane || profile.geometries.length === 0) {
      return;
    }
    const ring = ThinFaceMaker.make(profile.geometries, profile.plane, thin[0], thin[1]);
    scratch.push(...ring.faces);
    for (const face of ring.faces) {
      const wires = face.getWires();
      scratch.push(...wires);
      if (wires.length === 0) {
        continue;
      }
      outer.push(wires[0]);
      if (wires.length > 1) {
        inner.push(wires[1]);
      }
    }
  }
  if (outer.length === 0) {
    return;
  }

  const walled = inner.length > 0 && inner.length === outer.length;
  if (loftOptions && walled) {
    solids.push(...LoftOps.makeThinLoft(outer, inner, loftOptions));
    return;
  }

  const outerSolids = LoftOps.makeLoft(outer, loftOptions);
  if (!walled) {
    // An open profile offsets into a single band — its skin is the body.
    solids.push(...outerSolids);
    return;
  }
  scratch.push(...outerSolids);
  const innerSolids = LoftOps.makeLoft(inner, loftOptions);
  scratch.push(...innerSolids);

  const outerFuse = BooleanOps.fuse(outerSolids);
  const innerFuse = BooleanOps.fuse(innerSolids);
  scratch.push(...outerFuse.result, ...innerFuse.result);
  outerFuse.dispose();
  innerFuse.dispose();
  if (outerFuse.result.length === 0 || innerFuse.result.length === 0) {
    return;
  }
  solids.push(BooleanOps.cutShapes(outerFuse.result[0], innerFuse.result[0]));
}
