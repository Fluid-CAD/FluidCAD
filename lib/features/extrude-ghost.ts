import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";
import { Extruder } from "./simple-extruder.js";

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
};

export type ExtrudeGhostSolids = {
  /** The bodies to mesh — empty when the profile yields no region. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
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
    return { solids: buildSolids(profile, options, scratch), scratch };
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
): Shape[] {
  const plane = profile.getPlane();
  const geometries = profile.getGeometries();
  const span = ghostSpan(options);
  if (!plane || geometries.length === 0 || !span) {
    return [];
  }

  // Thin profiles extrude their offset shell — for a cut too, where the thin
  // faces are the tool's source (extrude.ts:43).
  const faces = options.thin
    ? ThinFaceMaker.make(geometries, plane, options.thin[0], options.thin[1]).faces
    : FaceMaker2.getRegions(geometries, plane, options.drill);
  scratch.push(...faces);
  if (faces.length === 0) {
    return [];
  }

  const draft = options.draft ? [options.draft, options.draft] as [number, number] : null;

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

  return new Extruder(faces, plane, span.to, draft).extrude();
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
  return new Extruder(base, plane, span.to - span.from).extrude();
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
    ...new Extruder(faces, plane, span.to, draft).extrude(),
    ...new Extruder(faces, plane, span.from, draft).extrude(),
  ];
  scratch.push(...halves);
  const fused = BooleanOps.fuse(halves);
  fused.dispose();
  return fused.result;
}
