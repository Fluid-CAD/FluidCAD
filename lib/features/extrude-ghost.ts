import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";
import { FaceBoundedSweep } from "./face-bounded-sweep.js";
import { Extruder } from "./simple-extruder.js";

/**
 * Where an up-to-face ghost ends: the face the dialog picked, or the
 * `'first-face'` / `'last-face'` literal with every face the extrusion could
 * run into. The faces are the caller's — resolved from the scene and freed
 * with its scratch; the ghost only reads them.
 */
export type ExtrudeGhostTarget =
  | { kind: 'face'; face: Face }
  | { kind: 'first-face' | 'last-face'; candidates: Face[] };

/** The dialog values a ghost extrusion is built from, all resolved to numbers. */
export type ExtrudeGhostOptions = {
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null is a through-all cut (`remove` only). */
  distance: number | null;
  /** Second, opposite-direction distance — `extrude(d1, d2)`; excludes symmetric. */
  distance2: number | null;
  /** The distance splits equally across the sketch plane. */
  symmetric: boolean;
  /** Draft angle in degrees, or null for straight walls. */
  draft: number | null;
  /** `.endOffset()` — pulls each swept end back by this much; null for none. */
  endOffset: number | null;
  /** Treat inner closed regions of the profile as holes. */
  drill: boolean;
  /** `.thin()` offsets, or null for a solid profile. */
  thin: [number] | [number, number] | null;
  /** Ghost length for a through-all cut; the caller derives it from scene bounds. */
  throughAllLength: number;
  /**
   * Up-to-face: the extrusion ends on this target instead of at a distance —
   * `distance`, `distance2` and `symmetric` are not read. The ghost sweeps
   * exactly what `ExtrudeToFace` would, through the same `FaceBoundedSweep`.
   */
  toFace?: ExtrudeGhostTarget;
  /**
   * The picked `.region()` faces, already resolved from the profile's
   * regions — built in place of the profile's own regions. Ignored by a thin
   * extrude, which offsets the whole profile (the kernel's own rule). Owned
   * by the caller, who disposes them with the scratch.
   */
  faces?: Face[];
};

export type ExtrudeGhostSolids = {
  /** The bodies to mesh — empty when the profile yields no region. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
  /**
   * Why an up-to-face target left nothing to sweep: a first/last-face
   * extrusion that runs into no face at all. Unlike an empty profile, this
   * is worth saying in the dialog — the apply would fail the same way.
   */
  refusal?: string;
};

/** The stretch of the sketch-plane normal the ghost body occupies. */
type GhostSpan = { from: number; to: number };

/**
 * Build the standalone ghost bodies for an extrude: the prism(s) the
 * statement would sweep, from a profile alone — no scene, no boolean against
 * anything outside this function. For a cut that is the *tool*, the way
 * SolidWorks previews a cut, not the boolean result.
 *
 * The branching mirrors `Extrude.build` (extrude.ts) so the ghost shows the
 * shape the apply will produce; everything scene-bound is left out — fusion
 * scope, face/edge classification, `removeShapes`, the cut itself.
 *
 * The caller owns disposal: every returned shape, `scratch` included, must be
 * `dispose()`d once meshed. None of it is reachable from scene state, so
 * `SceneDisposal` never collects it and leaks compound per keystroke.
 */
