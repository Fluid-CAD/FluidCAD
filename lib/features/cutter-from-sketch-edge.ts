import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { BuildError } from "../common/build-error.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { requireShapes } from "../common/operand-check.js";
import { getOC } from "../oc/init.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { GeometrySceneObject } from "./2d/geometry.js";

/**
 * What a sketched edge cuts with when it seeds a split: a straight line
 * gives the infinite plane that contains it and stands normal to its
 * sketch; any other edge — or several — gives the sheet those edges sweep
 * out of the sketch, extruded along the sketch normal both ways. `center`
 * is where a datum marker is drawn: the line's midpoint, or the middle of
 * the curve's bounds.
 */
export type SketchEdgeCutter =
  | { kind: 'plane'; plane: Plane; center: Point }
  | { kind: 'sheet'; edges: Edge[]; normal: Vector3d; center: Point };

/**
 * The cutter a sketched edge seeds (see {@link SketchEdgeCutter}). The
 * plane's x-direction is the line's own direction and its normal is the
 * line turned a quarter turn inside the sketch (line × sketch normal); a
 * sheet's front is the same quarter turn of the curve's tangent, so in
 * both cases `front` is to the right of the edge when it is travelled from
 * the sketch's front. Chained edges are put head to tail first, so a
 * polyline or a closed loop has one consistent front.
 *
 * Shared with the split ghost, which reads the same edge off the rendered
 * scene. Throws a `BuildError` naming what is wrong with the seed.
 */
export function sketchEdgeCutter(geometry: GeometrySceneObject, consumer = 'split'): SketchEdgeCutter {
  const sketch = geometry.sketch;
  if (!sketch) {
    throw new BuildError(
      `${consumer}: the ${geometry.getType()} is not part of a sketch, so there is no sketch to sweep it out of.`,
      "Seed the split with an edge drawn inside a sketch, or pass a plane.",
    );
  }

  const edges = geometry.getShapes({ excludeGuide: false }).filter(s => s.isEdge()) as Edge[];
  if (edges.length === 0) {
    throw new BuildError(
      `${consumer}: the ${geometry.getType()} has no edge to cut with.`,
      "Seed the split with a sketched line or curve, or pass a plane.",
    );
  }

  const sketchNormal = sketch.getPlane().normal.normalize();

  if (edges.length === 1 && isStraight(edges[0])) {
    const axis = EdgeOps.edgeToAxis(edges[0]);
    const direction = axis.direction.normalize();
    const normal = direction.cross(sketchNormal);
    if (normal.length() < 1e-9) {
      throw new BuildError(`${consumer}: the seed line runs along its sketch normal, which gives no plane.`);
    }
    const start = edges[0].getFirstVertex().toPoint();
    const end = edges[0].getLastVertex().toPoint();
    return {
      kind: 'plane',
      plane: new Plane(start, direction, normal.normalize()),
      center: start.lerp(end, 0.5),
    };
  }

  const chained = chainEdges(edges);
  const bbox = ShapeOps.unionBoundingBoxes(chained.map(edge => ShapeOps.getBoundingBox(edge)));
  return {
    kind: 'sheet',
    edges: chained,
    normal: sketchNormal,
    center: new Point((bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, (bbox.minZ + bbox.maxZ) / 2),
  };
}

function isStraight(edge: Edge): boolean {
  const oc = getOC();
  const adaptor = new oc.BRepAdaptor_Curve(edge.getShape());
  try {
    return adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
  } finally {
    adaptor.delete();
  }
}

/**
 * The edges put head to tail where they connect, each oriented along the
 * chain — what gives a polyline's sheet one front. Edges that do not chain
 * into a wire are kept as drawn.
 */
function chainEdges(edges: Edge[]): Edge[] {
  if (edges.length < 2) {
    return edges;
  }
  const oc = getOC();
  const wireMaker = new oc.BRepBuilderAPI_MakeWire();
  try {
    for (const edge of edges) {
      wireMaker.Add(edge.getShape());
    }
    if (!wireMaker.IsDone()) {
      return edges;
    }
    const ordered = Explorer.findEdgesInWireOrderWrapped(Wire.fromTopoDSWire(wireMaker.Wire()));
    return ordered.length === edges.length ? ordered : edges;
  } catch {
    return edges;
  } finally {
    wireMaker.delete();
  }
}

/**
 * The datum a `split(edge, …)` names: what its seed edge sweeps out of its
 * sketch (see {@link sketchEdgeCutter}). The edge is only referenced —
 * never consumed — so it stays with its sketch for a constraint or a later
 * feature; the split itself hides the sketch for display, as an extrude
 * does its profile. A construction (guide) edge is accepted, since that is
 * what a split seed usually is. Internal: it has no row of its own, and its
 * failure is reported on the split.
 */
export class CutterFromSketchEdge extends SceneObject {

  constructor(public readonly geometry: GeometrySceneObject) {
    super();
  }

  override validate() {
    requireShapes(this.geometry, "edge", "split", { filter: { excludeGuide: false } });
  }

  build(_context?: BuildSceneObjectContext) {
    // The edges are already where their (possibly cloned) sketch put them;
    // nothing to transform here.
    this.setState('cutter', sketchEdgeCutter(this.geometry));
  }

  /** The cutter as built, or null before the build (or after a failed one). */
  getCutter(): SketchEdgeCutter | null {
    return (this.getState('cutter') as SketchEdgeCutter | undefined) ?? null;
  }

  /** The plane a straight seed line gives; null for a curve's sheet. */
  getPlane(): Plane | null {
    const cutter = this.getCutter();
    return cutter?.kind === 'plane' ? cutter.plane : null;
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    // The cloned sketch's own edge, when the clone has one; the copy reads
    // its edges where the clone put them.
    const geometry = (remap.get(this.geometry) as GeometrySceneObject | undefined) ?? this.geometry;
    return new CutterFromSketchEdge(geometry);
  }

  compareTo(other: CutterFromSketchEdge): boolean {
    if (!(other instanceof CutterFromSketchEdge)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.geometry.compareTo(other.geometry);
  }

  getType(): string {
    return 'split-cutter';
  }

  getUniqueType(): string {
    return 'cutter-from-sketch-edge';
  }

  serialize() {
    const cutter = this.getCutter();
    if (!cutter) {
      return {};
    }
    if (cutter.kind === 'plane') {
      return {
        kind: 'plane',
        origin: cutter.plane.origin,
        xDirection: cutter.plane.xDirection,
        yDirection: cutter.plane.yDirection,
        normal: cutter.plane.normal,
        center: cutter.center,
      };
    }
    return { kind: 'sheet', normal: cutter.normal, center: cutter.center, edges: cutter.edges.length };
  }
}
