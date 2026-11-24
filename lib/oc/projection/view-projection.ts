import type { IntCurvesFace_ShapeIntersector, TopAbs_ShapeEnum, TopLoc_Location, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Convert } from "../convert.js";
import { Explorer } from "../explorer.js";
import { FaceOps } from "../face-ops.js";
import { Mesh, bboxDiagonal } from "../mesh.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { IDENTITY_POSE } from "../../math/pose.js";
import type { Pose } from "../../math/pose.js";
import { mmTol } from "../../units/tolerance.js";
import { HiddenLineProjection } from "./hidden-line.js";
import type { HiddenLineEdges, HiddenLineOptions, ViewCurves, ViewShape } from "./hidden-line.js";
import { CoverMesh } from "./cover-mesh.js";
import { EdgeVisibility, MIN_STANDOFF_MM, ViewFrame, ViewPiece } from "./edge-visibility.js";
import type { VisibilityStats } from "./edge-visibility.js";

/**
 * One body of a view: a shape in its own frame and where the view puts it.
 * Bodies placed from one shape must hand in the very same `shape` object —
 * that is how the view knows them for copies.
 */
export interface ViewBody extends ViewShape {
  /** Where the body sits in the world, in the document's unit; where it is when left out. */
  pose?: Pose;
}

/** How a view was computed, for the benchmarks. */
export type ViewStats = VisibilityStats & {
  bodies: number;
  /** Outline runs: one per shape and direction it is seen from. */
  views: number;
  triangles: number;
  curvesMs: number;
  meshMs: number;
  visibilityMs: number;
};

/** Two directions this close are one: copies of a part turned alike share their outlines. */
const SAME_DIRECTION = 1e-9;

/**
 * The meshes cover is read from are finer than the viewer's: their error is
 * the width of the zone where the exact geometry has to be asked, and it has
 * to stay under the standoff or a curved face would never clear its own
 * edges. Two ten-thousandths of the shape's size, between these bounds.
 * Unit: mm.
 */
const MESH_RELATIVE = 2e-4;
const MESH_MIN_MM = 0.001;
const MESH_MAX_MM = 0.02;
const MESH_ANGULAR_RAD = 0.2;

/**
 * The meshes of shapes already drawn, in their own frames: plain numbers,
 * kept for as long as the scene keeps the shape. A part is rarely drawn
 * once — the dialog previews it, then it is exported on several planes —
 * and reading a mesh out of the kernel is the dearest step of a small view.
 */
const MESHES = new WeakMap<TopoDS_Shape, { triangles: Float64Array; triangleFaces: Int32Array; bands: number[] }>();

/** As `OcclusionProbe`: nearer than this a crossing is the point's own surface; a sight line this oblique to a face runs in it. */
const MIN_DEPTH_MM = 1e-3;
const MIN_CROSSING_COS = 1e-3;

/**
 * Hidden-line removal for a view of one shape or a whole assembly, with the
 * kernel doing what it is good at and no more.
 *
 * - **The curves are the kernel's.** Its hidden-line front end finds the
 *   silhouettes of every face for the view's direction and hands back each
 *   crease, silhouette and smooth edge as a stretch of the model's own
 *   curve (`HiddenLineProjection.curves`). What a shape can show depends
 *   only on the direction it is seen from, so copies of one shape turned
 *   alike — or turned about the view direction — share one run, and their
 *   pieces are the run's edges moved into place.
 * - **What is seen is decided here** (`EdgeVisibility`): each piece is cut
 *   where a crease or silhouette crosses it and each stretch is read
 *   against the faces' meshes, with exact sight lines where a mesh cannot be
 *   trusted. The kernel's own hiding pass is never run: it is where a view
 *   of a 40-face piston spent 17 of its 17 seconds and a 29-solid engine
 *   four minutes.
 *
 * The result is the pieces a drawing needs, still exact: a visible stretch
 * is a trimmed stretch of the model's curve.
 */
