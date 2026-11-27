import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import type { BodyShape } from "../common/body-shape.js";
import { BuildError } from "../common/build-error.js";
import type { HeldFace } from "../helpers/face-operand.js";
import { CurveOperand } from "../helpers/curve-operand.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { getOC } from "../oc/init.js";
import { Explorer } from "../oc/explorer.js";
import { SectionEdge, SectionOps } from "../oc/section-ops.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { ShapeMeasure } from "../oc/shape-measure.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { SurfaceClassifier, type SurfaceKind } from "../oc/surface-classifier.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { WireOps } from "../oc/wire-ops.js";
import { mmTol } from "../units/tolerance.js";

/**
 * One side of an intersection, as faces: the faces the side's argument
 * stands for, in its order (a face's index there is what orders the
 * result), and the bodies every face of which is among them, which are
 * sectioned whole rather than face by face.
 */
export type IntersectionFaces = {
  faces: Face[];
  wholeBodies: BodyShape[];
};

/** What the second side may be besides faces: a `plane()`, taken as infinite. */
export type IntersectionSide = IntersectionFaces | Plane;

/** Two directions closer than this (radians) make no crossing: tangent faces, or faces lying on each other. */
const ANGULAR_TOLERANCE = 1e-6;

/** The words a refusal names a face's surface kind with. */
const SURFACE_WORDS: Record<SurfaceKind, string> = {
  plane: 'planar', cylinder: 'cylindrical', cone: 'conical', sphere: 'spherical', torus: 'toroidal',
  revolved: 'revolved', extruded: 'extruded', freeform: 'free-form',
};

/**
 * A side read from the faces an argument stands for (`FaceOperand.faces`):
 * its faces in that order, each once (a face named twice — by its body and
 * by a selection — counts at its first place), and the bodies it names
 * whole. A side with no face at all is refused, in the words of `label`.
 */
export function intersectionFaces(held: readonly HeldFace[], label: string): IntersectionFaces {
  if (held.length === 0) {
    throw new BuildError(
      `${label} holds no faces.`,
      `Check that the selection matches faces at this point of the model.`,
    );
  }
  const hasher = new ShapeHasher();
  try {
    const seen = new Set<number>();
    const faces: Face[] = [];
    const counts = new Map<BodyShape, number>();
    for (const { face, body } of held) {
      const key = hasher.key(face.getShape());
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      faces.push(face);
      if (body) {
        counts.set(body, (counts.get(body) ?? 0) + 1);
      }
    }
    const wholeBodies = [...counts].filter(([body, count]) => count === body.getFaces().length).map(([body]) => body);
    return { faces, wholeBodies };
  } finally {
    hasher.delete();
  }
}

/**
 * The curve where two sets of faces meet, as wires: one per connected chain
 * of intersection edges, needing no scene (the build and the live preview
 * both call it).
 *
 * The kernel section's edges are taken where the two sides cross; an edge
 * where they only touch — tangent faces, faces lying on each other, faces
 * meeting along an edge — is left out. What is left must chain into simple
 * wires: a branching or broken result is refused, saying where.
 *
 * The order does not depend on the kernel's: wires are ordered by the index
 * of the first-side face each starts on, then by their start point
 * (lexicographic, x then y then z, ties within `mmTol(1e-6)`). An open
 * wire starts at its lexicographically smaller end; a closed one is walked
 * so that its first edge (the one `Wire` starts it at, by the smallest
 * midpoint) runs from its smaller end.
 */
