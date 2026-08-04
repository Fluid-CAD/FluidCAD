import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { Solid } from "../common/solid.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import {
  buildCircularCopyGhostMatrices, buildLinearCopyGhostMatrices,
} from "../features/copy-ghost.js";
import { buildExtrudeGhostSolids } from "../features/extrude-ghost.js";
import { buildRibGhostSolids } from "../features/rib-ghost.js";
import { buildFilletGhostBands } from "../features/fillet-ghost.js";
import { buildHelixGhostWires } from "../features/helix-ghost.js";
import {
  HelixSourceKind, resolveHelixEdgeSource, resolveHelixFaceSource,
} from "../features/helix-geometry.js";
import { buildLoftGhostSolids, LoftGhostProfile } from "../features/loft-ghost.js";
import { buildPlaneGhostQuad, PlaneGhostBase, PlaneGhostSource } from "../features/plane-ghost.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import {
  buildCircularGhostMatrices, buildLinearGhostMatrices, buildMirrorGhostMatrices,
  buildRotateGhostMatrices, linearGhostInstanceCount, RepeatGhostDirection, RepeatGhostSweep,
} from "../features/repeat-ghost.js";
import { buildRevolveGhostSolids } from "../features/revolve-ghost.js";
import { buildSweepGhostSolids } from "../features/sweep-ghost.js";
import { Extrudable, BoundingBox } from "../helpers/types.js";
import { Axis, StandardAxis, toAxis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane, toPlane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceQuery } from "../oc/face-query.js";
import type { LoftEndCondition } from "../oc/loft-ops.js";
import type { MeshConfig } from "../oc/mesh.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { MeshBuilder } from "./mesh-builder.js";
import { transformMeshes } from "./mesh-transform.js";
import { renderFacePatch } from "./render-face.js";
import { Scene, SceneObjectMesh } from "./scene.js";

/**
 * A dialog's live geometry request, every value already resolved to a number
 * (expression resolution is the server's job — the kernel never parses code).
 * Discriminated on `feature` so later features add a branch, not an endpoint.
 */
export type FeatureGhostRequest =
  | ExtrudeGhostRequest
  | RibGhostRequest
  | RevolveGhostRequest
  | SweepGhostRequest
  | LoftGhostRequest
  | FilletGhostRequest
  | HelixGhostRequest
  | RepeatGhostRequest
  | CopyGhostRequest
  | PlaneGhostRequest;

export type ExtrudeGhostRequest = {
  feature: 'extrude';
  op: 'add' | 'remove' | 'new';
  distance: number | null;
  distance2: number | null;
  symmetric: boolean;
  draft: number | null;
  drill: boolean;
  thin: [number] | [number, number] | null;
  /** The producing statement of the profile to extrude. */
  profile: { filePath: string; line: number };
};

export type RibGhostRequest = {
  feature: 'rib';
  op: 'add' | 'remove' | 'new';
  /** Wall thickness; the sign picks the side of the sketch plane. Nonzero. */
  thickness: number;
  parallel: boolean;
  extend: boolean;
  draft: number | null;
  /** The producing statement of the spine sketch. */
  spine: { filePath: string; line: number };
  /**
   * The `.scope(…)` solids by producing statement; empty means the rib
   * conforms to every solid in the scene (the kernel's own default).
   */
  scope: { filePath: string; line: number }[];
  /**
   * Edit mode: the edited rib statement's own call site. The scene already
   * contains that rib — built and fused — so the scope solids are read as of
   * just before it (its consumption and its own body unwound); conforming
   * the new prism against a body that already contains the applied rib
   * leaves only boundary slivers.
   */
  exclude?: { filePath: string; line: number };
};

export type RevolveGhostRequest = {
  feature: 'revolve';
  op: 'add' | 'remove' | 'new';
  /** Sweep angle in degrees. */
  angle: number;
  thin: [number] | [number, number] | null;
  /** The producing statement of the profile to revolve. */
  profile: { filePath: string; line: number };
  axis: GhostAxisRef;
};

/**
 * The revolve dialog's axis slot on the wire: a world axis from the X/Y/Z
 * quick buttons, an `axis()` statement by call site, or an edge picked in the
 * viewport — the three things the slot can hold, mirrored from the apply
 * request's own axis ref. "Keep the current axis" never reaches here; the
 * client resolves it to the statement's own `axis()` call site first.
 */
export type GhostAxisRef =
  | { kind: 'standard'; axis: StandardAxis }
  | { kind: 'axis'; filePath: string; line: number }
  | { kind: 'edge'; shapeId: string; index: number };

export type SweepGhostRequest = {
  feature: 'sweep';
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  /** The producing statement of the profile to sweep. */
  profile: { filePath: string; line: number };
  path: GhostPathRef;
};

/**
 * The sweep dialog's path slot on the wire: a wire statement by call site — a
 * sketch or a helix, the two things the slot accepts as a named source — or
 * the edges picked in the viewport, which the apply writes as a selector. As
 * with the revolve's axis, "keep the current path" never reaches here; the
 * client resolves it to one of the two first.
 */
export type GhostPathRef =
  | { kind: 'wire'; filePath: string; line: number }
  | { kind: 'edges'; entities: { shapeId: string; index: number }[] };

export type LoftGhostRequest = {
  feature: 'loft';
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  /** The sections to skin through, in the loft's argument order. */
  profiles: GhostSectionRef[];
  /** Side rails, by producing statement — a sketch or a helix. */
  guides: { filePath: string; line: number }[];
  startCondition: GhostLoftCondition | null;
  endCondition: GhostLoftCondition | null;
};

/**
 * One loft section on the wire: a sketch by call site, or faces picked in the
 * viewport. A chip holds a single pick, but an edit dialog's kept argument
 * resolves to whatever faces its `select()` named — hence the list.
 */
export type GhostSectionRef =
  | { kind: 'sketch'; filePath: string; line: number }
  | { kind: 'faces'; entities: { shapeId: string; index: number }[] };

/** A takeoff condition as the dialog states it (`.startCondition(type, mag)`). */
export type GhostLoftCondition = { type: 'normal' | 'tangent'; magnitude: number };

/**
 * The edge-modifying features. They ghost differently from the swept ones:
 * there is no standalone body to build, only the surfaces the feature lays
 * along edges of a solid that already exists — see `buildFilletGhostBands`.
 */
export type FilletGhostRequest = {
  feature: 'fillet' | 'chamfer';
  /** Fillet radius, or the chamfer's first distance. */
  value: number;
  /** The chamfer's second value; null is the equal-distance overload. */
  distance2: number | null;
  /** The chamfer's second value is an angle in degrees, not a distance. */
  isAngle: boolean;
  /** The picks, each by the solid it was made on and its index there. */
  edges: GhostEntityRef[];
};

/**
 * A viewport pick: a scene shape, which kind of subshape was clicked, and its
 * index in that shape's mesh order. A face pick means "every edge of that
 * face" — the edge features explode faces at build time.
 */
export type GhostEntityRef = { shapeId: string; index: number; kind: 'edge' | 'face' };

/**
 * The helix. It sweeps nothing and modifies nothing: the feature IS a curve,
 * so its ghost is that curve, and it carries neither an `op` nor a profile —
 * just the source it coils around and the dialog's dimensions, each null when
 * the field is empty and the API default applies.
 */
export type HelixGhostRequest = {
  feature: 'helix';
  source: GhostHelixSourceRef;
  radius: number | null;
  endRadius: number | null;
  pitch: number | null;
  turns: number | null;
  height: number | null;
  startOffset: number | null;
  endOffset: number | null;
};

/**
 * What the helix dialog's source slot holds, on the wire. The first three are
 * the revolve axis family ({@link GhostAxisRef}) — a world axis, an `axis()`
 * statement, and an edge the dialog turns into `axis(<edge>)`. The last two
 * are the helix's own: a cylindrical or conical face (the From-face tab), and
 * a bare edge used as the source directly, which only an edit dialog produces
 * — `helix(select(edge().circle()))` coils in that circle's frame, and reading
 * it as an axis instead would ghost a different curve, or none at all.
 */
export type GhostHelixSourceRef =
  | { kind: 'standard'; axis: StandardAxis }
  | { kind: 'axis'; filePath: string; line: number }
  | { kind: 'axis-edge'; shapeId: string; index: number }
  | { kind: 'edge'; shapeId: string; index: number }
  | { kind: 'face'; shapeId: string; index: number };

/**
 * The repeat. Alone among the features it builds nothing: the instances it
 * places are the target features themselves, moved — so the ghost stamps the
 * targets' *already meshed* shapes at each instance transform instead of
 * replaying the feature per instance, which would cost what the apply costs.
 *
 * That makes it honest about position and approximate about the result: a
 * repeated cut ghosts its tool body at each new place rather than the material
 * it removes, which is both what SolidWorks shows for a pattern preview and
 * the thing the dialog's numbers actually steer.
 */
