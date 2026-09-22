import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { LoftEndCondition, LoftOps, LoftOptions, ThinLoftWalls } from "../oc/loft-ops.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";
import { Point } from "../math/point.js";
import { Solid } from "../common/solid.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { FaceOps } from "../oc/face-ops.js";
import { Mesh, MeshConfig } from "../oc/mesh.js";
import { getOC } from "../oc/init.js";

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
  /** One resolved world-space vertex per profile for each connection. */
  connections?: Point[][];
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
  // A loft needs two sections, and rails come in ones and twos
  // (loft.ts:131) — the dialog reaches both states while composing.
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
    // The skin carries exactly one section per profile (loft.ts:164).
    if (sections.length !== 1) {
      if (options.connections?.length) {
        throw new Error("Loft connections require exactly one region per profile.");
      }
      return;
    }
    wires.push(sections[0]);
  }
  solids.push(...LoftOps.makeLoft(wires, loftOptions));
}

/** Undefined for a plain loft. */
function resolveLoftOptions(options: LoftGhostOptions): LoftOptions | undefined {
  if (options.guides.length === 0 && !options.startCondition && !options.endCondition && !options.connections?.length) {
    return undefined;
  }
  return {
    startCondition: options.startCondition ?? undefined,
    endCondition: options.endCondition ?? undefined,
    guides: options.guides.length > 0 ? options.guides : undefined,
    connections: options.connections,
  };
}

/**
 * The actual matching of a loft: edges on neither end plane, including the
 * seam of a smooth closed side face (normally hidden by the solid renderer).
 * Each returned polyline is packed xyz coordinates, ready for an overlay.
 */
export function loftMatchLines(
  solid: Solid,
  first: LoftGhostProfile,
  last: LoftGhostProfile,
  meshConfig?: MeshConfig,
): number[][] {
  const planeOf = (profile: LoftGhostProfile) => profile.kind === 'sketch'
    ? profile.plane : profile.faces.length ? FaceOps.tryGetPlane(profile.faces[0]) : null;
  const firstPlane = planeOf(first);
  const lastPlane = planeOf(last);
  if (!firstPlane || !lastPlane) {
    return [];
  }

  const oc = getOC();
  Mesh.ensureTriangulated(solid.getShape(), meshConfig);
  const parents = solid.getEdgeToFacesIndex();
  const lines: number[][] = [];
  for (const shape of solid.getIndexedShapes('edge')) {
    const edge = shape as Edge;
    if (oc.BRep_Tool.Degenerated(edge.getShape())
      || EdgeQuery.isEdgeOnPlane(edge, firstPlane)
      || EdgeQuery.isEdgeOnPlane(edge, lastPlane)) {
      continue;
    }
    const faces = parents.Seek(edge.getShape());
    if (!faces || faces.IsEmpty()) {
      continue;
    }
    const face = oc.TopoDS.Face(faces.First());
    try {
      const mesh = Mesh.discretizeEdgeOnFace(edge.getShape(), face);
      if (mesh?.vertices.length) {
        lines.push(mesh.vertices);
      }
    } finally {
      face.delete();
    }
  }
  return lines;
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
 * offset into a ring, and the rings skin into outer and inner walls that
 * assemble directly with ring caps.
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
  const walls: ThinLoftWalls[] = [];
  for (const [k, profile] of profiles.entries()) {
    if (profile.kind !== 'sketch' || !profile.plane || profile.geometries.length === 0) {
      return;
    }
    const ring = ThinFaceMaker.make(profile.geometries, profile.plane, thin[0], thin[1]);
    scratch.push(...ring.faces, ...ring.walls.map(wall => wall.source));
    for (const [f, face] of ring.faces.entries()) {
      const wires = face.getWires();
      scratch.push(...wires);
      if (wires.length === 0) {
        continue;
      }
      const { source, outerDistance, innerDistance } = ring.walls[f];
      outer.push(wires[0]);
      if (wires.length > 1 && innerDistance !== null) {
        inner.push(wires[1]);
        walls.push({ outer: wires[0], inner: wires[1], source, outerDistance, innerDistance });
      } else if (loftOptions?.connections?.length) {
        throw new Error(`Loft connections with thin walls require closed profiles; profile ${k + 1} is open.`);
      }
    }
  }
  if (outer.length === 0) {
    return;
  }

  if (walls.length > 0 && walls.length === outer.length) {
    solids.push(...LoftOps.makeThinLoft(walls, loftOptions));
    return;
  }
  // An open profile offsets into a single band — its skin is the body.
  solids.push(...LoftOps.makeLoft(outer, loftOptions));
}