export class ViewProjection {
  static project(bodies: readonly ViewBody[], plane: Plane, options: HiddenLineOptions = {}): HiddenLineEdges & { stats: ViewStats } {
    const oc = getOC();
    const stats: ViewStats = {
      bodies: bodies.length, views: 0, triangles: 0, curvesMs: 0, meshMs: 0, visibilityMs: 0,
      pieces: 0, crossings: 0, lookups: 0, exactRays: 0,
    };
    const edges: HiddenLineEdges & { stats: ViewStats } = {
      visible: [],
      tangent: [],
      hidden: [],
      stats,
      dispose() {
        Explorer.deleteAll([...this.visible, ...this.tangent, ...this.hidden]);
        this.visible = [];
        this.tangent = [];
        this.hidden = [];
      },
    };

    const frame = new ViewFrame(plane);
    const models = new Map<TopoDS_Shape, ShapeModel>();
    const pieces: { piece: ViewPiece; smooth: boolean }[] = [];
    const locations: TopLoc_Location[] = [];
    try {
      // 1. Each shape's curves, shared between copies seen from one direction.
      let clock = performance.now();
      const placements = bodies.map((body) => {
        const placement = new Placement(body.pose ?? IDENTITY_POSE, plane);
        let model = models.get(body.shape);
        if (!model) {
          model = new ShapeModel(body);
          models.set(body.shape, model);
        }
        placement.model = model;
        placement.curves = model.curvesFrom(placement, options.tangent === true);
        return placement;
      });
      for (const model of models.values()) {
        stats.views += model.views;
      }
      stats.curvesMs = performance.now() - clock;

      // 2. Every face's mesh in the view frame, and every piece moved into place.
      clock = performance.now();
      const bands: number[] = [];
      const faceOwner: { placement: Placement; face: number }[] = [];
      const parts: { triangles: Float64Array; faces: Int32Array; offset: number }[] = [];
      bodies.forEach((body, index) => {
        const placement = placements[index];
        const model = placement.model!;
        model.mesh();
        const offset = bands.length;
        model.bands.forEach((band, face) => {
          bands.push(band);
          faceOwner.push({ placement, face });
        });
        parts.push({ triangles: placement.inView(model.triangles, plane), faces: model.triangleFaces, offset });

        const [trsf, disposeTrsf] = Convert.toGpTrsfPose((body.pose ?? IDENTITY_POSE).position, (body.pose ?? IDENTITY_POSE).quaternion);
        const location = new oc.TopLoc_Location(trsf);
        disposeTrsf();
        locations.push(location);
        const placed = (edge: TopoDS_Edge): TopoDS_Edge => {
          const moved = edge.Moved(location, false);
          try {
            return Explorer.toEdge(moved);
          } finally {
            moved.delete();
          }
        };
        const curves = placement.curves!;
        for (const edge of [...curves.sharp, ...curves.outline]) {
          pieces.push({ piece: new ViewPiece(placed(edge), frame), smooth: false });
        }
        for (const edge of curves.smooth) {
          pieces.push({ piece: new ViewPiece(placed(edge), frame), smooth: true });
        }
      });
      let count = 0;
      for (const part of parts) {
        count += part.faces.length;
      }
      const triangles = new Float64Array(count * 9);
      const faces = new Int32Array(count);
      let at = 0;
      for (const part of parts) {
        triangles.set(part.triangles, at * 9);
        for (let i = 0; i < part.faces.length; i++) {
          faces[at + i] = part.faces[i] + part.offset;
        }
        at += part.faces.length;
      }
      stats.triangles = count;
      const cover = new CoverMesh(triangles, faces, bands);
      stats.meshMs = performance.now() - clock;

      // 3. What is seen.
      clock = performance.now();
      const cutters = pieces.filter((entry) => !entry.smooth).map((entry) => entry.piece);
      const visibility = new EdgeVisibility(frame, cutters, cover, {
        isCovered: (face, point) => {
          const owner = faceOwner[face];
          return owner.placement.model!.isCovered(owner.face, owner.placement.toLocal(point), owner.placement.localNormal);
        },
      }, Math.max(0, ...bands));
      for (const { piece, smooth } of pieces) {
        const stretches = visibility.stretchesOf(piece);
        // A covered crease or outline is a hidden line; a covered smooth edge is nothing.
        const layerOf = (hidden: boolean) => (!hidden ? (smooth ? 'tangent' : 'visible') : !smooth && options.hidden ? 'hidden' : null);
        if (stretches.length === 1) {
          // Seen or hidden whole: the piece goes on as it is.
          const layer = layerOf(stretches[0].hidden);
          if (layer) {
            edges[layer].push(piece.edge);
          } else {
            piece.edge.delete();
          }
          continue;
        }
        for (const stretch of stretches) {
          const layer = layerOf(stretch.hidden);
          const trimmed = layer ? ViewProjection.trimmed(piece.edge, stretch.from, stretch.to) : null;
          if (layer && trimmed) {
            edges[layer].push(trimmed);
          }
        }
        piece.edge.delete();
      }
      Object.assign(stats, visibility.stats);
      stats.visibilityMs = performance.now() - clock;
      return edges;
    } catch (error) {
      edges.dispose();
      throw error;
    } finally {
      for (const { piece } of pieces) {
        piece.dispose();
      }
      for (const model of models.values()) {
        model.dispose();
      }
      Explorer.deleteAll(locations);
      frame.dispose();
    }
  }