export type RepeatGhostRequest = {
  feature: 'repeat';
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** The timeline rows being replayed, by call site — the repeat's targets. */
  targets: { filePath: string; line: number }[];
  /** Linear: one per direction (1–2). Circular and rotate: one. Mirror: none. */
  axes: GhostAxisRef[];
  /** The mirror plane; null for every other kind. */
  plane: GhostPlaneRef | null;
  /** Linear: count and spacing per direction, parallel to {@link axes}. */
  directions: GhostRepeatDirection[];
  /** Linear: center the pattern on the original instead of starting there. */
  centered: boolean;
  /** Circular: instances around the axis, the original included. */
  count: number | null;
  /** Circular: the whole sweep to distribute, or the step between neighbours. */
  sweep: RepeatGhostSweep | null;
  /** Rotate: how far the single clone turns, in degrees. */
  angle: number | null;
};

/**
 * One linear direction on the wire: how many instances, and how far apart —
 * either directly (`offset`) or as the span they share (`length`), the two
 * forms the dialog's spacing mode writes. Shared with the copy, which states a
 * direction exactly as the repeat does.
 */
export type GhostRepeatDirection = {
  count: number;
  offset: number | null;
  length: number | null;
};

/**
 * The copy — the repeat's quieter twin, and the second feature whose ghost
 * builds no geometry of its own.
 *
 * Where a repeat *replays* the features it names, `copy()` clones the shapes
 * its targets already hold and moves them (copy-linear.ts:32-97): what an
 * instance puts on screen IS the target's body, no boolean and no re-run. So
 * the ghost stamps that body — whole, a boss fused into its plate included,
 * because that whole fused body is precisely what the apply will clone.
 *
 * A copy also takes solids rather than timeline rows, and the ghost reads that
 * literally: `targets` name the statements whose solids are being cloned, and
 * their meshes (made by the last render) are stamped at each instance
 * transform. Per keystroke that is N array transforms and no OCC work.
 *
 * The origin instance is never drawn — it is the geometry already on screen.
 */
export type CopyGhostRequest = {
  feature: 'copy';
  kind: 'linear' | 'circular';
  /** The solid-bearing statements being cloned, by call site. */
  targets: { filePath: string; line: number }[];
  /** Linear: one per direction (1–2). Circular: one. */
  axes: GhostAxisRef[];
  /** Linear: count and spacing per direction, parallel to {@link axes}. */
  directions: GhostRepeatDirection[];
  /** Linear: center the copies on the original instead of starting there. */
  centered: boolean;
  /** Circular: instances around the axis, the original included. */
  count: number | null;
  /** Circular: the whole sweep to divide, or the step between neighbours. */
  sweep: RepeatGhostSweep | null;
  /**
   * Instances the copy leaves out, one index per direction — the statement's
   * own `skip` option (copy-linear.ts:82, copy-circular.ts:55). A circular
   * copy's entries carry a single index each; absent skips none.
   */
  skip?: number[][];
};

/**
 * The mirror dialog's plane slot on the wire, the plane sibling of
 * {@link GhostAxisRef}: an origin plane from its viewport quad, a `plane()`
 * statement by call site, or a planar face picked in the viewport. As with the
 * axis, "keep the current plane" never travels — the client resolves it first.
 */
export type GhostPlaneRef =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; filePath: string; line: number }
  | { kind: 'face'; shapeId: string; index: number };

/**
 * The construction plane, and the second feature (after the helix) whose ghost
 * is the feature itself rather than material: a plane adds nothing and removes
 * nothing, so what comes back is the quad `plane()` would render, drawn in the
 * same yellow the settled plane wears.
 *
 * The bases arrive resolved, in argument order — one for the offset and edge
 * forms, two for a mid plane — and the numbers already evaluated, as everywhere
 * else on this wire.
 */
export type PlaneGhostRequest = {
  feature: 'plane';
  type: 'offset' | 'mid' | 'edge';
  bases: GhostPlaneBaseRef[];
  /** Offset along the base normal; null when the field is empty. */
  offset: number | null;
  rotateX: number | null;
  rotateY: number | null;
  rotateZ: number | null;
  /** Edge form: the normalized 0–1 position along the curve. */
  position: number | null;
};

/**
 * What the plane dialog's base slot holds, on the wire. The first three are
 * the mirror plane's family ({@link GhostPlaneRef}) — an origin plane, a
 * `plane()` statement, a picked planar face. The last two are the edge form's
 * own: a picked edge, and a statement drawing a single curve (a helix, or a
 * sketch holding one curve), which `plane(<statement>, position)` resolves to
 * that curve. As everywhere else, a keep chip resolves to one of these
 * client-side, so "keep" never travels.
 */
export type GhostPlaneBaseRef =
  | GhostPlaneRef
  | { kind: 'wire'; filePath: string; line: number }
  | { kind: 'edge'; shapeId: string; index: number };

/**
 * One ghost body, in the same mesh wire format a rendered solid uses. `kind`
 * overrides the overlay's per-dialog color for this body alone — a fillet's
 * picks can take material away at one edge and put it back at the next, so the
 * two have to be told apart within a single answer. The swept features leave it
 * unset and the whole ghost takes the dialog's own add/remove color.
 */
export type GhostSolid = {
  meshes: SceneObjectMesh[];
  kind?: 'add' | 'remove';
  /**
   * A construction plane's own frame: its normal, and the point its quad is
   * centered on. Only the plane ghost carries it — the overlay draws the
   * normal arrow from these, the way a rendered `plane()` draws its own.
   */
  plane?: { normal: Vector3Wire; center: Vector3Wire };
};

/** A point or direction on the wire, in the shape the scene already sends. */
type Vector3Wire = { x: number; y: number; z: number };

export type FeatureGhostResult =
  | { ok: true; solids: GhostSolid[] }
  | {
    ok: false;
    reason: string;
    /**
     * This refusal is worth putting in front of the user. Almost none are:
     * a scene that moved on, a pick that went stale, values still being typed
     * — all ordinary mid-composition states a dialog would only flash noise
     * about. It is set for a *limit* instead, something the user can act on
     * by changing a number, where a silently blank viewport reads as a bug.
     */
    surface?: boolean;
  };

/** How far past the model a through-all ghost runs, as a fraction of its reach. */
const THROUGH_ALL_MARGIN = 1.1;

/** Through-all ghost length when the scene offers nothing to size against. */
const THROUGH_ALL_FALLBACK = 100;

/**
 * How many instances a repeat or copy ghost will draw. Past it the answer is a
 * refusal carrying the count, not silence: a pattern that simply vanished
 * when the count grew would read as a bug rather than a limit.
 */
const MAX_GHOST_INSTANCES = 200;

/**
 * Mesh the geometry a feature dialog would produce, without touching the
 * model: the shapes are built from the profile alone, meshed once, and freed
 * before returning. Nothing is registered, cached onto a scene shape, or
 * broadcast — the caller ships the meshes straight back to the one client
 * that asked.
 *
 * Runs entirely inside the caller's OCC serialization window; it holds no
 * shape past its own return.
 */
export function buildFeatureGhost(
  scene: Scene,
  request: FeatureGhostRequest,
  meshConfig: MeshConfig,
): FeatureGhostResult {
  // Each arm tests its own feature so the union narrows — `FilletGhostRequest`
  // is keyed on TWO literals, which a negative test can't rule out.
  if (request.feature === 'extrude' || request.feature === 'revolve') {
    return meshGhostBodies(buildProfileGhost(scene, request), meshConfig);
  }
  if (request.feature === 'rib') {
    return meshGhostBodies(buildRibGhost(scene, request), meshConfig);
  }
  if (request.feature === 'sweep') {
    return meshGhostBodies(buildSweepGhost(scene, request), meshConfig);
  }
  if (request.feature === 'loft') {
    return meshGhostBodies(buildLoftGhost(scene, request), meshConfig);
  }
  if (request.feature === 'helix') {
    return meshGhostBodies(buildHelixGhost(scene, request), meshConfig);
  }
  if (request.feature === 'repeat') {
    return buildRepeatGhost(scene, request, meshConfig);
  }
  if (request.feature === 'copy') {
    return buildCopyGhost(scene, request, meshConfig);
  }
  if (request.feature === 'plane') {
    return buildPlaneGhost(scene, request, meshConfig);
  }
  return buildBandGhost(scene, request, meshConfig);
}

/**
 * Mesh the features that build their own geometry — the swept bodies and the
 * helix's curve — then free every shape they were built from.
 */
