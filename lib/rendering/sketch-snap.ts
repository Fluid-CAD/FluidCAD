import { Scene } from "./scene.js";
import { Shape } from "../common/shape.js";
import { Sketch } from "../features/2d/sketch.js";
import { Part } from "../features/part.js";
import { Plane } from "../math/plane.js";
import { SectionOps } from "../oc/section-ops.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeQuery } from "../oc/edge-query.js";

/** Matches the snap dedup tolerance the sketcher UI uses for mesh vertices. */
const DEDUP_EPSILON_SQ = 1e-6;

/**
 * A closed section loop (the plane passing clean through a bore or boss) has
 * coincident chain ends at an arbitrary seam parameter — not a model crossing.
 */
const SEAM_EPSILON_SQ = 1e-12;

/** Shape types with area — the only ones a plane section can cross. */
const SECTIONABLE_TYPES = new Set(["solid", "shell", "face", "compound"]);

// Cached scene objects keep their Shape instances by reference across
// incremental renders, so an entry stays valid for exactly as long as the
// snapped shape does; replaced shapes fall out with their wrapper.
const snapCache = new WeakMap<Shape, { planeKey: string; vertices: [number, number][] }>();

/**
 * Give the interactive sketcher snap targets from the rest of the scene,
 * without drawing anything. Runs after a full render: when the tip object is
 * a sketch (the only state the sketch UI activates on), every prior shape
 * contributes plane-local 2D points on the sketch's rendered payload — where
 * the sketch plane slices it (the vertices an intersect() statement would
 * produce, plus the centers of circular crossings like bores and bosses) and
 * the projection of its topological vertices and circular-edge centers onto
 * the plane (the model corners and hole/arc centers the user sees behind the
 * sketch in the look-down-the-normal view).
 */
export function attachSketchSnapVertices(scene: Scene): void {
  const sketch = findTipSketch(scene);
  if (!sketch) {
    return;
  }
  const rendered = scene.getRenderedObject(sketch);
  if (!rendered) {
    return;
  }

  let plane: Plane | null = null;
  try {
    plane = sketch.getPlane();
  } catch {
    return;
  }
  if (!plane) {
    return;
  }

  // The 2D projection depends on the full frame, not just the carrier plane.
  const o = plane.origin;
  const x = plane.xDirection;
  const y = plane.yDirection;
  const planeKey = `${o.x},${o.y},${o.z}|${x.x},${x.y},${x.z}|${y.x},${y.y},${y.z}`;

  const vertices: [number, number][] = [];
  for (const shape of collectSnapSources(scene, sketch)) {
    for (const v of snapVerticesFor(shape, plane, planeKey)) {
      pushUnique(vertices, v);
    }
  }

  if (vertices.length > 0) {
    rendered.snapVertices = vertices;
  }
}

/**
 * The sketch the UI would activate on: the last top-level object (part
 * children count as top-level, mirroring the viewer's isTopLevel), if it is
 * a sketch. During interactive sketching the build is truncated at the
 * sketch — by a breakpoint or by it being the tip statement — so this finds
 * exactly the sketch being edited and nothing on ordinary renders.
 */
function findTipSketch(scene: Scene): Sketch | null {
  const objects = scene.getAllSceneObjects();
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    const parent = obj.getParent();
    if (parent && !(parent instanceof Part)) {
      continue;
    }
    return obj instanceof Sketch ? obj : null;
  }
  return null;
}

function collectSnapSources(scene: Scene, sketch: Sketch): Set<Shape> {
  const shapes = new Set<Shape>();
  // Deliberately not part-scoped: snap targets are coordinate hints, not
  // references, so other parts' geometry is fair game — same as top level.
  for (const obj of scene.getActiveSceneObjectsUpTo(sketch)) {
    // Containers re-expose their children's shapes and lazy accessors /
    // selects re-expose other objects' — only owning objects contribute.
    if (obj.isContainer() || obj.isLazy() || obj.isSelection()) {
      continue;
    }
    for (const shape of obj.getShapes()) {
      shapes.add(shape);
    }
  }
  return shapes;
}

function snapVerticesFor(shape: Shape, plane: Plane, planeKey: string): [number, number][] {
  const cached = snapCache.get(shape);
  if (cached && cached.planeKey === planeKey) {
    return cached.vertices;
  }

  const vertices: [number, number][] = [];
  try {
    if (SECTIONABLE_TYPES.has(shape.getType())) {
      collectSectionVertices(shape, plane, vertices);
    }
    collectProjectedVertices(shape, plane, vertices);
    collectProjectedCurveCenters(shape, plane, vertices);
  } catch {
    // Snap targets are best-effort — a failure must never break a render.
    // Cache the (possibly partial) result so it isn't retried on every
    // incremental render.
  }

  snapCache.set(shape, { planeKey, vertices });
  return vertices;
}

/** Open endpoints of the plane's section through the shape. */
function collectSectionVertices(shape: Shape, plane: Plane, out: [number, number][]): void {
  for (const edge of SectionOps.sectionShapeWithPlane(plane, shape)) {
    // A circular section edge is the plane crossing a bore or boss — its
    // center is the axis crossing, snappable even when the loop is closed
    // and contributes no endpoints. Section curves lie in the plane, so
    // worldToLocal is exact here.
    if (EdgeQuery.getEdgeCurveType(edge) === "circle") {
      const center = plane.worldToLocal(EdgeQuery.getCircleDataFromEdge(edge).center);
      pushUnique(out, [center.x, center.y]);
    }

    const first = edge.getFirstVertex();
    const last = edge.getLastVertex();
    const p1 = first.toPoint();
    const p2 = last.toPoint();
    first.dispose();
    last.dispose();
    edge.dispose();

    if (p1.distanceToSquared(p2) < SEAM_EPSILON_SQ) {
      continue;
    }

    const l1 = plane.worldToLocal(p1);
    const l2 = plane.worldToLocal(p2);
    pushUnique(out, [l1.x, l1.y]);
    pushUnique(out, [l2.x, l2.y]);
  }
}

/** The shape's topological vertices, projected orthogonally onto the plane. */
function collectProjectedVertices(shape: Shape, plane: Plane, out: [number, number][]): void {
  for (const vertex of Explorer.findVerticesWrapped(shape)) {
    const point = vertex.toPoint();
    vertex.dispose();
    const local = plane.worldToLocal(point);
    pushUnique(out, [local.x, local.y]);
  }
}

/**
 * Centers of the shape's circular edges — full circles and open arcs alike
 * (GeomAbs_Circle covers both) — projected orthogonally onto the plane.
 * Rim circles of holes and bosses land on their axis; fillet and slot arcs
 * land on the point a concentric feature would be placed at.
 */
function collectProjectedCurveCenters(shape: Shape, plane: Plane, out: [number, number][]): void {
  for (const edge of Explorer.findEdgesWrapped(shape)) {
    if (EdgeQuery.getEdgeCurveType(edge) === "circle") {
      const local = plane.worldToLocal(EdgeQuery.getCircleDataFromEdge(edge).center);
      pushUnique(out, [local.x, local.y]);
    }
    edge.dispose();
  }
}

function pushUnique(vertices: [number, number][], v: [number, number]): void {
  for (const p of vertices) {
    const dx = p[0] - v[0];
    const dy = p[1] - v[1];
    if (dx * dx + dy * dy < DEDUP_EPSILON_SQ) {
      return;
    }
  }
  vertices.push(v);
}