  /** The stretch of `edge` between two parameters of its curve, as an edge of its own; null when the kernel cannot cut it. */
  private static trimmed(edge: TopoDS_Edge, from: number, to: number): TopoDS_Edge | null {
    const oc = getOC();
    // The curve comes with the edge's location applied.
    const curve = oc.BRep_Tool.Curve(edge, 0, 1);
    try {
      if (!curve.returnValue || curve.returnValue.isNull()) {
        return null;
      }
      const maker = new oc.BRepBuilderAPI_MakeEdge(curve.returnValue, from, to);
      try {
        return maker.IsDone() ? maker.Edge() : null;
      } finally {
        maker.delete();
      }
    } finally {
      curve[Symbol.dispose]();
    }
  }
}

/** Where a body sits, and the view as it looks from inside the body's own frame. */
class Placement {
  /** World ← local rotation, row by row. */
  private readonly rotation: number[];
  private readonly translation: [number, number, number];
  readonly localNormal: [number, number, number];
  readonly localX: [number, number, number];
  model: ShapeModel | null = null;
  curves: ViewCurves | null = null;

  constructor(pose: Pose, plane: Plane) {
    const { x, y, z, w } = pose.quaternion;
    const n = Math.hypot(x, y, z, w) || 1;
    const [qx, qy, qz, qw] = [x / n, y / n, z / n, w / n];
    this.rotation = [
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ];
    this.translation = [pose.position.x, pose.position.y, pose.position.z];
    this.localNormal = this.toLocalDirection(plane.normal.x, plane.normal.y, plane.normal.z);
    this.localX = this.toLocalDirection(plane.xDirection.x, plane.xDirection.y, plane.xDirection.z);
  }

  private toLocalDirection(x: number, y: number, z: number): [number, number, number] {
    const r = this.rotation;
    return [
      r[0] * x + r[3] * y + r[6] * z,
      r[1] * x + r[4] * y + r[7] * z,
      r[2] * x + r[5] * y + r[8] * z,
    ];
  }

  /** A point of the world in the body's own frame. */
  toLocal(point: [number, number, number]): [number, number, number] {
    const t = this.translation;
    return this.toLocalDirection(point[0] - t[0], point[1] - t[1], point[2] - t[2]);
  }