function meshGhostBodies(built: GhostBuild, meshConfig: MeshConfig): FeatureGhostResult {
  if ('reason' in built) {
    return { ok: false, reason: built.reason };
  }

  try {
    const builder = new MeshBuilder(meshConfig);
    const solids: GhostSolid[] = [];
    for (const solid of built.solids) {
      const meshes = builder.build(solid);
      if (meshes) {
        solids.push({ meshes });
      }
    }
    return { ok: true, solids };
  } finally {
    for (const shape of built.solids) {
      shape.dispose();
    }
    for (const shape of built.scratch) {
      shape.dispose();
    }
  }
}

/**
 * The edge-modifying branch: fillet and chamfer. The picks are grouped by the
 * solid they were made on and each group runs its own maker, the way
 * `Fillet.doBuild` walks the scene's solids and takes the edges that belong to
 * each — a selection can straddle two bodies, and a maker only ever modifies
 * one. A group whose maker refuses contributes nothing and the rest still draw.
 */
function buildBandGhost(
  scene: Scene,
  request: FilletGhostRequest,
  meshConfig: MeshConfig,
): FeatureGhostResult {
  const groups = resolvePickedEdgeGroups(scene, request.edges);
  if (!groups) {
    return { ok: false, reason: 'Those edges are not in the rendered scene.' };
  }

  const solids: GhostSolid[] = [];
  try {
    for (const group of groups) {
      const built = buildFilletGhostBands(group.solid, group.edges, {
        feature: request.feature,
        value: request.value,
        distance2: request.distance2,
        isAngle: request.isAngle,
      });
      try {
        for (const band of built.bands) {
          const meshes = renderFacePatch(band.face, meshConfig);
          if (meshes.length > 0) {
            solids.push({ meshes, kind: band.kind });
          }
        }
      } finally {
        for (const band of built.bands) {
          band.face.dispose();
        }
        for (const shape of built.scratch) {
          shape.dispose();
        }
      }
    }
    return { ok: true, solids };
  } finally {
    for (const group of groups) {
      for (const edge of group.edges) {
        edge.dispose();
      }
    }
  }
}

/**
 * The picked edges, grouped by the solid each was picked on. Picks address
 * subshapes by index into the mesh order, so every subshape of a named solid
 * is wrapped to reach the indexed one; the spares go back here and the picks
 * themselves are the caller's to free. A face pick contributes all of that
 * face's edges, the way `Fillet.doBuild` explodes a face selection
 * (fillet.ts:63) — the ghost has to show what the apply will do, not what was
 * clicked. A pick the scene no longer has is a refusal: a band ghost missing
 * one of its edges shows a feature the apply won't produce.
 */
function resolvePickedEdgeGroups(
  scene: Scene,
  refs: GhostEntityRef[],
): { solid: Solid; edges: Edge[] }[] | null {
  const groups = new Map<string, { solid: Solid; edges: Edge[] }>();
  const owned: Shape[] = [];
  let complete = true;

  for (const ref of refs) {
    const shape = findShapeById(scene, ref.shapeId);
    if (!(shape instanceof Solid)) {
      complete = false;
      break;
    }
    let group = groups.get(ref.shapeId);
    if (!group) {
      group = { solid: shape, edges: [] };
      groups.set(ref.shapeId, group);
    }

    if (ref.kind === 'face') {
      const faces = Explorer.findFacesWrapped(shape);
      owned.push(...faces);
      const face = faces[ref.index];
      if (!face) {
        complete = false;
        break;
      }
      const faceEdges = Explorer.findEdgesWrapped(face);
      owned.push(...faceEdges);
      group.edges.push(...faceEdges);
      continue;
    }

    const edges = Explorer.findEdgesWrapped(shape);
    owned.push(...edges);
    const edge = edges[ref.index];
    if (!edge) {
      complete = false;
      break;
    }
    group.edges.push(edge);
  }

  if (!complete) {
    for (const shape of owned) {
      shape.dispose();
    }
    return null;
  }
  // The picks travel on in the groups; everything explored to reach them —
  // sibling edges, the face wrappers themselves — goes back now.
  const resolved = [...groups.values()];
  const picked = new Set<Shape>(resolved.flatMap(g => g.edges));
  for (const shape of owned) {
    if (!picked.has(shape)) {
      shape.dispose();
    }
  }
  return resolved;
}

/**
 * The plane branch: the one ghost that is neither a body nor a curve but a
 * *frame* — the quad `plane()` renders, at the place the dialog's bases and
 * numbers put it. Nothing is added and nothing is taken away, so it carries no
 * add/remove color; it wears the plane's own yellow instead, and rides back
 * with its normal so the overlay can draw the same arrow a settled plane does.
 *
 * The slots resolve here — the kernel's half of the dialog's base list — and
 * the geometry comes from `buildPlaneGhostQuad`, which mirrors the three plane
 * features. A base the scene no longer holds refuses outright: half a mid
 * plane is not a plane.
 */
function buildPlaneGhost(
  scene: Scene,
  request: PlaneGhostRequest,
  meshConfig: MeshConfig,
): FeatureGhostResult {
  // Only a face or edge pick opens shapes here; the named sources are read off
  // scene objects and the numbers are plain numbers.
  const scratch: Shape[] = [];
  try {
    const source = resolvePlaneGhostSource(scene, request, scratch);
    if ('reason' in source) {
      return { ok: false, reason: source.reason };
    }
    const quad = buildPlaneGhostQuad(source, {
      offset: request.offset ?? 0,
      rotateX: request.rotateX ?? 0,
      rotateY: request.rotateY ?? 0,
      rotateZ: request.rotateZ ?? 0,
    });
    try {
      const meshes = new MeshBuilder(meshConfig).build(quad.face);
      if (!meshes) {
        return { ok: true, solids: [] };
      }
      return {
        ok: true,
        solids: [{
          meshes,
          plane: { normal: toVector3Wire(quad.normal), center: toVector3Wire(quad.center) },
        }],
      };
    } finally {
      quad.face.dispose();
    }
  } finally {
    for (const shape of scratch) {
      shape.dispose();
    }
  }
}

/**
 * The dialog's base list as the form it belongs to: one plane for an offset,
 * two for a mid, one curve for the edge form. The counts are the route's to
 * enforce; they are re-checked here because a form built from the wrong number
 * of bases is a different plane, not a partial one.
 */
function resolvePlaneGhostSource(
  scene: Scene,
  request: PlaneGhostRequest,
  scratch: Shape[],
): PlaneGhostSource | { reason: string } {
  if (request.type === 'edge') {
    const edge = request.bases.length === 1
      ? resolvePlaneGhostEdge(scene, request.bases[0], scratch)
      : null;
    return edge
      ? { form: 'edge', edge, position: request.position ?? 0 }
      : { reason: 'That edge is not in the rendered scene.' };
  }
  const bases: PlaneGhostBase[] = [];
  for (const ref of request.bases) {
    const base = resolvePlaneGhostBase(scene, ref, scratch);
    if (!base) {
      return { reason: 'That base is not in the rendered scene.' };
    }
    bases.push(base);
  }
  if (request.type === 'mid') {
    return bases.length === 2
      ? { form: 'mid', bases: [bases[0], bases[1]] }
      : { reason: 'A mid plane takes two bases.' };
  }
  return bases.length === 1
    ? { form: 'offset', base: bases[0] }
    : { reason: 'An offset plane takes one base.' };
}

/**
 * One base of the offset and mid forms, read the way `plane()` reads it at
 * build time: an origin plane is a constant, a `plane()` statement gives up
 * its stored plane and the point its quad sits on (a statement the edited
 * plane has consumed included — consumption removes the quad, not the state),
 * and a picked face gives up its own plane, centered on the face rather than
 * on the plane's origin (plane-from-object.ts:61-64). Null means the scene no
 * longer holds what the slot names — or the face is curved, and defines no
 * plane at all.
 */
function resolvePlaneGhostBase(
  scene: Scene,
  ref: GhostPlaneBaseRef,
  scratch: Shape[],
): PlaneGhostBase | null {
  if (ref.kind === 'standard') {
    return { plane: toPlane(ref.plane) };
  }
  if (ref.kind === 'plane') {
    const obj = findByLocation(scene, ref, o => o instanceof PlaneObjectBase) as PlaneObjectBase | null;
    const plane = obj?.getPlane();
    return plane ? { plane, center: obj!.getPlaneCenter() } : null;
  }
  if (ref.kind !== 'face') {
    // A curve source belongs to the edge form alone.
    return null;
  }
  const face = resolvePickedFace(scene, ref, scratch);
  if (!face || !FaceQuery.isPlanarFace(face)) {
    return null;
  }
  try {
    const box = ShapeOps.getBoundingBox(face);
    return { plane: face.getPlane(), center: new Point(box.centerX, box.centerY, box.centerZ) };
  } catch {
    return null;
  }
}