export function buildIntersectionWires(first: IntersectionFaces, second: IntersectionSide): Wire[] {
  refuseSharedFaces(first, second);

  const a = facesShape(first);
  const b = second instanceof Plane ? null : facesShape(second);
  let section: SectionEdge[] = [];
  try {
    section = SectionOps.sectionWithFaces(a.shape, b ? b.shape : second as Plane, {
      first: first.faces.map(face => face.getShape()),
      second: second instanceof Plane ? [] : second.faces.map(face => face.getShape()),
    });
  } finally {
    a.dispose();
    b?.dispose();
  }

  const sides = [new SideProbe(first), new SideProbe(second)] as const;
  const kept: { edge: Edge; face: number }[] = [];
  try {
    for (const entry of section) {
      const face = crossingFace(entry, sides[0], sides[1]);
      if (face !== null) {
        kept.push({ edge: entry.edge, face });
      }
    }
    if (kept.length === 0) {
      throw new BuildError(
        `intersect: the two selections do not cross.`,
        `Faces that only touch along an edge, or lie on top of each other, have no intersection curve.`,
      );
    }

    const edges = kept.map(({ edge }) => edge);
    refuseBranches(edges);
    const wires = WireOps.chainEdges(edges);
    try {
      const chained = wires.reduce((count, wire) => count + wire.getEdges().length, 0);
      if (chained !== edges.length) {
        throw new BuildError(
          `intersect: the edges where the selections meet do not join into curves (${edges.length} edges, ${chained} chained).`,
          `The faces probably touch somewhere instead of crossing; move one of them so they cross cleanly.`,
        );
      }
      for (const wire of wires) {
        refuseBrokenEnds(wire, sides[0], sides[1]);
      }
      const oriented = wires.map(orient);
      wires.length = 0;
      return orderWires(oriented, kept);
    } catch (error) {
      wires.forEach(wire => wire.dispose());
      throw error;
    }
  } finally {
    // The wires hold the edges they were built from; the section's own
    // wrappers, kept or left out, are freed here.
    section.forEach(({ edge }) => edge.dispose());
    sides.forEach(side => side.dispose());
  }
}

/** A face present on both sides has no curve with itself: refused, naming it. */
function refuseSharedFaces(first: IntersectionFaces, second: IntersectionSide): void {
  if (second instanceof Plane) {
    return;
  }
  const hasher = new ShapeHasher();
  try {
    const keys = new Set(first.faces.map(face => hasher.key(face.getShape())));
    const shared = second.faces.find(face => keys.has(hasher.key(face.getShape())));
    if (shared) {
      throw new BuildError(
        `intersect: ${describeFace(shared)} is in both selections.`,
        `A face cannot cross itself: take it out of one of the two selections.`,
      );
    }
  } finally {
    hasher.delete();
  }
}

/** "the cylindrical face at (0, 0, 5)": its surface kind and its centre. */
function describeFace(face: Face): string {
  const kind = SURFACE_WORDS[SurfaceClassifier.classify(face).kind];
  return `the ${kind} face at ${CurveOperand.formatPoint(ShapeMeasure.centerOfMass(face))}`;
}

/**
 * The kernel shape a set of faces is handed to the kernel as: its whole
 * bodies as they are, its other faces loose, in one compound when more than
 * one. `dispose` frees the compound, if one was made; the bodies and faces
 * are the scene's.
 */
export function facesShape(side: IntersectionFaces): { shape: TopoDS_Shape; dispose: () => void } {
  const parts: TopoDS_Shape[] = side.wholeBodies.map(body => body.getShape());
  const hasher = new ShapeHasher();
  try {
    const taken = new Set<number>();
    for (const body of side.wholeBodies) {
      for (const face of body.getFaces()) {
        taken.add(hasher.key(face.getShape()));
      }
    }
    for (const face of side.faces) {
      const key = hasher.key(face.getShape());
      if (!taken.has(key)) {
        taken.add(key);
        parts.push(face.getShape());
      }
    }
  } finally {
    hasher.delete();
  }
  if (parts.length === 1) {
    return { shape: parts[0], dispose: () => {} };
  }
  const compound = ShapeOps.makeCompoundRaw(parts);
  return { shape: compound, dispose: () => compound.delete() };
}

/**
 * Whether the two sides cross along a section edge, judged at its
 * midpoint: the first-side face index it was cut on (to order by), or null
 * when the sides only touch there.
 *
 * An edge the kernel cut on a face of each side (or on a face and the
 * plane) lies inside both faces: they cross unless they are tangent there.
 * An edge it took from an existing edge of one side (a common block) is
 * judged by how each side's faces leave the edge: they cross when, around
 * the edge, the two sides' faces alternate.
 */
function crossingFace(entry: SectionEdge, first: SideProbe, second: SideProbe): number | null {
  const { point, tangent } = midTangent(entry.edge);
  const cutOnBoth = entry.face1 >= 0 && (second.plane !== null || entry.face2 >= 0);
  if (cutOnBoth) {
    const a = first.normalAt(entry.face1, point);
    const b = second.plane ? second.plane.normal : second.normalAt(entry.face2, point);
    if (!a || !b) {
      return null;
    }
    return a.normalize().cross(b.normalize()).length() > ANGULAR_TOLERANCE ? entry.face1 : null;
  }
  const tolerance = edgeTolerance(entry.edge);
  const a = first.raysAt(point, tangent, tolerance);
  const b = second.raysAt(point, tangent, tolerance);
  if (!alternate(a.rays, b.rays, tangent)) {
    return null;
  }
  return a.faces.length > 0 ? Math.min(...a.faces) : Number.MAX_SAFE_INTEGER;
}