export function buildExtrudeGhostSolids(
  profile: { getGeometries(): Edge[]; getPlane(): Plane },
  options: ExtrudeGhostOptions,
): ExtrudeGhostSolids {
  const scratch: Shape[] = [];
  try {
    const built = buildSolids(profile, options, scratch);
    return 'refusal' in built ? { solids: [], scratch, refusal: built.refusal } : { solids: built, scratch };
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
  profile: { getGeometries(): Edge[]; getPlane(): Plane },
  options: ExtrudeGhostOptions,
  scratch: Shape[],
): Shape[] | { refusal: string } {
  const plane = profile.getPlane();
  const geometries = profile.getGeometries();
  if (!plane || geometries.length === 0) {
    return [];
  }
  // A face-bounded sweep has no span of its own; the distance modes refuse
  // early, before any profile face is built, when theirs is empty.
  const span = options.toFace ? null : ghostSpan(options);
  if (!options.toFace && !span) {
    return [];
  }

  const faces = profileFaces(geometries, plane, options, scratch);
  if (faces.length === 0) {
    return [];
  }

  const draft = options.draft ? [options.draft, options.draft] as [number, number] : null;

  if (options.toFace) {
    return sweepToFace(faces, plane, options.toFace, draft, options.endOffset, scratch);
  }

  // A span straddling the sketch plane is two sweeps in the kernel. Drafted,
  // it has to stay that way — the taper widens outward from the plane in each
  // direction, which one long prism can't reproduce. Undrafted, the halves are
  // geometrically one prism, so sweep the profile once from the near end
  // instead: no fuse, and no coincident faces to z-fight under transparency.
  if (span.from !== 0) {
    if (draft) {
      return fusedHalves(faces, plane, span, draft, scratch);
    }
    return spanPrism(faces, plane, span, scratch);
  }

  return extrudeInto(new Extruder(faces, plane, span.to, draft), scratch);
}

/**
 * The extruder's bodies, with the cap and side faces it classifies parked in
 * `scratch`: the real extrude records them as its selection accessors, the
 * ghost has no use for them, and nothing else frees them.
 */
function extrudeInto(extruder: Extruder, scratch: Shape[]): Shape[] {
  const solids = extruder.extrude();
  parkClassifiedFaces(extruder, scratch);
  return solids;
}

function parkClassifiedFaces(extruder: Extruder, scratch: Shape[]): void {
  scratch.push(
    ...extruder.getStartFaces(), ...extruder.getEndFaces(),
    ...extruder.getSideFaces(), ...extruder.getInternalFaces(),
  );
}

/**
 * The up-to-face form: every profile face swept to the one target, exactly
 * as `ExtrudeToFace.build` sweeps it — a cut's tool runs to the face the
 * same way, so the op plays no part. A first/last-face literal resolves
 * against the candidate faces first, by the kernel's own reach test; when
 * nothing lies ahead there is no body to show and the dialog is told why.
 */
function sweepToFace(
  faces: Face[],
  plane: Plane,
  target: ExtrudeGhostTarget,
  draft: [number, number] | null,
  endOffset: number | null,
  scratch: Shape[],
): Shape[] | { refusal: string } {
  const targetFace = target.kind === 'face'
    ? target.face
    : FaceBoundedSweep.pickReached(target.candidates, plane, target.kind === 'first-face' ? 'first' : 'last', faces, draft);
  if (!targetFace) {
    return { refusal: `No face lies ahead of the sketch for an up-to-${target.kind === 'first-face' ? 'first' : 'last'}-face extrude.` };
  }
  const options = { draft, endOffset: endOffset ?? undefined };
  const solids: Shape[] = [];
  try {
    for (const face of faces) {
      const swept = FaceBoundedSweep.sweep(face, targetFace, plane, options);
      solids.push(...swept.solids);
      if (swept.extruder) {
        parkClassifiedFaces(swept.extruder, scratch);
      }
    }
  } catch (err) {
    // A later face's sweep failing strands the earlier bodies outside the
    // caller's scratch — free them before the throw reaches it.
    for (const solid of solids) {
      solid.dispose();
    }
    throw err;
  }
  return solids;
}

/**
 * The faces to sweep: the picked regions when the dialog named some, else
 * the profile's own regions. Thin profiles extrude their offset shell — for a
 * cut too, where the thin faces are the tool's source (extrude.ts:43). Faces
 * made here land in `scratch`; picked ones stay the caller's.
 */
function profileFaces(
  geometries: Edge[],
  plane: Plane,
  options: ExtrudeGhostOptions,
  scratch: Shape[],
): Face[] {
  if (options.thin) {
    const faces = ThinFaceMaker.make(geometries, plane, options.thin[0], options.thin[1]).faces;
    scratch.push(...faces);
    return faces;
  }
  if (options.faces) {
    return options.faces;
  }
  const faces = FaceMaker2.getRegions(geometries, plane, options.drill);
  scratch.push(...faces);
  return faces;
}

/**
 * Where the ghost body sits along the sketch-plane normal, or null when the
 * options describe nothing to show (a through-all that isn't a cut, a
 * distance that resolved to zero). Mirrors the distance semantics of
 * `Extrude.buildAdd` / `buildSymmetricHalves` / `buildRemove` and
 * `ExtrudeTwoDistances.build`.
 */
function ghostSpan(options: ExtrudeGhostOptions): GhostSpan | null {
  return trimSpan(rawSpan(options), options.endOffset);
}

function rawSpan(options: ExtrudeGhostOptions): GhostSpan | null {
  const throughAll = options.distance === null;
  if (throughAll && options.op !== 'remove') {
    return null;
  }
  if (options.distance2 !== null) {
    // extrude(d1, d2): d1 along the normal, d2 against it — a cut sweeps the
    // same both-sided tool (extrude-two-distances.ts:58–63).
    if (options.distance === null || options.distance2 === 0 || options.distance === 0) {
      return null;
    }
    return { from: -options.distance2, to: options.distance };
  }
  if (options.symmetric) {
    // A through-all symmetric cut runs the full ghost length each way.
    const half = throughAll ? options.throughAllLength : options.distance! / 2;
    return half === 0 ? null : { from: -half, to: half };
  }
  if (options.op === 'remove') {
    // The tool sweeps INTO the material — anti-normal (extrude.ts:354).
    const depth = throughAll ? options.throughAllLength : options.distance!;
    return depth === 0 ? null : { from: 0, to: -depth };
  }
  return options.distance ? { from: 0, to: options.distance } : null;
}

/**
 * `.endOffset()` shortens every sweep the statement makes, each toward the
 * sketch plane it left from — `Extruder` subtracts it from the signed distance
 * (simple-extruder.ts:47), and the kernel hands the same offset to both halves
 * of a symmetric or two-distance extrude, so both ends pull in. An end sitting
 * *on* the plane stays there, and an offset that eats the whole span leaves
 * nothing to show.
 */
function trimSpan(span: GhostSpan | null, endOffset: number | null): GhostSpan | null {
  if (!span || !endOffset) {
    return span;
  }
  const pull = (end: number) => end - Math.sign(end) * endOffset;
  const trimmed = { from: pull(span.from), to: pull(span.to) };
  return trimmed.from === trimmed.to ? null : trimmed;
}

/** One sweep covering the whole span, from a copy of the profile at its near end. */
function spanPrism(faces: Face[], plane: Plane, span: GhostSpan, scratch: Shape[]): Shape[] {
  const shift = Matrix4.fromTranslationVector(plane.normal.multiply(span.from));
  const base = faces.map(face => ShapeOps.transform(face, shift) as Face);
  scratch.push(...base);
  return extrudeInto(new Extruder(base, plane, span.to - span.from), scratch);
}

/**
 * The kernel's two-sweep construction: one prism each way off the sketch
 * plane, fused. Unfused halves would z-fight along their shared plane face
 * under the ghost's transparency.
 */
function fusedHalves(
  faces: Face[],
  plane: Plane,
  span: GhostSpan,
  draft: [number, number],
  scratch: Shape[],
): Shape[] {
  const halves = [
    ...extrudeInto(new Extruder(faces, plane, span.to, draft), scratch),
    ...extrudeInto(new Extruder(faces, plane, span.from, draft), scratch),
  ];
  scratch.push(...halves);
  const fused = BooleanOps.fuse(halves);
  fused.dispose();
  return fused.result;
}