/**
 * The edge form's base: an edge picked in the viewport, or the single curve a
 * statement draws (a helix, or a sketch holding one). A pick is wrapped fresh
 * out of the solid it was made on and goes back with the scratch; a
 * statement's edge belongs to the scene and is only borrowed. Either way the
 * source has to be exactly one curve — `plane()` refuses anything else
 * (plane-from-object.ts:39).
 */
function resolvePlaneGhostEdge(
  scene: Scene,
  ref: GhostPlaneBaseRef,
  scratch: Shape[],
): Edge | null {
  if (ref.kind === 'wire') {
    const source = findWireSource(scene, ref);
    const edges = source ? wireSourceEdges(source) : [];
    return edges.length === 1 ? edges[0] : null;
  }
  if (ref.kind !== 'edge') {
    return null;
  }
  const shape = findShapeById(scene, ref.shapeId);
  if (!shape) {
    return null;
  }
  const edges = Explorer.findEdgesWrapped(shape);
  scratch.push(...edges);
  return edges[ref.index] ?? null;
}

/** A point or direction, flattened to what the wire carries. */
function toVector3Wire(value: { x: number; y: number; z: number }): Vector3Wire {
  return { x: value.x, y: value.y, z: value.z };
}

/**
 * The repeat branch: no geometry is built at all. The instances a repeat
 * places are its target features, moved — so the targets' meshes are read
 * once (the last render already made them) and stamped at each instance
 * transform. Per keystroke that is N array transforms and no OCC work, which
 * is the only reason a pattern of two hundred bodies can live on a 250 ms
 * debounce; replaying the feature per instance is what the apply does.
 *
 * The origin instance is never drawn — it is the geometry already on screen.
 */
function buildRepeatGhost(
  scene: Scene,
  request: RepeatGhostRequest,
  meshConfig: MeshConfig,
): FeatureGhostResult {
  // Only the mirror's face pick opens shapes here; the axis forms clean up
  // after themselves and the instances are plain numbers.
  const scratch: Shape[] = [];
  try {
    const placed = repeatGhostMatrices(scene, request, scratch);
    if ('reason' in placed) {
      return { ok: false, reason: placed.reason, surface: placed.surface };
    }
    if (placed.matrices.length === 0) {
      // A count still at one, a spacing still at zero — states the dialog
      // passes through while the user types. Nothing to draw, nothing wrong.
      return { ok: true, solids: [] };
    }
    const targets = targetObjectsAt(scene, request.targets);
    if (targets.length === 0) {
      return { ok: false, reason: 'That feature is not in the rendered scene.' };
    }
    const runs = repeatChainRuns(scene, targets);
    if (runs.length === 0) {
      return { ok: false, reason: 'That feature has no solid to preview.' };
    }
    const stamps = repeatStamps(runs, meshConfig, scratch);
    return {
      ok: true,
      solids: placed.matrices.flatMap(matrix => stamps.map(stamp => ({
        meshes: transformMeshes(stamp.meshes, matrix),
        kind: stamp.kind,
      }))),
    };
  } finally {
    for (const shape of scratch) {
      shape.dispose();
    }
  }
}

/**
 * Where the instances land, or why the request names something the scene no
 * longer holds. The cap is applied to the *stated* count first, before a grid
 * is materialized — a mistyped count must refuse, not allocate.
 */
function repeatGhostMatrices(
  scene: Scene,
  request: RepeatGhostRequest,
  scratch: Shape[],
): { matrices: Matrix4[] } | { reason: string; surface?: boolean } {
  const total = requestedInstanceCount(request);
  if (total > MAX_GHOST_INSTANCES) {
    // The one refusal here the user can do something about, and the one where
    // drawing nothing would look broken rather than unfinished.
    return { reason: `${total} instances is more than the preview draws.`, surface: true };
  }
  if (request.kind === 'mirror') {
    const plane = request.plane && resolveGhostPlane(scene, request.plane, scratch);
    return plane
      ? { matrices: buildMirrorGhostMatrices(plane) }
      : { reason: 'That mirror plane is not in the rendered scene.' };
  }

  const axes: Axis[] = [];
  for (const ref of request.axes) {
    const axis = resolveGhostAxis(scene, ref);
    if (!axis) {
      return { reason: 'That axis is not in the rendered scene.' };
    }
    axes.push(axis);
  }
  if (axes.length === 0) {
    return { matrices: [] };
  }
  if (request.kind === 'rotate') {
    return { matrices: buildRotateGhostMatrices(axes[0], request.angle ?? 0) };
  }
  if (request.kind === 'circular') {
    return {
      matrices: request.sweep
        ? buildCircularGhostMatrices(axes[0], request.count ?? 0, request.sweep, request.centered)
        : [],
    };
  }
  // Linear: one axis per direction. A mismatch is a malformed request the
  // route rejects; here it simply lays nothing out.
  if (axes.length !== request.directions.length) {
    return { matrices: [] };
  }
  const directions: RepeatGhostDirection[] = request.directions.map((direction, i) => ({
    axis: axes[i],
    count: direction.count,
    offset: directionOffset(direction),
  }));
  return { matrices: buildLinearGhostMatrices(directions, request.centered) };
}

/**
 * A direction's step between neighbours. The dialog's Total spacing mode
 * states the whole span instead, which `repeat()` divides across the gaps
 * (repeat.ts:153) — one fewer than the instances, the original holding the
 * first place.
 */
function directionOffset(direction: GhostRepeatDirection): number {
  if (direction.offset !== null) {
    return direction.offset;
  }
  return direction.length !== null ? direction.length / (direction.count - 1) : NaN;
}

/**
 * How many bodies the request describes, read off its numbers alone — the
 * repeat's four kinds and the copy's two, which state their instances the
 * same way.
 */
function requestedInstanceCount(request: RepeatGhostRequest | CopyGhostRequest): number {
  if (request.kind === 'linear') {
    return linearGhostInstanceCount(request.directions);
  }
  if (request.kind === 'circular') {
    return Math.max(0, Math.floor(request.count ?? 0) - 1);
  }
  return 1;
}

/**
 * The objects a target ref names — a repeat's timeline row, a copy's picked
 * solid. Two wrinkles no other ghost has:
 *
 * - **A clone stamps its original's call site** (repeat-targets.ts:20-24), so
 *   a line an earlier repeat already replayed holds the original *and* every
 *   clone of it. The original alone is the target: a new repeat replays the
 *   statement, and a new copy clones the body that statement bound to its
 *   variable — neither takes the pattern that came out of it.
 * - **A target can be a container** — repeating or copying a `repeat()` or a
 *   `part()` row is legal, and `getShapes` gathers a container's children for
 *   us.
 */
function targetObjectsAt(
  scene: Scene,
  refs: { filePath: string; line: number }[],
): SceneObject[] {
  const targets: SceneObject[] = [];
  for (const ref of refs) {
    const objects = objectsAt(scene, ref);
    const originals = objects.filter(obj => obj.getCloneSource() === null);
    targets.push(...(originals.length > 0 ? originals : objects));
  }
  return targets;
}

/** One body stamped at every instance: its meshes, and what it stands for. */
type RepeatStamp = { meshes: SceneObjectMesh[]; kind?: 'add' | 'remove' };

/**
 * What one instance actually puts on screen.
 *
 * The obvious answer — the target's body — is only right when the instance
 * brings that whole body with it. It often doesn't: a boss sketched on a
 * plate's face *fuses into the plate*, so the target's solid is plate-plus-boss
 * while each new instance contributes the boss alone (the plate is built
 * outside the chain the repeat clones, and the clone's own fuse merges into the
 * one already there). Stamping the fused body would draw a plate per instance —
 * geometry the apply never produces.
 *
 * So each {@link RepeatChainRun} is stamped as the *difference* between what
 * came out of it and what went in: material the chain adds (green) and material
 * it takes away (red — a repeated cut previews as the pockets it will open). A
 * run that consumed nothing is a standalone body and needs no boolean at all,
 * which keeps the common case on the scene's cached meshes.
 *
 * A difference OCC refuses to compute draws nothing rather than falling back to
 * the whole body — being silent beats being wrong about what an apply does.
 */
function repeatStamps(
  runs: RepeatChainRun[],
  meshConfig: MeshConfig,
  scratch: Shape[],
): RepeatStamp[] {
  const added: Shape[] = [];
  const removed: Shape[] = [];
  try {
    for (const run of runs) {
      if (run.inputs.length === 0) {
        added.push(...run.outputs);
        continue;
      }
      added.push(...solidDifference(run.outputs, run.inputs, scratch));
      removed.push(...solidDifference(run.inputs, run.outputs, scratch));
    }
  } catch {
    return [];
  }
  const builder = new MeshBuilder(meshConfig);
  const stamps: RepeatStamp[] = [];
  if (added.length > 0) {
    stamps.push({ meshes: stampMeshes(added, builder), kind: 'add' });
  }
  if (removed.length > 0) {
    stamps.push({ meshes: stampMeshes(removed, builder), kind: 'remove' });
  }
  return stamps;
}

