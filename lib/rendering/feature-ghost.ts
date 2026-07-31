import { Edge } from "../common/edge.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { buildExtrudeGhostSolids } from "../features/extrude-ghost.js";
import { buildRevolveGhostSolids } from "../features/revolve-ghost.js";
import { Extrudable, BoundingBox } from "../helpers/types.js";
import { Axis, StandardAxis, toAxis } from "../math/axis.js";
import { Plane } from "../math/plane.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import type { MeshConfig } from "../oc/mesh.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { MeshBuilder } from "./mesh-builder.js";
import { Scene, SceneObjectMesh } from "./scene.js";

/**
 * A dialog's live geometry request, every value already resolved to a number
 * (expression resolution is the server's job — the kernel never parses code).
 * Discriminated on `feature` so later features add a branch, not an endpoint.
 */
export type FeatureGhostRequest = ExtrudeGhostRequest | RevolveGhostRequest;

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

/** One ghost body, in the same mesh wire format a rendered solid uses. */
export type GhostSolid = { meshes: SceneObjectMesh[] };

export type FeatureGhostResult =
  | { ok: true; solids: GhostSolid[] }
  | { ok: false; reason: string };

/** How far past the model a through-all ghost runs, as a fraction of its reach. */
const THROUGH_ALL_MARGIN = 1.1;

/** Through-all ghost length when the scene offers nothing to size against. */
const THROUGH_ALL_FALLBACK = 100;

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
  const profile = findProfile(scene, request.profile);
  if (!profile) {
    return { ok: false, reason: 'That sketch is not in the rendered scene.' };
  }
  const plane = profile.getPlane();
  if (!plane) {
    return { ok: false, reason: 'The profile has no plane.' };
  }

  const geometries = profileEdges(profile);
  const source = { getGeometries: () => geometries, getPlane: () => plane };

  let built: { solids: Shape[]; scratch: Shape[] };
  if (request.feature === 'revolve') {
    const axis = resolveGhostAxis(scene, request.axis);
    if (!axis) {
      return { ok: false, reason: 'That axis is not in the rendered scene.' };
    }
    built = buildRevolveGhostSolids(source, {
      op: request.op,
      angle: request.angle,
      thin: request.thin,
      axis,
    });
  } else {
    built = buildExtrudeGhostSolids(source, {
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
  const target = normalizeSourcePath(ref.filePath);
  const seen = new Set<SceneObject>();
  const stack: SceneObject[] = [...scene.getSceneObjects()];
  let fallback: Extrudable | null = null;

  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (seen.has(obj)) {
      continue;
    }
    seen.add(obj);
    stack.push(...obj.getChildren());

    const loc = obj.getSourceLocation();
    if (!loc || loc.line !== ref.line || normalizeSourcePath(loc.filePath) !== target) {
      continue;
    }
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

/** The scene object at a `{filePath, line}` ref matching `accept`. */
function findByLocation(
  scene: Scene,
  ref: { filePath: string; line: number },
  accept: (obj: SceneObject) => boolean,
): SceneObject | null {
  const target = normalizeSourcePath(ref.filePath);
  for (const obj of scene.getAllSceneObjects()) {
    const loc = obj.getSourceLocation();
    if (!loc || loc.line !== ref.line || normalizeSourcePath(loc.filePath) !== target) {
      continue;
    }
    if (accept(obj)) {
      return obj;
    }
  }
  return null;
}

/** The scene shape a viewport pick's `shapeId` names. */
function findShapeById(scene: Scene, shapeId: string): Shape | null {
  for (const obj of scene.getAllSceneObjects()) {
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
  if (edges.length > 0) {
    return edges;
  }
  const unconsumed = profile.getShapes(undefined, 'edge', new Set<SceneObject>());
  return [...new Set(unconsumed)].filter((s): s is Edge => s instanceof Edge);
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
