import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { Edge } from "../common/edge.js";
import type { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { BuildError } from "../common/build-error.js";
import { CurveOperand } from "../helpers/curve-operand.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { getOC } from "../oc/init.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceOps } from "../oc/face-ops.js";
import { SectionOps } from "../oc/section-ops.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { ShapeMeasure } from "../oc/shape-measure.js";
import { TubeOps } from "../oc/tube-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { mmTol } from "../units/tolerance.js";
import { facesShape, type IntersectionFaces } from "./intersection-curve-geometry.js";
import { sampleEdge, sampleWire, type Sample } from "./projected-curve-geometry.js";

/** Points checked along each source edge, from end to end, for lying on the faces. */
const ON_FACE_SAMPLES = 9;
/** Points sampled along each source edge, to find the source point nearest a point of a candidate. */
const SOURCE_SAMPLES = 32;
/** Points sampled along each candidate edge, for its side, its run and its distance from the source. */
const CANDIDATE_SAMPLES = 8;

/**
 * The offset curve of each source wire on the faces of `support`, as wires,
 * needing no scene (the build and the live preview both call it).
 *
 * The points of the faces at `|distance|` from a source, measured straight
 * through space, are where the faces meet a tube of that radius round it
 * (`TubeOps.around`); the tube's section with the faces gives candidate
 * chains on both sides of the source, and the sign of `distance` keeps one.
 * The kernel computes each edge's curve on the face it lies on, so the
 * result can split those faces or be offset again, and on analytic faces it
 * stays analytic (a line beside a line on a plane, an arc beside an arc).
 *
 * The side: walking along the source standing on the outside of the faces,
 * a positive distance keeps the chain on the left, a negative one the chain
 * on the right ({@link sideOf}). A source that runs along the rim of the
 * faces, one face beside each of its edges, is walked the way that face's
 * boundary runs, so a positive distance always goes onto the faces from a
 * rim; any other source is walked as it runs.
 *
 * Each result runs the same way as its source, results in source order.
 *
 * Refused: a zero distance; a source that does not lie on the faces (each
 * edge within its own tolerance and `mmTol(1e-4)`); no chain on the wanted
 * side ("leaves the faces"); a tube the kernel cannot sweep, more than one
 * chain on the wanted side, or a chain with a point nearer the source than
 * the distance — the tube folded over itself on the inside of a bend — or
 * farther ("tightest bend"). A broken result is never returned.
 */
export function buildOffsetCurveWires(sources: readonly Wire[], support: IntersectionFaces, distance: number): Wire[] {
  if (distance === 0 || !Number.isFinite(distance)) {
    throw zeroDistance();
  }
  const shape = facesShape(support);
  const rims = new RimSense(support.faces);
  const made: Wire[] = [];
  try {
    for (const source of sources) {
      requireOnFaces(source, shape.shape);
    }
    for (const source of sources) {
      made.push(offsetChain(source, support, shape.shape, distance, rims));
    }
    return made;
  } catch (error) {
    made.forEach(wire => wire.dispose());
    throw error;
  } finally {
    rims.dispose();
    shape.dispose();
  }
}

/** The refusal of a zero distance. */
export function zeroDistance(): BuildError {
  return new BuildError(
    `offset: the distance is zero.`,
    `Give a distance: positive for one side of the edges, negative for the other.`,
  );
}

/** The refusal of a distance at which nothing on the wanted side lies on the faces. */
function leavesFaces(): BuildError {
  return new BuildError(
    `offset: at this distance the curve leaves the faces.`,
    `No part of the faces lies at this distance on this side of the edges: use a smaller distance, the other side, or more faces in { on }.`,
  );
}

/** The refusal of a distance the curve's bends cannot take on the wanted side. */
function tightestBend(): BuildError {
  return new BuildError(
    `offset: the distance is larger than the curve's tightest bend allows on this side.`,
    `Use a smaller distance, or the other side.`,
  );
}

/**
 * Every edge of the source lies on the faces: points from end to end of it
 * are each within the edge's own tolerance and `mmTol(1e-4)` of them, so an
 * image a projection approximated still counts.
 */
function requireOnFaces(source: Wire, support: TopoDS_Shape): void {
  const oc = getOC();
  for (const edge of source.getEdges()) {
    const raw = edge.getShape() as TopoDS_Edge;
    const tolerance = oc.BRep_Tool.Tolerance(raw) + mmTol(1e-4);
    const adaptor = new oc.BRepAdaptor_Curve(raw);
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      for (let i = 0; i < ON_FACE_SAMPLES; i++) {
        const value = adaptor.Value(first + (last - first) * i / (ON_FACE_SAMPLES - 1));
        const point = new Point(value.X(), value.Y(), value.Z());
        value.delete();
        if (EdgeOps.distancePointToShapeRaw(point, support) > tolerance) {
          throw new BuildError(
            `offset: the edges do not lie on the faces given in { on }.`,
            `The edge through ${CurveOperand.formatPoint(point)} is off them: give the faces the edges lie on, or edges that lie on those faces.`,
          );
        }
      }
    } finally {
      adaptor.delete();
    }
  }
}