/**
 * One unbroken stretch of the cloned chain: the bodies it hands on, and the
 * bodies it took in from outside itself.
 */
type RepeatChainRun = { outputs: Shape[]; inputs: Shape[] };

/**
 * How the solids flow through the chain a repeat clones, split into runs.
 *
 * A chain is rarely one feature. `repeat('mirror', 'front', e, f, c1, f2)`
 * replays four of them, and the model may well have built something else in
 * between — so the chain reaches the scene as separate stretches, each taking a
 * body in and handing one on. A run's boundary is exactly that: an input owned
 * by an object the chain doesn't hold, an output no chain member consumed.
 *
 * Pairing every output with *its own* run's input is what keeps the difference
 * honest. Lumping them together would subtract a later stretch's input from an
 * earlier stretch's output and attribute the features in between — which the
 * repeat does not replay — to the pattern.
 */
function repeatChainRuns(scene: Scene, targets: SceneObject[]): RepeatChainRun[] {
  const chain = repeatCloneSet(targets);
  const objects = allObjects(scene);
  // Both directions of every solid consumption in the scene: who ate a body,
  // and which bodies a given feature ate (with the object each came from).
  const consumers = new Map<Shape, SceneObject>();
  const eaten = new Map<SceneObject, { shape: Shape; owner: SceneObject }[]>();
  for (const obj of objects) {
    for (const removal of obj.getRemovedShapes()) {
      if (removal.shape.getType() !== 'solid') {
        continue;
      }
      consumers.set(removal.shape, removal.removedBy);
      const list = eaten.get(removal.removedBy) ?? [];
      list.push({ shape: removal.shape, owner: obj });
      eaten.set(removal.removedBy, list);
    }
  }

  const runs: RepeatChainRun[] = [];
  // A container reports its children's solids as its own, so the same body
  // reaches this loop through both — it may only be stamped once.
  const stamped = new Set<Shape>();
  for (const member of chain) {
    for (const solid of memberSolids(member)) {
      // A body another chain member went on to consume is internal — the run
      // it belongs to hands on whatever that member produced instead.
      const consumer = consumers.get(solid);
      if (stamped.has(solid) || (consumer && chain.has(consumer))) {
        continue;
      }
      stamped.add(solid);
      runs.push({ outputs: [solid], inputs: runInputs(member, chain, eaten) });
    }
  }
  return runs;
}

/**
 * The bodies a run took in: walk back from its last member through everything
 * the chain consumed, and stop at the first body built outside it. A chain that
 * consumed nothing at all — a `.new()` extrude, a primitive — takes nothing in,
 * and its output stands alone.
 */
function runInputs(
  member: SceneObject,
  chain: Set<SceneObject>,
  eaten: Map<SceneObject, { shape: Shape; owner: SceneObject }[]>,
): Shape[] {
  const inputs = new Set<Shape>();
  const seen = new Set<SceneObject>();
  const stack = [member];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const { shape, owner } of eaten.get(current) ?? []) {
      if (chain.has(owner)) {
        stack.push(owner);
      } else {
        inputs.add(shape);
      }
    }
  }
  return [...inputs];
}

/**
 * Every solid a chain member added, one a later feature consumed included —
 * the flow is read from what was *built*, not from what still survives.
 */
function memberSolids(member: SceneObject): Shape[] {
  return member.getShapes(undefined, 'solid', new Set<SceneObject>());
}

/**
 * The objects a repeat would clone, gathered exactly as `cloneWithTransform`
 * gathers them (clone-transform.ts:14-40): each target's dependency closure,
 * plus every descendant. Nothing is cloned here and no transform is resolved —
 * the ghost only needs to know *which* objects an instance rebuilds.
 */
function repeatCloneSet(targets: SceneObject[]): Set<SceneObject> {
  const chain = new Set<SceneObject>();
  const addChildren = (obj: SceneObject): void => {
    for (const child of obj.getChildren()) {
      if (!chain.has(child)) {
        chain.add(child);
        addChildren(child);
      }
    }
  };
  const walk = (obj: SceneObject): void => {
    if (chain.has(obj)) {
      return;
    }
    chain.add(obj);
    for (const dep of obj.getDependencies()) {
      walk(dep);
    }
    // Boundary references join the set without their own dependencies —
    // mirroring collectBoundary, so the ghost doesn't treat the referenced
    // base body as rebuilt per instance.
    for (const dep of obj.getBoundaryDependencies()) {
      if (!chain.has(dep)) {
        chain.add(dep);
        addChildren(dep);
      }
    }
    addChildren(obj);
  };
  for (const target of targets) {
    walk(target);
  }
  return chain;
}

/**
 * `stocks` minus `tools`, as solids. The result is explored raw rather than
 * wrapped whole: a difference that comes back **empty** is an ordinary answer
 * here — a cut adds nothing, a boss removes nothing — and `ShapeFactory` would
 * throw "Unknown shape type" on that empty compound instead of reporting it.
 * Exploring also keeps every piece of a difference that falls apart into
 * several, which wrapping would silently narrow to the first.
 *
 * Each wrapped piece joins the scratch; the stocks and tools are the scene's
 * and are left alone.
 */
function solidDifference(stocks: Shape[], tools: Shape[], scratch: Shape[]): Shape[] {
  let current = stocks;
  for (const tool of tools) {
    const next: Shape[] = [];
    for (const stock of current) {
      const raw = BooleanOps.cutShapesRaw(stock.getShape(), tool.getShape());
      try {
        for (const found of Explorer.findShapes(raw, Explorer.getOcShapeType('solid'))) {
          const piece = Solid.fromTopoDSSolid(Explorer.toSolid(found));
          scratch.push(piece);
          next.push(piece);
        }
      } finally {
        // The container handle is this function's alone — the pieces carry
        // their own, the way every wrapper does.
        raw.delete();
      }
    }
    current = next;
    if (current.length === 0) {
      break;
    }
  }
  // `current` is still `stocks` only when there was nothing to cut with, and
  // callers never reach that: a run with no inputs is stamped whole instead.
  return current;
}

/**
 * The meshes of the bodies to stamp. A scene shape was meshed by the last
 * render, so that is a read; a body built here (a difference) is meshed now —
 * either way WITHOUT writing back onto the shape, since ghost code never
 * touches scene state.
 */
function stampMeshes(solids: Shape[], builder: MeshBuilder): SceneObjectMesh[] {
  const meshes: SceneObjectMesh[] = [];
  for (const solid of solids) {
    const cached = solid.getMeshes();
    const built = cached && cached.length > 0 ? cached : builder.build(solid);
    if (built) {
      meshes.push(...built);
    }
  }
  return meshes;
}

/**
 * The copy branch: no geometry is built here either, and unlike the repeat
 * none has to be worked out. A repeat replays the features it names, so what
 * one instance contributes is the *difference* its chain makes; a copy clones
 * the bodies its targets already hold and moves them (copy-linear.ts:32-97),
 * so what one instance contributes is those bodies, unchanged. The stamp is
 * therefore the targets' own meshes — a boss fused into its plate stamps the
 * fused body, because that is exactly what the apply will clone.
 *
 * Nothing here opens a shape: the axes resolve to plain values (a picked edge's
 * wrappers are the resolver's own and go back before it returns) and the
 * meshes are read off the scene, so there is no scratch to free.
 */
function buildCopyGhost(
  scene: Scene,
  request: CopyGhostRequest,
  meshConfig: MeshConfig,
): FeatureGhostResult {
  const placed = copyGhostMatrices(scene, request);
  if ('reason' in placed) {
    return { ok: false, reason: placed.reason, surface: placed.surface };
  }
  if (placed.matrices.length === 0) {
    // A count still at one, a spacing still at zero — states the dialog
    // passes through while the user types. Nothing to draw, nothing wrong.
    return { ok: true, solids: [] };
  }
  const targets = targetObjectsAt(scene, request.targets);
  if (targets.length === 0) {
    return { ok: false, reason: 'That solid is not in the rendered scene.' };
  }
  const meshes = stampMeshes(copyTargetSolids(targets), new MeshBuilder(meshConfig));
  if (meshes.length === 0) {
    return { ok: false, reason: 'That statement has no solid to copy.' };
  }
  // Every target rides in one body per instance: they move together, and the
  // overlay draws a mesh list whatever it was gathered from.
  return {
    ok: true,
    solids: placed.matrices.map(matrix => ({ meshes: transformMeshes(meshes, matrix) })),
  };
}