/**
 * Whether two fans of directions about an axis cross: some pair of each
 * strictly alternates with a pair of the other around `axis` (a, b, a, b),
 * none of the four within {@link ANGULAR_TOLERANCE} of another.
 */
function alternate(a: Vector3d[], b: Vector3d[], axis: Vector3d): boolean {
  if (a.length < 2 || b.length < 2) {
    return false;
  }
  const u = a[0];
  const w = axis.cross(u);
  const angle = (v: Vector3d) => {
    const value = Math.atan2(v.dot(w), v.dot(u));
    return value < 0 ? value + 2 * Math.PI : value;
  };
  const near = (x: number, y: number) => {
    const gap = Math.abs(x - y);
    return Math.min(gap, 2 * Math.PI - gap) <= ANGULAR_TOLERANCE;
  };
  const aAngles = a.map(angle);
  const bAngles = b.map(angle);
  for (let i = 0; i < aAngles.length; i++) {
    for (let j = i + 1; j < aAngles.length; j++) {
      const lo = Math.min(aAngles[i], aAngles[j]);
      const hi = Math.max(aAngles[i], aAngles[j]);
      for (let k = 0; k < bAngles.length; k++) {
        for (let l = k + 1; l < bAngles.length; l++) {
          const pair = [bAngles[k], bAngles[l]];
          if (pair.some(x => near(x, lo) || near(x, hi))) {
            continue;
          }
          const inside = pair.filter(x => x > lo && x < hi).length;
          if (inside === 1) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * A branch — three or more edges meeting at one point — makes no simple
 * curve: refused, naming the point.
 */
function refuseBranches(edges: Edge[]): void {
  const tolerance = WireOps.connectTolerance(edges);
  const ends: { point: Point; count: number }[] = [];
  for (const edge of edges) {
    for (const point of [edge.getFirstPoint(), edge.getLastPoint()]) {
      const known = ends.find(entry => entry.point.distanceTo(point) <= tolerance);
      if (known) {
        known.count++;
      } else {
        ends.push({ point, count: 1 });
      }
    }
  }
  const branch = ends.find(entry => entry.count > 2);
  if (branch) {
    throw new BuildError(
      `intersect: the intersection branches at ${CurveOperand.formatPoint(branch.point)}: ${branch.count} of its edges meet there.`,
      `The faces touch at that point as well as crossing; move one of them so the curves part.`,
    );
  }
}

/**
 * An open wire ends where one side's faces end: on the open rim of the
 * faces it was given. An end inside both is a fragment — what tangent faces
 * leave — and is refused, naming it.
 */
function refuseBrokenEnds(wire: Wire, first: SideProbe, second: SideProbe): void {
  const start = wire.getFirstPoint();
  const end = wire.getLastPoint();
  if (!start || !end) {
    return;
  }
  const tolerance = Math.max(...wire.getEdges().map(edgeTolerance)) * 10;
  if (start.distanceTo(end) <= tolerance) {
    return;
  }
  for (const point of [start, end]) {
    if (!first.onRim(point, tolerance) && !second.onRim(point, tolerance)) {
      throw new BuildError(
        `intersect: the intersection breaks off at ${CurveOperand.formatPoint(point)}, inside both selections.`,
        `The faces probably touch there instead of crossing: tangent faces have no reliable intersection curve. Move one of them so they cross cleanly.`,
      );
    }
  }
}

/** The wire walked the stable way (see {@link buildIntersectionWires}); a reversed wire replaces the one given, which is freed. */
function orient(wire: Wire): Wire {
  const edges = wire.getEdges();
  const tolerance = mmTol(1e-6);
  const start = wire.getFirstPoint()!;
  const end = wire.getLastPoint()!;
  const closed = start.distanceTo(end) <= Math.max(...edges.map(edgeTolerance)) * 10;
  let reverse: boolean;
  if (!closed) {
    reverse = lexCompare(end, start, tolerance) < 0;
  } else {
    const head = edges[0];
    const from = head.getFirstPoint();
    const to = head.getLastPoint();
    reverse = from.distanceTo(to) > tolerance && lexCompare(to, from, tolerance) < 0;
  }
  if (!reverse) {
    return wire;
  }
  const reversed = WireOps.reverseWire(wire);
  wire.dispose();
  return reversed;
}

/**
 * Wires by the first-side face index their first edge was cut on, then by
 * their start point. The index of a wire's first edge is that of the
 * section edge with the nearest midpoint.
 */
function orderWires(wires: Wire[], kept: { edge: Edge; face: number }[]): Wire[] {
  const midpoints = kept.map(({ edge, face }) => ({ point: midTangent(edge).point, face }));
  const keyed = wires.map(wire => {
    const head = midTangent(wire.getEdges()[0]).point;
    let best = midpoints[0];
    for (const candidate of midpoints) {
      if (candidate.point.distanceTo(head) < best.point.distanceTo(head)) {
        best = candidate;
      }
    }
    return { wire, face: best.face, start: wire.getFirstPoint()! };
  });
  const tolerance = mmTol(1e-6);
  keyed.sort((x, y) => x.face - y.face || lexCompare(x.start, y.start, tolerance));
  return keyed.map(({ wire }) => wire);
}

/** Lexicographic order of two points, x then y then z, coordinates within `tolerance` tying. */
function lexCompare(a: Point, b: Point, tolerance: number): number {
  for (const [p, q] of [[a.x, b.x], [a.y, b.y], [a.z, b.z]]) {
    if (p < q - tolerance) {
      return -1;
    }
    if (p > q + tolerance) {
      return 1;
    }
  }
  return 0;
}

/** How far a point may lie from a face or a rim and still be on it, for an edge of the section. */
function edgeTolerance(edge: Edge): number {
  const oc = getOC();
  return Math.max(oc.BRep_Tool.Tolerance(edge.getShape() as TopoDS_Edge), mmTol(1e-4));
}

/** The edge's midpoint and unit tangent there, in the edge's own direction. */
function midTangent(edge: Edge): { point: Point; tangent: Vector3d } {
  const oc = getOC();
  const raw = edge.getShape() as TopoDS_Edge;
  const adaptor = new oc.BRepAdaptor_Curve(raw);
  const point = new oc.gp_Pnt();
  const vector = new oc.gp_Vec();
  try {
    adaptor.D1((adaptor.FirstParameter() + adaptor.LastParameter()) / 2, point, vector);
    const tangent = new Vector3d(vector.X(), vector.Y(), vector.Z());
    return {
      point: new Point(point.X(), point.Y(), point.Z()),
      tangent: tangent.length() > 0 ? tangent.normalize() : tangent,
    };
  } finally {
    vector.delete();
    point.delete();
    adaptor.delete();
  }
}

/**
 * What the crossing test asks of one side at a point: the normal of one of
 * its faces there, the directions its faces leave the point in across an
 * edge, and whether the point is on the side's open rim. A plane side
 * answers from the plane. Kernel tables are built on first use and freed
 * by {@link dispose}.
 */
class SideProbe {
  readonly plane: Plane | null;
  private readonly faces: Face[];
  private boxes: ReturnType<typeof ShapeOps.getBoundingBoxRaw>[] | null = null;
  private rim: TopoDS_Shape | null | undefined = undefined;

  constructor(side: IntersectionSide) {
    this.plane = side instanceof Plane ? side : null;
    this.faces = side instanceof Plane ? [] : side.faces;
  }

  /** The normal of face `index` at the point nearest `point` on its surface; null where it has none. */
  normalAt(index: number, point: Point): Vector3d | null {
    const face = this.faces[index];
    return face ? SideProbe.normalOn(face.getShape() as TopoDS_Face, point) : null;
  }

  /**
   * The directions, square to `axis`, in which this side's faces leave
   * `point`: two opposite ones for a face the point is inside, one for a
   * face it bounds — with the indices of the faces that hold the point.
   */
  raysAt(point: Point, axis: Vector3d, tolerance: number): { rays: Vector3d[]; faces: number[] } {
    if (this.plane) {
      const across = this.plane.normal.cross(axis).normalize();
      return { rays: [across, across.negate()], faces: [] };
    }
    const rays: Vector3d[] = [];
    const faces: number[] = [];
    const step = tolerance * 20;
    this.faces.forEach((face, index) => {
      const raw = face.getShape() as TopoDS_Face;
      if (!this.near(index, point, tolerance) || SideProbe.distance(point, raw) > tolerance) {
        return;
      }
      const normal = SideProbe.normalOn(raw, point);
      if (!normal || normal.cross(axis).length() <= ANGULAR_TOLERANCE) {
        return;
      }
      faces.push(index);
      const across = normal.cross(axis).normalize();
      for (const direction of [across, across.negate()]) {
        if (SideProbe.inside(raw, point.add(direction.multiply(step)))) {
          rays.push(direction);
        }
      }
    });
    return { rays, faces };
  }

  /** Whether `point` lies on the open rim of this side's faces: an edge only one of them bounds. A plane has none. */
  onRim(point: Point, tolerance: number): boolean {
    const rim = this.rimShape();
    return rim !== null && SideProbe.distance(point, rim) <= tolerance;
  }

  dispose(): void {
    if (this.rim) {
      this.rim.delete();
    }
    this.rim = null;
  }

  private near(index: number, point: Point, tolerance: number): boolean {
    this.boxes ??= this.faces.map(face => ShapeOps.getBoundingBoxRaw(face.getShape()));
    const box = this.boxes[index];
    return point.x >= box.minX - tolerance && point.x <= box.maxX + tolerance
      && point.y >= box.minY - tolerance && point.y <= box.maxY + tolerance
      && point.z >= box.minZ - tolerance && point.z <= box.maxZ + tolerance;
  }

  /** The side's open rim as one compound of edges, or null when it has none. */
  private rimShape(): TopoDS_Shape | null {
    if (this.rim !== undefined) {
      return this.rim;
    }
    this.rim = null;
    if (this.faces.length === 0) {
      return null;
    }
    const oc = getOC();
    const all = ShapeOps.makeCompoundRaw(this.faces.map(face => face.getShape()));
    const index = TopologyIndex.buildEdgeToFaces(all);
    const edges = Explorer.findShapes(all, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
    try {
      // A seam lists its face twice; an edge two faces of the side share
      // lists both. One entry is a rim edge.
      const rim = edges.filter(edge => index.Seek(edge)?.Size() === 1);
      if (rim.length > 0) {
        this.rim = ShapeOps.makeCompoundRaw(rim);
      }
    } finally {
      edges.forEach(edge => edge.delete());
      index.delete();
      all.delete();
    }
    return this.rim;
  }

  private static normalOn(face: TopoDS_Face, point: Point): Vector3d | null {
    const oc = getOC();
    const surface = oc.BRep_Tool.Surface(face);
    const at = new oc.gp_Pnt(point.x, point.y, point.z);
    const projection = new oc.GeomAPI_ProjectPointOnSurf(at, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    try {
      if (!projection.IsDone() || projection.NbPoints() === 0) {
        return null;
      }
      const { U, V } = projection.LowerDistanceParameters();
      const props = new oc.GeomLProp_SLProps(surface, U, V, 1, 1e-9);
      try {
        if (!props.IsNormalDefined()) {
          return null;
        }
        const normal = props.Normal();
        try {
          return new Vector3d(normal.X(), normal.Y(), normal.Z());
        } finally {
          normal.delete();
        }
      } finally {
        props.delete();
      }
    } finally {
      projection.delete();
      at.delete();
      surface.delete();
    }
  }

  private static distance(point: Point, shape: TopoDS_Shape): number {
    const oc = getOC();
    const at = new oc.gp_Pnt(point.x, point.y, point.z);
    const maker = new oc.BRepBuilderAPI_MakeVertex(at);
    const vertex = maker.Shape();
    const progress = new oc.Message_ProgressRange();
    const extrema = new oc.BRepExtrema_DistShapeShape(
      vertex, shape, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress,
    );
    try {
      return extrema.IsDone() ? extrema.Value() : Infinity;
    } finally {
      extrema.delete();
      progress.delete();
      vertex.delete();
      maker.delete();
      at.delete();
    }
  }

  private static inside(face: TopoDS_Face, point: Point): boolean {
    const oc = getOC();
    const at = new oc.gp_Pnt(point.x, point.y, point.z);
    const classifier = new oc.BRepClass_FaceClassifier();
    try {
      classifier.Perform(face, at, oc.Precision.Confusion(), true, oc.Precision.Confusion());
      return classifier.State() === oc.TopAbs_State.TopAbs_IN;
    } finally {
      classifier.delete();
      at.delete();
    }
  }
}