/** One source wire's offset curve: the tube's section with the faces, the chain on the wanted side, run as the source runs. */
function offsetChain(source: Wire, support: IntersectionFaces, supportShape: TopoDS_Shape, distance: number, rims: RimSense): Wire {
  const radius = Math.abs(distance);
  let tube: TopoDS_Shape;
  try {
    tube = TubeOps.around(source, radius);
  } catch {
    throw tightestBend();
  }

  const lookup = new SectionFaces(support.faces);
  let chains: Wire[];
  try {
    const section = SectionOps.sectionWithFaces(tube, supportShape, {
      first: [],
      second: support.faces.map(face => face.getShape()),
    });
    try {
      section.forEach(({ edge, face2 }) => lookup.record(edge, face2));
      chains = section.length > 0 ? WireOps.chainEdges(section.map(({ edge }) => edge)) : [];
    } finally {
      // The wires hold the edges they were built from; the section's own
      // wrappers are freed here.
      section.forEach(({ edge }) => edge.dispose());
    }
  } finally {
    tube.delete();
  }

  const from = sampleWire(source, SOURCE_SAMPLES);
  const sense = rims.senseOf(source);
  const wanted = Math.sign(distance);
  const kept: Wire[] = [];
  try {
    for (const chain of chains) {
      // Slivers the tube leaves where it grazes the faces count for nothing.
      if (ShapeMeasure.size(chain) >= mmTol(1e-4)
        && sideOf(chain, from, sense, support.faces, lookup) === wanted) {
        kept.push(chain);
      }
    }
    chains.filter(chain => !kept.includes(chain)).forEach(chain => chain.dispose());
    chains = [];
    if (kept.length === 0) {
      throw leavesFaces();
    }
    if (kept.length > 1 || folds(kept[0], source, radius)) {
      throw tightestBend();
    }
    const [result] = kept.splice(0);
    return runLike(result, from);
  } catch (error) {
    [...chains, ...kept].forEach(chain => chain.dispose());
    throw error;
  } finally {
    lookup.dispose();
  }
}

/**
 * Which side of the source a candidate chain lies on: 1 left, -1 right, 0
 * when it cannot be told. Each of its sample points `Q` votes: with `P` the
 * nearest source sample, `T` the source's tangent there (turned by `sense`)
 * and `N` the outward normal of the face `Q` lies on, at `Q`, `Q` is on the
 * left when `(Q − P) · (N × T) > 0`. The normal is taken where the
 * candidate lies, so where a source runs along a crease between two faces,
 * the chain on each face is told by that face's own outside.
 */
function sideOf(
  chain: Wire,
  from: readonly Sample[],
  sense: number,
  faces: readonly Face[],
  lookup: SectionFaces,
): number {
  const oc = getOC();
  let votes = 0;
  for (const edge of chain.getEdges()) {
    const raw = edge.getShape() as TopoDS_Edge;
    const face = lookup.faceOf(edge) ?? nearestFace(EdgeOps.getEdgeMidPoint(edge), faces);
    if (!face) {
      continue;
    }
    const adaptor = new oc.BRepAdaptor_Curve(raw);
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      for (let i = 0; i < CANDIDATE_SAMPLES; i++) {
        const fraction = (i + 0.5) / CANDIDATE_SAMPLES;
        const value = adaptor.Value(first + (last - first) * fraction);
        const point = new Point(value.X(), value.Y(), value.Z());
        value.delete();
        const normal = FaceOps.outwardNormalOnEdge(face.getShape() as TopoDS_Face, raw, fraction)
          ?? normalNear(face, point);
        if (!normal) {
          continue;
        }
        const nearest = from[nearestSample(from, point)];
        const left = normal.cross(nearest.tangent.multiply(sense));
        const along = nearest.point.vectorTo(point).dot(left);
        if (Math.abs(along) > mmTol(1e-6)) {
          votes += Math.sign(along);
        }
      }
    } finally {
      adaptor.delete();
    }
  }
  return Math.sign(votes);
}

/**
 * Whether the kept chain is not the offset curve it should be: a point of it
 * nearer the source than the distance (the tube folded over itself on the
 * inside of a bend tighter than the distance, or failed to trim a corner),
 * or farther. The kernel's fits allow ten times the edges' tolerance, and a
 * part in ten thousand of the distance.
 */