/**
 * Where the clones land, or why the request names an axis the scene no longer
 * holds. As with the repeat, the cap is applied to the *stated* count first,
 * before a grid is materialized — a mistyped count must refuse, not allocate.
 */
function copyGhostMatrices(
  scene: Scene,
  request: CopyGhostRequest,
): { matrices: Matrix4[] } | { reason: string; surface?: boolean } {
  const total = requestedInstanceCount(request);
  if (total > MAX_GHOST_INSTANCES) {
    // The one refusal here the user can do something about, and the one where
    // drawing nothing would look broken rather than unfinished.
    return { reason: `${total} instances is more than the preview draws.`, surface: true };
  }

  const axes: Axis[] = [];
  for (const ref of request.axes) {
    const axis = resolveGhostAxis(scene, ref);
    if (!axis) {
      return { reason: 'That axis is not in the rendered scene.' };
    }
    axes.push(axis);
  }
  if (axes.length === 0) {
    return { matrices: [] };
  }
  if (request.kind === 'circular') {
    return {
      matrices: request.sweep
        ? buildCircularCopyGhostMatrices(
          axes[0], request.count ?? 0, request.sweep, request.centered,
          // A circular skip names one instance per entry — the tuple form the
          // wire carries for both kinds, read back as the indices it is.
          (request.skip ?? []).map(tuple => tuple[0]),
        )
        : [],
    };
  }
  // Linear: one axis per direction. A mismatch is a malformed request the
  // route rejects; here it simply lays nothing out.
  if (axes.length !== request.directions.length) {
    return { matrices: [] };
  }
  const directions: RepeatGhostDirection[] = request.directions.map((direction, i) => ({
    axis: axes[i],
    count: direction.count,
    offset: directionOffset(direction),
  }));
  return { matrices: buildLinearCopyGhostMatrices(directions, request.centered, request.skip ?? []) };
}

/**
 * The bodies a copy's targets hand it. `copy()` reads `getShapes()` at its own
 * point in the file, but the ghost reads the finished scene — where a feature
 * FURTHER DOWN may already have consumed the very body the copy would clone,
 * and in an edit dialog that consumer is often the copy itself. Re-reading with
 * an empty removal scope means "no removal applies" and brings those bodies
 * back, the same blind spot {@link profileEdges} works around for the swept
 * features. The Set dedupes a container target, which reports its children's
 * solids as its own.
 */
function copyTargetSolids(targets: SceneObject[]): Shape[] {
  const solids: Shape[] = [];
  for (const target of targets) {
    const live = target.getShapes(undefined, 'solid');
    solids.push(...(live.length > 0
      ? live
      : target.getShapes(undefined, 'solid', new Set<SceneObject>())));
  }
  return [...new Set(solids)];
}

/** The bodies to mesh, or why the request names something the scene lost. */
type GhostBuild = { solids: Shape[]; scratch: Shape[] } | { reason: string };

/** The single-profile features: one sketch in, its swept body out. */
function buildProfileGhost(
  scene: Scene,
  request: ExtrudeGhostRequest | RevolveGhostRequest,
): GhostBuild {
  const profile = findProfile(scene, request.profile);
  if (!profile) {
    return { reason: 'That sketch is not in the rendered scene.' };
  }
  const plane = profile.getPlane();
  if (!plane) {
    return { reason: 'The profile has no plane.' };
  }

  const geometries = profileEdges(profile);
  const source = { getGeometries: () => geometries, getPlane: () => plane };

  if (request.feature === 'revolve') {
    const axis = resolveGhostAxis(scene, request.axis);
    if (!axis) {
      return { reason: 'That axis is not in the rendered scene.' };
    }
    return buildRevolveGhostSolids(source, {
      op: request.op,
      angle: request.angle,
      thin: request.thin,
      axis,
    });
  }
  return buildExtrudeGhostSolids(source, {
    op: request.op,
    distance: request.distance,
    distance2: request.distance2,
    symmetric: request.symmetric,
    draft: request.draft,
    drill: request.drill,
    thin: request.thin,
    throughAllLength: throughAllGhostLength(scene, geometries, plane),
  });
}

/**
 * The rib branch: the spine sketch, plus the scope solids the wall conforms
 * to — named statements when the dialog holds scope chips, every scene solid
 * otherwise (the kernel's own default). The scope solids are read through the
 * {@link copyTargetSolids} blind-spot fallback: in an edit dialog the rib
 * being edited has already fused with (and consumed) the very solids its
 * scope names.
 */
function buildRibGhost(scene: Scene, request: RibGhostRequest): GhostBuild {
  const spine = findProfile(scene, request.spine);
  if (!spine) {
    return { reason: 'That sketch is not in the rendered scene.' };
  }
  const plane = spine.getPlane();
  if (!plane) {
    return { reason: 'The spine has no plane.' };
  }

  // Edit mode: the scene holds the applied rib itself, fused into the very
  // solids the scope names. Read the scope as of just before that statement —
  // a removal scope of every OTHER object applies the earlier features'
  // consumption (box → shell → fillet) but unwinds the rib's own.
  const excluded = request.exclude
    ? new Set(objectsAt(scene, request.exclude))
    : null;
  const removalScope = excluded && excluded.size > 0
    ? new Set(allObjects(scene).filter(obj => !excluded.has(obj)))
    : undefined;

  let scopeShapes: Shape[];
  if (request.scope.length > 0) {
    const targets: SceneObject[] = [];
    for (const ref of request.scope) {
      const objects = objectsAt(scene, ref).filter(obj => !obj.isContainer());
      if (objects.length === 0) {
        return { reason: 'That scope solid is not in the rendered scene.' };
      }
      targets.push(...objects);
    }
    scopeShapes = removalScope
      ? [...new Set(targets.flatMap(t => t.getShapes(undefined, 'solid', removalScope)))]
      : copyTargetSolids(targets);
  } else if (removalScope) {
    scopeShapes = scene.getSceneObjects()
      .filter(obj => !obj.isContainer() && !excluded!.has(obj))
      .flatMap(obj => obj.getShapes(undefined, 'solid', removalScope));
  } else {
    scopeShapes = sceneSolids(scene);
  }
  if (scopeShapes.length === 0) {
    return { reason: 'The rib has no solids to conform to.' };
  }

  const geometries = profileEdges(spine);
  return buildRibGhostSolids(
    { getGeometries: () => geometries, getPlane: () => plane },
    scopeShapes,
    {
      thickness: request.thickness,
      parallel: request.parallel,
      extend: request.extend,
      draft: request.draft,
    },
  );
}

/**
 * The sweep branch: one profile, plus a spine the path slot names. Resolving
 * that spine builds shapes — the wire itself, and edge wrappers off the picked
 * solids — so, as with the loft, the scratch is opened here and handed on to
 * the caller, or freed on the spot when the answer is a refusal.
 */
function buildSweepGhost(scene: Scene, request: SweepGhostRequest): GhostBuild {
  const profile = findProfile(scene, request.profile);
  if (!profile) {
    return { reason: 'That sketch is not in the rendered scene.' };
  }
  const plane = profile.getPlane();
  if (!plane) {
    return { reason: 'The profile has no plane.' };
  }

  const scratch: Shape[] = [];
  let solids: Shape[] | null = null;
  try {
    const path = resolveGhostPath(scene, request.path, scratch);
    if (!path) {
      return { reason: 'That path is not in the rendered scene.' };
    }
    const geometries = profileEdges(profile);
    const built = buildSweepGhostSolids(
      { getGeometries: () => geometries, getPlane: () => plane },
      { op: request.op, thin: request.thin, path },
    );
    scratch.push(...built.scratch);
    solids = built.solids;
    return { solids, scratch };
  } finally {
    // Set only on the one path that hands the scratch on; a refusal or a
    // throw leaves it null and frees everything resolved so far.
    if (!solids) {
      for (const shape of scratch) {
        shape.dispose();
      }
    }
  }
}

/**
 * The spine a ghost sweep runs along, as `Sweep.getSpineWire` would build it
 * (sweep.ts:224 → `wireFromSceneObjectEdges`): every edge the slot names,
 * joined into one wire. A named source reads back the edges the edited sweep
 * has already consumed, for the same reason {@link profileEdges} does; picked
 * edges are wrapped fresh off the shapes they were picked on. Null means the
 * scene no longer holds what the slot names — and a throw out of the wire
 * maker means the picks don't join up, which mid-composition is ordinary: the
 * apply would refuse it too, so the dialog just shows no ghost.
 */