  /** The body's triangles (nine numbers each, in its own frame) in the view frame: `x`, `y`, depth. */
  inView(local: Float64Array, plane: Plane): Float64Array {
    const r = this.rotation;
    const t = this.translation;
    // view = A · (R · p + t − origin), folded into one matrix and one offset.
    const m: number[] = [];
    const o: number[] = [];
    for (const axis of [plane.xDirection, plane.yDirection, plane.normal]) {
      m.push(
        axis.x * r[0] + axis.y * r[3] + axis.z * r[6],
        axis.x * r[1] + axis.y * r[4] + axis.z * r[7],
        axis.x * r[2] + axis.y * r[5] + axis.z * r[8],
      );
      o.push(axis.x * (t[0] - plane.origin.x) + axis.y * (t[1] - plane.origin.y) + axis.z * (t[2] - plane.origin.z));
    }
    const triangles = new Float64Array(local.length);
    for (let i = 0; i < local.length; i += 3) {
      const px = local[i];
      const py = local[i + 1];
      const pz = local[i + 2];
      triangles[i] = m[0] * px + m[1] * py + m[2] * pz + o[0];
      triangles[i + 1] = m[3] * px + m[4] * py + m[5] * pz + o[1];
      triangles[i + 2] = m[6] * px + m[7] * py + m[8] * pz + o[2];
    }
    return triangles;
  }
}

/**
 * One shape of a view, in its own frame, shared by every body placed from
 * it: its curves for each direction it is seen from, its faces' mesh, and
 * exact sight lines against single faces.
 */
class ShapeModel {
  private readonly runs: { normal: [number, number, number]; tangent: boolean; curves: ViewCurves }[] = [];
  private faces: TopoDS_Face[] | null = null;
  private intersectors: (IntCurvesFace_ShapeIntersector | null)[] = [];
  /** Nine numbers per triangle. */
  triangles: Float64Array = new Float64Array(0);
  /** The face each triangle belongs to, as an index into {@link bands}. */
  triangleFaces: Int32Array = new Int32Array(0);
  /** Per face: how far its triangles may stray from it. */
  bands: number[] = [];

  constructor(private readonly view: ViewShape) {}

  get views(): number {
    return this.runs.length;
  }

  /** The shape's curves seen as `placement` sees it. */
  curvesFrom(placement: Placement, tangent: boolean): ViewCurves {
    const normal = placement.localNormal;
    const known = this.runs.find((run) => run.tangent === tangent
      && Math.abs(run.normal[0] - normal[0]) <= SAME_DIRECTION
      && Math.abs(run.normal[1] - normal[1]) <= SAME_DIRECTION
      && Math.abs(run.normal[2] - normal[2]) <= SAME_DIRECTION);
    if (known) {
      return known.curves;
    }
    const local = new Plane(new Point(0, 0, 0), new Vector3d(...placement.localX), new Vector3d(...normal));
    const curves = HiddenLineProjection.curves(this.view, local, { tangent });
    this.runs.push({ normal, tangent, curves });
    return curves;
  }