function folds(chain: Wire, source: Wire, radius: number): boolean {
  const oc = getOC();
  const edges = chain.getEdges();
  const fit = Math.max(...edges.map(edge => oc.BRep_Tool.Tolerance(edge.getShape() as TopoDS_Edge)));
  const tolerance = Math.max(mmTol(1e-3), radius * 1e-4, fit * 10);
  return edges.some(edge => sampleEdge(edge, CANDIDATE_SAMPLES).some(({ point }) =>
    Math.abs(EdgeOps.distancePointToEdge(point, source) - radius) > tolerance));
}

/** The chain run the way its source runs: tangents at matched points agree, summed over the chain; a reversed wire replaces the one given, which is freed. */
function runLike(chain: Wire, from: readonly Sample[]): Wire {
  let agreement = 0;
  for (const edge of chain.getEdges()) {
    for (const sample of sampleEdge(edge, CANDIDATE_SAMPLES)) {
      agreement += sample.tangent.dot(from[nearestSample(from, sample.point)].tangent);
    }
  }
  if (agreement >= 0) {
    return chain;
  }
  const reversed = WireOps.reverseWire(chain);
  chain.dispose();
  return reversed;
}

/** The index of the sample nearest `point`. */
function nearestSample(samples: readonly Sample[], point: Point): number {
  let best = 0;
  let bestDistance = Infinity;
  samples.forEach((sample, i) => {
    const distance = sample.point.distanceTo(point);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

/** The face nearest `point`, for an edge the section did not say the face of. */
function nearestFace(point: Point, faces: readonly Face[]): Face | null {
  let best: Face | null = null;
  let bestDistance = Infinity;
  for (const face of faces) {
    const distance = EdgeOps.distancePointToShapeRaw(point, face.getShape());
    if (distance < bestDistance) {
      best = face;
      bestDistance = distance;
    }
  }
  return best;
}

/** The face's outward normal at the point of its surface nearest `point`; null where it has none. */
function normalNear(face: Face, point: Point): Vector3d | null {
  const oc = getOC();
  const raw = face.getShape() as TopoDS_Face;
  const surface = oc.BRep_Tool.Surface(raw);
  const at = new oc.gp_Pnt(point.x, point.y, point.z);
  const projection = new oc.GeomAPI_ProjectPointOnSurf(at, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
  try {
    if (!projection.IsDone() || projection.NbPoints() === 0) {
      return null;
    }
    const { U, V } = projection.LowerDistanceParameters();
    return FaceOps.outwardNormalRaw(raw, { u: U, v: V });
  } finally {
    projection.delete();
    at.delete();
    surface.delete();
  }
}

/** Which support face the section cut each of its edges on, by an `IsSame` key, so a chain's edges find theirs. */
class SectionFaces {
  private readonly hasher = new ShapeHasher();
  private readonly faces = new Map<number, number>();

  /** `support`: the faces, in the order the section was given them. */
  constructor(private readonly support: readonly Face[]) {}

  /** Notes the support face `index` the section cut `edge` on (-1 when it did not say). */
  record(edge: Edge, index: number): void {
    if (index >= 0) {
      this.faces.set(this.hasher.key(edge.getShape()), index);
    }
  }

  faceOf(edge: Edge): Face | null {
    const index = this.faces.get(this.hasher.key(edge.getShape()));
    return index === undefined ? null : this.support[index] ?? null;
  }

  dispose(): void {
    this.hasher.delete();
  }
}

/**
 * The rim rule: which way a source is walked to tell its sides. A source
 * every edge of which bounds exactly one face of the support, once, runs
 * along the rim of the faces; it is walked the way that face's boundary runs
 * (with the face on the left, seen from its outside), so a positive distance
 * goes onto the faces. Any other source is walked as it runs.
 */
class RimSense {
  private readonly hasher = new ShapeHasher();
  /** For each support edge, by key: whether each face it bounds runs it against its own direction. */
  private readonly bounds = new Map<number, boolean[]>();

  constructor(faces: readonly Face[]) {
    const oc = getOC();
    for (const face of faces) {
      // The explorer composes each edge's orientation with its wire's and
      // the face's: the way the face's boundary runs it.
      Explorer.withShapes(face.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, edges => {
        for (const edge of edges) {
          const key = this.hasher.key(edge);
          const list = this.bounds.get(key) ?? [];
          list.push(edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED);
          this.bounds.set(key, list);
        }
      });
    }
  }

  /** 1 to walk the source as it runs, -1 to walk it the other way. */
  senseOf(source: Wire): number {
    const oc = getOC();
    let votes = 0;
    for (const edge of source.getEdges()) {
      const raw = edge.getShape();
      const list = this.bounds.get(this.hasher.key(raw));
      if (!list || list.length !== 1) {
        return 1;
      }
      const reversed = raw.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      votes += reversed === list[0] ? 1 : -1;
    }
    return votes < 0 ? -1 : 1;
  }

  dispose(): void {
    this.hasher.delete();
  }
}