function resolveGhostPath(scene: Scene, ref: GhostPathRef, scratch: Shape[]): Wire | null {
  const edges: Edge[] = [];
  if (ref.kind === 'wire') {
    const source = findWireSource(scene, ref);
    if (!source) {
      return null;
    }
    edges.push(...wireSourceEdges(source));
  } else {
    for (const entity of ref.entities) {
      const edge = resolvePickedEdge(scene, entity, scratch);
      if (!edge) {
        return null;
      }
      edges.push(edge);
    }
  }
  if (edges.length === 0) {
    return null;
  }
  const wire = WireOps.makeWireFromEdges(edges);
  scratch.push(wire);
  return wire;
}

/**
 * The loft branch: resolve every section and rail the dialog's chips name,
 * then skin through them. Unlike the single-profile features, resolution
 * itself builds shapes — face wrappers off the picked solids, wires off the
 * guides — so the scratch is opened here and handed on to the caller, or
 * freed on the spot when the answer is a refusal.
 */
function buildLoftGhost(scene: Scene, request: LoftGhostRequest): GhostBuild {
  const scratch: Shape[] = [];
  let solids: Shape[] | null = null;
  try {
    const profiles = resolveSections(scene, request.profiles, scratch);
    if (!profiles) {
      return { reason: 'That profile is not in the rendered scene.' };
    }
    const guides = resolveGuideWires(scene, request.guides, scratch);
    if (!guides) {
      return { reason: 'That guide is not in the rendered scene.' };
    }
    const built = buildLoftGhostSolids(profiles, {
      op: request.op,
      thin: request.thin,
      guides,
      startCondition: toEndCondition(request.startCondition),
      endCondition: toEndCondition(request.endCondition),
    });
    scratch.push(...built.scratch);
    solids = built.solids;
    return { solids, scratch };
  } finally {
    // Set only on the one path that hands the scratch on; a refusal or a
    // throw leaves it null and frees everything resolved so far.
    if (!solids) {
      for (const shape of scratch) {
        shape.dispose();
      }
    }
  }
}

/** The loft's sections, in argument order — null if any is no longer there. */
function resolveSections(
  scene: Scene,
  refs: GhostSectionRef[],
  scratch: Shape[],
): LoftGhostProfile[] | null {
  const profiles: LoftGhostProfile[] = [];
  for (const ref of refs) {
    if (ref.kind === 'sketch') {
      const profile = findProfile(scene, ref);
      const plane = profile?.getPlane();
      if (!profile || !plane) {
        return null;
      }
      profiles.push({ kind: 'sketch', geometries: profileEdges(profile), plane });
      continue;
    }
    const faces: Face[] = [];
    for (const entity of ref.entities) {
      const face = resolvePickedFace(scene, entity, scratch);
      if (!face) {
        return null;
      }
      faces.push(face);
    }
    if (faces.length === 0) {
      return null;
    }
    profiles.push({ kind: 'faces', faces });
  }
  return profiles;
}

/**
 * The face a viewport pick names, as a fresh wrapper over the scene solid's
 * geometry. Every face of that solid is wrapped to reach the indexed one — the
 * mesh-order universe picks address — so all of them join the scratch; the
 * solid itself is untouched.
 */
function resolvePickedFace(
  scene: Scene,
  ref: { shapeId: string; index: number },
  scratch: Shape[],
): Face | null {
  const shape = findShapeById(scene, ref.shapeId);
  if (!shape) {
    return null;
  }
  const faces = Explorer.findFacesWrapped(shape);
  scratch.push(...faces);
  const face = faces[ref.index];
  return face instanceof Face ? face : null;
}

/**
 * The rails, as the wires `loft.guides()` would build from each statement's
 * edges (loft.ts:229 → `wiresFromSceneObjectEdges`). One guide argument can
 * carry several separate curves, and each connected chain counts as its own
 * rail — the kernel refuses more than two, and so does the ghost builder.
 */
function resolveGuideWires(
  scene: Scene,
  refs: { filePath: string; line: number }[],
  scratch: Shape[],
): Wire[] | null {
  const wires: Wire[] = [];
  for (const ref of refs) {
    const source = findWireSource(scene, ref);
    if (!source) {
      return null;
    }
    const edges = wireSourceEdges(source);
    if (edges.length === 0) {
      return null;
    }
    const connected = WireOps.connectEdgesToWires(edges);
    scratch.push(...connected);
    wires.push(...connected);
  }
  return wires;
}

/** The dialog's condition wording, in the kernel's. */
function toEndCondition(condition: GhostLoftCondition | null): LoftEndCondition | null {
  return condition ? { kind: condition.type, magnitude: condition.magnitude } : null;
}

/**
 * The helix branch: read the source slot down to the frame the coil is built
 * in, then build the curve. Resolution wraps subshapes of the picked solid, so
 * — as with the loft — the scratch is opened here and handed on, or freed on
 * the spot when the answer is a refusal.
 */
function buildHelixGhost(scene: Scene, request: HelixGhostRequest): GhostBuild {
  const scratch: Shape[] = [];
  let wires: Shape[] | null = null;
  try {
    const source = resolveHelixGhostSource(scene, request.source, scratch);
    if (!source) {
      return { reason: 'That helix source is not in the rendered scene.' };
    }
    const built = buildHelixGhostWires(source, {
      radius: orUndefined(request.radius),
      endRadius: orUndefined(request.endRadius),
      pitch: orUndefined(request.pitch),
      turns: orUndefined(request.turns),
      height: orUndefined(request.height),
      startOffset: orUndefined(request.startOffset),
      endOffset: orUndefined(request.endOffset),
    });
    scratch.push(...built.scratch);
    wires = built.wires;
    return { solids: wires, scratch };
  } finally {
    // Set only on the path that hands the scratch on; a refusal or a throw
    // leaves it null and frees everything resolved so far.
    if (!wires) {
      for (const shape of scratch) {
        shape.dispose();
      }
    }
  }
}

/**
 * The frame a ghost helix coils in. The axis forms resolve exactly as the
 * revolve's do — including a picked edge, which the helix dialog writes as
 * `axis(<edge>)`. A picked face and a bare edge source are read the way
 * `Helix.build` reads them, through the shared resolvers, so a cylinder's own
 * radius and V-extent still stand in for the fields the dialog leaves empty.
 * Null means the scene no longer holds what the slot names.
 */
function resolveHelixGhostSource(
  scene: Scene,
  ref: GhostHelixSourceRef,
  scratch: Shape[],
): HelixSourceKind | null {
  if (ref.kind === 'standard') {
    return { kind: 'axis', axis: toAxis(ref.axis) };
  }
  if (ref.kind === 'axis') {
    const obj = findByLocation(scene, ref, o => o instanceof AxisObjectBase);
    const axis = (obj as AxisObjectBase | null)?.getAxis();
    return axis ? { kind: 'axis', axis } : null;
  }
  if (ref.kind === 'face') {
    const face = resolvePickedFace(scene, ref, scratch);
    if (!face) {
      return null;
    }
    // A face that is neither cylindrical nor conical refuses — the apply would
    // refuse too, so the dialog shows nothing rather than a curve it can't get.
    try {
      return resolveHelixFaceSource(face);
    } catch {
      return null;
    }
  }
  const edge = resolvePickedEdge(scene, ref, scratch);
  if (!edge) {
    return null;
  }
  try {
    return ref.kind === 'axis-edge'
      ? { kind: 'axis', axis: EdgeOps.edgeToAxis(edge) }
      : resolveHelixEdgeSource(edge);
  } catch {
    // Not a straight edge (the axis form), or neither line nor circle.
    return null;
  }
}

/**
 * The edge a viewport pick names, as a fresh wrapper over the scene solid's
 * geometry — the edge sibling of {@link resolvePickedFace}. Every edge of that
 * solid is wrapped to reach the indexed one, so all of them join the scratch;
 * the solid itself is untouched.
 */
function resolvePickedEdge(
  scene: Scene,
  ref: { shapeId: string; index: number },
  scratch: Shape[],
): Edge | null {
  const shape = findShapeById(scene, ref.shapeId);
  if (!shape) {
    return null;
  }
  const edges = Explorer.findEdgesWrapped(shape);
  scratch.push(...edges);
  const edge = edges[ref.index];
  return edge instanceof Edge ? edge : null;
}

/** An omitted dialog field, in the kernel's wording — null in, default out. */
function orUndefined(value: number | null): number | undefined {
  return value ?? undefined;
}

/**
 * The sketch a `{filePath, line}` ref names. Source locations on scene
 * objects can still carry the live-render buffer's `virtual:` prefix, so both
 * sides are normalized before comparing. A `sketch()` and its own entities
 * never share a line, but a container's children are walked too — a sketch
 * nested in a `part()` is only reachable through its parent in some scenes.
 */