  /** Meshes the shape's faces, once. The mesh goes on the view's own copy of the shape, never the scene's. */
  mesh(): void {
    if (this.faces) {
      return;
    }
    const oc = getOC();
    const shape = this.runs[0].curves.shape;
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    // A copy's faces come in the order of the shape's own, so a face's index means the same in every view.
    this.faces = Explorer.findShapes(shape, FACE).map((raw) => Explorer.toFace(raw));
    this.intersectors = this.faces.map(() => null);
    const known = MESHES.get(this.view.shape);
    if (known && known.bands.length === this.faces.length) {
      this.triangles = known.triangles;
      this.triangleFaces = known.triangleFaces;
      this.bands = known.bands;
      return;
    }
    const linDefl = Math.min(mmTol(MESH_MAX_MM), Math.max(mmTol(MESH_MIN_MM), bboxDiagonal(shape) * MESH_RELATIVE));
    Mesh.ensureTriangulated(shape, { linDefl, angDefl: MESH_ANGULAR_RAD });
    const coordinates: number[] = [];
    const owners: number[] = [];
    this.faces.forEach((face, index) => {
      const adaptor = new oc.BRepAdaptor_Surface(face, false);
      const planar = adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane;
      adaptor.delete();
      const location = new oc.TopLoc_Location();
      const triangulation = oc.BRep_Tool.Triangulation(face, location, 0);
      try {
        if (!triangulation) {
          this.bands.push(linDefl);
          return;
        }
        // A plane's triangles lie in it; a curved face's stray by the deflection it was meshed at.
        const deflection = triangulation.Deflection();
        this.bands.push(planar ? mmTol(1e-7) : 1.5 * (deflection > 0 ? Math.max(deflection, linDefl) : linDefl));
        const transformation = location.Transformation();
        const nodes: number[] = [];
        for (let i = 1; i <= triangulation.NbNodes(); i++) {
          const node = triangulation.Node(i);
          node.Transform(transformation);
          nodes.push(node.X(), node.Y(), node.Z());
          node.delete();
        }
        transformation.delete();
        for (let i = 1; i <= triangulation.NbTriangles(); i++) {
          const triangle = triangulation.Triangle(i);
          for (let corner = 1; corner <= 3; corner++) {
            const n = (triangle.Value(corner) - 1) * 3;
            coordinates.push(nodes[n], nodes[n + 1], nodes[n + 2]);
          }
          owners.push(index);
          triangle.delete();
        }
      } finally {
        triangulation?.delete();
        location.delete();
      }
    });
    this.triangles = Float64Array.from(coordinates);
    this.triangleFaces = Int32Array.from(owners);
    MESHES.set(this.view.shape, { triangles: this.triangles, triangleFaces: this.triangleFaces, bands: this.bands });
  }

  /**
   * Whether face `index` plainly stands between `point` and a viewer in
   * `direction` (both in the shape's frame) — `OcclusionProbe`'s test
   * against one face: a crossing counts inside the face, square to it and
   * clearly in front.
   */
  isCovered(index: number, point: [number, number, number], direction: [number, number, number]): boolean {
    const oc = getOC();
    const face = this.faces![index];
    let intersector = this.intersectors[index];
    if (!intersector) {
      intersector = new oc.IntCurvesFace_ShapeIntersector();
      // 1e-7 is the kernel's classification floor (unit-free), as in OccHitTest.
      intersector.Load(face, 1e-7);
      this.intersectors[index] = intersector;
    }
    const origin = new oc.gp_Pnt(point[0], point[1], point[2]);
    const dir = new oc.gp_Dir(direction[0], direction[1], direction[2]);
    const line = new oc.gp_Lin(origin, dir);
    try {
      intersector.Perform(line, mmTol(MIN_DEPTH_MM), mmTol(1e7));
      if (!intersector.IsDone()) {
        return false;
      }
      for (let i = 1; i <= intersector.NbPnt(); i++) {
        if (intersector.State(i) !== oc.TopAbs_State.TopAbs_IN) {
          continue;
        }
        const normal = FaceOps.outwardNormalRaw(face, { u: intersector.UParameter(i), v: intersector.VParameter(i) });
        const cos = normal ? Math.abs(normal.x * direction[0] + normal.y * direction[1] + normal.z * direction[2]) : 0;
        if (cos >= MIN_CROSSING_COS && intersector.WParameter(i) * cos >= mmTol(MIN_STANDOFF_MM)) {
          return true;
        }
      }
      return false;
    } finally {
      line.delete();
      dir.delete();
      origin.delete();
    }
  }

  dispose(): void {
    for (const intersector of this.intersectors) {
      intersector?.delete();
    }
    Explorer.deleteAll(this.faces ?? []);
    for (const run of this.runs) {
      run.curves.dispose();
    }
  }
}
