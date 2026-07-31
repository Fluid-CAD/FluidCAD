import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { Solid } from "../common/solid.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { buildExtrudeGhostSolids } from "../features/extrude-ghost.js";
import { buildFilletGhostBands } from "../features/fillet-ghost.js";
import { buildLoftGhostSolids, LoftGhostProfile } from "../features/loft-ghost.js";
import { buildRevolveGhostSolids } from "../features/revolve-ghost.js";
import { Extrudable, BoundingBox } from "../helpers/types.js";
import { Axis, StandardAxis, toAxis } from "../math/axis.js";
import { Plane } from "../math/plane.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import type { LoftEndCondition } from "../oc/loft-ops.js";
import type { MeshConfig } from "../oc/mesh.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { MeshBuilder } from "./mesh-builder.js";
import { renderFacePatch } from "./render-face.js";
import { Scene, SceneObjectMesh } from "./scene.js";

/**
 * A dialog's live geometry request, every value already resolved to a number
 * (expression resolution is the server's job — the kernel never parses code).
 * Discriminated on `feature` so later features add a branch, not an endpoint.
 */
export type FeatureGhostRequest =
  | ExtrudeGhostRequest
  | RevolveGhostRequest
  | LoftGhostRequest
  | FilletGhostRequest;

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
 * One ghost body, in the same mesh wire format a rendered solid uses. `kind`
 * overrides the overlay's per-dialog color for this body alone — a fillet's
 * picks can take material away at one edge and put it back at the next, so the
 * two have to be told apart within a single answer. The swept features leave it
 * unset and the whole ghost takes the dialog's own add/remove color.
 */
export type GhostSolid = { meshes: SceneObjectMesh[]; kind?: 'add' | 'remove' };

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
  // Each arm tests its own feature so the union narrows — `FilletGhostRequest`
  // is keyed on TWO literals, which a negative test can't rule out.
  if (request.feature === 'extrude' || request.feature === 'revolve') {
    return meshGhostBodies(buildProfileGhost(scene, request), meshConfig);
  }
  if (request.feature === 'loft') {
    return meshGhostBodies(buildLoftGhost(scene, request), meshConfig);
  }
  return buildBandGhost(scene, request, meshConfig);
}

/** Mesh the swept features' bodies, then free every shape they were built from. */
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
  const groups = resolvePickedEdges(scene, request.edges);
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
function resolvePickedEdges(
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
 * The wire statement a loft guide names: a sketch or a helix, the two things
 * `loft.guides()` accepts (feature-sources.ts:178).
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
 * A guide statement's edges — the same blind spot as {@link profileEdges}, for
 * the same reason: the loft being edited has consumed its own rails, and a
 * ghost built without them would show a surface the apply never produces.
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