function findProfile(
  scene: Scene,
  ref: { filePath: string; line: number },
): Extrudable | null {
  let fallback: Extrudable | null = null;
  for (const obj of objectsAt(scene, ref)) {
    if (!obj.isExtrudable()) {
      continue;
    }
    const extrudable = obj as Extrudable;
    if (obj.getType() === 'sketch') {
      return extrudable;
    }
    // A bare extrudable primitive (a `rect()` bound outside a sketch) shares
    // the line only when no sketch does — keep it, prefer the sketch.
    fallback = fallback ?? extrudable;
  }
  return fallback;
}

/**
 * The wire statement a loft guide or a sweep path names: a sketch or a helix,
 * the two things `loft.guides()` accepts (feature-sources.ts:178) and the two
 * the sweep dialog's path slot offers.
 */
function findWireSource(scene: Scene, ref: { filePath: string; line: number }): SceneObject | null {
  return objectsAt(scene, ref)
    .find(obj => obj.getType() === 'sketch' || obj.getType() === 'helix') ?? null;
}

/**
 * Every object in the scene: the top-level list plus containers' children. A
 * sketch nested in a `part()` is only reachable through its parent in some
 * scenes, so nothing here may read the flat list alone.
 */
function allObjects(scene: Scene): SceneObject[] {
  const seen = new Set<SceneObject>();
  const stack: SceneObject[] = [...scene.getSceneObjects()];
  const objects: SceneObject[] = [];
  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (seen.has(obj)) {
      continue;
    }
    seen.add(obj);
    objects.push(obj);
    stack.push(...obj.getChildren());
  }
  return objects;
}

/**
 * Every object whose statement sits at a `{filePath, line}` ref. Source
 * locations on scene objects can still carry the live-render buffer's
 * `virtual:` prefix, so both sides are normalized before comparing.
 */
function objectsAt(scene: Scene, ref: { filePath: string; line: number }): SceneObject[] {
  const target = normalizeSourcePath(ref.filePath);
  return allObjects(scene).filter(obj => {
    const loc = obj.getSourceLocation();
    return !!loc && loc.line === ref.line && normalizeSourcePath(loc.filePath) === target;
  });
}

/**
 * The axis a revolve ghost sweeps around. The three slot states resolve
 * differently: a world axis is a constant, an `axis()` statement is read off
 * the scene object at its call site — including one the edited revolve has
 * already consumed, since consumption removes its guide line but not its
 * stored axis — and a picked edge is turned into an axis the way `axis(<edge
 * selector>)` would at build time. Null means the ghost has nothing to sweep
 * around: the scene moved on, or the picked edge isn't a straight line.
 */
function resolveGhostAxis(scene: Scene, ref: GhostAxisRef): Axis | null {
  if (ref.kind === 'standard') {
    return toAxis(ref.axis);
  }
  if (ref.kind === 'axis') {
    const obj = findByLocation(scene, ref, o => o instanceof AxisObjectBase);
    return (obj as AxisObjectBase | null)?.getAxis() ?? null;
  }
  const shape = findShapeById(scene, ref.shapeId);
  if (!shape) {
    return null;
  }
  // Fresh wrappers over the picked solid's edges — build-time temporaries
  // this function solely owns, so they go back before it returns. The scene
  // shape they explore is untouched.
  const edges = Explorer.findEdgesWrapped(shape);
  try {
    const edge = edges[ref.index];
    return edge ? EdgeOps.edgeToAxis(edge) : null;
  } catch {
    // Not a straight edge — nothing to revolve around.
    return null;
  } finally {
    for (const edge of edges) {
      edge.dispose();
    }
  }
}

/**
 * The plane a mirror ghost reflects across — the plane sibling of
 * {@link resolveGhostAxis}, and its three slot states resolve the same way: an
 * origin plane is a constant, a `plane()` statement is read off the scene
 * object at its call site (including one the edited repeat has consumed, since
 * consumption removes its quad but not its stored plane), and a picked face
 * gives up its own plane, the way `repeat('mirror', select(face(…)))` reads it
 * at build time (plane-from-object.ts:175). Null means the scene no longer
 * holds what the slot names — or the face is curved, and has no plane to
 * mirror across at all.
 */
function resolveGhostPlane(scene: Scene, ref: GhostPlaneRef, scratch: Shape[]): Plane | null {
  if (ref.kind === 'standard') {
    return toPlane(ref.plane);
  }
  if (ref.kind === 'plane') {
    const obj = findByLocation(scene, ref, o => o instanceof PlaneObjectBase);
    return (obj as PlaneObjectBase | null)?.getPlane() ?? null;
  }
  const face = resolvePickedFace(scene, ref, scratch);
  if (!face || !FaceQuery.isPlanarFace(face)) {
    return null;
  }
  try {
    return face.getPlane();
  } catch {
    return null;
  }
}

/** The scene object at a `{filePath, line}` ref matching `accept`. */
function findByLocation(
  scene: Scene,
  ref: { filePath: string; line: number },
  accept: (obj: SceneObject) => boolean,
): SceneObject | null {
  return objectsAt(scene, ref).find(accept) ?? null;
}

/** The scene shape a viewport pick's `shapeId` names. */
function findShapeById(scene: Scene, shapeId: string): Shape | null {
  for (const obj of allObjects(scene)) {
    for (const shape of obj.getAddedShapes()) {
      if (shape.id === shapeId) {
        return shape;
      }
    }
  }
  return null;
}

/**
 * The profile's edges, a profile the edited statement already consumed
 * included. `Sketch.getGeometries()` reads through `getShapes()`, which hides
 * every shape a consumer recorded as removed — and in the edit dialog that
 * consumer is the very statement being edited, so its own profile would read
 * back empty and the ghost would never show. Re-reading with an empty removal
 * scope means "no removal applies" and brings those edges back. The Set
 * dedupes the lazy-accessor and `select()` children, which share `Edge`
 * instances with the primitive that built them.
 */
function profileEdges(profile: Extrudable): Edge[] {
  const edges = profile.getGeometries();
  return edges.length > 0 ? edges : unconsumedEdges(profile);
}

/**
 * A guide or path statement's edges — the same blind spot as
 * {@link profileEdges}, for the same reason: the loft being edited has
 * consumed its own rails, the sweep its own spine, and a ghost built without
 * them would show a surface the apply never produces.
 */
function wireSourceEdges(source: SceneObject): Edge[] {
  const edges = onlyEdges(source.getShapes(undefined, 'edge'));
  return edges.length > 0 ? edges : unconsumedEdges(source);
}

/** The object's edges read as if no consumer had removed anything. */
function unconsumedEdges(source: SceneObject): Edge[] {
  return onlyEdges(source.getShapes(undefined, 'edge', new Set<SceneObject>()));
}

function onlyEdges(shapes: Shape[]): Edge[] {
  return [...new Set(shapes)].filter((s): s is Edge => s instanceof Edge);
}

/** Paths travel with a `virtual:live-render:` prefix mid-edit; ids don't. */
function normalizeSourcePath(filePath: string | undefined): string {
  return (filePath ?? '').replace('virtual:live-render:', '').replace(/\\/g, '/');
}

/**
 * How far a through-all ghost has to run to clear the model. The kernel's cut
 * uses a flat 100 m stand-in for infinity, which as a *ghost* would swallow
 * the viewport — so measure the scene's solids along the sketch normal
 * instead and add a margin. With nothing to cut through, the profile's own
 * size keeps the ghost in frame.
 */
function throughAllGhostLength(scene: Scene, geometries: Edge[], plane: Plane): number {
  let reach = 0;
  for (const solid of sceneSolids(scene)) {
    reach = Math.max(reach, normalReach(ShapeOps.getBoundingBox(solid), plane));
  }
  if (reach === 0) {
    for (const edge of geometries) {
      reach = Math.max(reach, boxDiagonal(ShapeOps.getBoundingBox(edge)));
    }
  }
  return reach > 0 ? reach * THROUGH_ALL_MARGIN : THROUGH_ALL_FALLBACK;
}

/** The model's solids — containers are skipped, their children are listed too. */
function sceneSolids(scene: Scene): Shape[] {
  const solids: Shape[] = [];
  for (const obj of scene.getSceneObjects()) {
    if (obj.isContainer()) {
      continue;
    }
    solids.push(...obj.getShapes(undefined, 'solid'));
  }
  return solids;
}

/** The farthest a box's corners sit from the plane, along its normal. */
function normalReach(box: BoundingBox, plane: Plane): number {
  const origin = plane.origin;
  const n = plane.normal;
  let reach = 0;
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) {
        const d = (x - origin.x) * n.x + (y - origin.y) * n.y + (z - origin.z) * n.z;
        reach = Math.max(reach, Math.abs(d));
      }
    }
  }
  return reach;
}

function boxDiagonal(box: BoundingBox): number {
  const dx = box.maxX - box.minX;
  const dy = box.maxY - box.minY;
  const dz = box.maxZ - box.minZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
