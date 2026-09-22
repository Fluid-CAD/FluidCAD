import type { TopoDS_Edge, TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { EdgeOps } from "../edge-ops.js";
import { EdgeQuery } from "../edge-query.js";
import { Explorer } from "../explorer.js";
import { ShapeOps } from "../shape-ops.js";
import { WireOps } from "../wire-ops.js";
import { Wire } from "../../common/wire.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";

/** How two G1 runs of a spine are joined where they meet at a sharp corner. */
export type CornerJoin = "mitre" | "round";

export interface SpineEdge {
  edge: TopoDS_Edge;
  isLine: boolean;
  start: Point;
  end: Point;
  /** Unit tangents in the spine's direction of travel. */
  startTangent: Vector3d;
  endTangent: Vector3d;
  length: number;
}

/** A maximal G1 stretch of the spine: the pipe over it is one MakePipeShell call. */
export interface SpineRun {
  edges: SpineEdge[];
}

/** A tangent discontinuity between two runs. */
export interface SpineCorner {
  point: Point;
  /** Tangent arriving at the corner (end of the run before it). */
  inTangent: Vector3d;
  /** Tangent leaving the corner (start of the run after it). */
  outTangent: Vector3d;
  /** Unit `inTangent × outTangent`: rotating `inTangent` about it by `angle` gives `outTangent`. */
  axis: Vector3d;
  angle: number;
  join: CornerJoin;
}

/**
 * The frame law MakePipeShell should carry the section with. A fixed binormal
 * (the spine's tangent-rotation axis) keeps the section from twisting on
 * planar spines and helices; a spine whose tangent turns about several axes
 * (a non-planar polyline) has no such axis and falls back to OCCT's corrected
 * Frenet frame.
 */
export type SpineTrihedron =
  | { kind: "binormal"; axis: Vector3d }
  | { kind: "frenet" };

/**
 * Reads a sweep spine as a sequence of G1 runs separated by sharp corners,
 * with the geometry each corner join needs (point, tangents, turn axis).
 */
export class SpineAnalysis {
  /** Junctions turning less than this (rad) are G1 and stay inside a run. */
  static readonly CORNER_ANGLE = 1e-3;

  /** A junction turning this far (rad) folds the spine back on itself: no pipe can cross it. */
  static readonly CUSP_ANGLE = Math.PI - 0.025;

  /**
   * How nearly every sampled tangent-rotation vector must line up with their
   * mean for the mean to serve as a fixed binormal: |cos| = 0.985 is 10°.
   */
  private static readonly MAX_AXIS_DEVIATION = 0.985;

  // How nearly a candidate binormal may line up with the spine's tangent
  // before `Normal = BiNormal × Tangent` stops being a usable direction:
  // |cos| = 0.999 is 2.6° apart. Anything looser would swap the section's
  // roll out from under sweeps that build correctly today.
  private static readonly MAX_BINORMAL_ALIGNMENT = 0.999;

  readonly wire: TopoDS_Wire;
  readonly closed: boolean;
  readonly edges: SpineEdge[];
  readonly runs: SpineRun[];
  /** `corners[i]` sits between `runs[i]` and `runs[(i + 1) % runs.length]`. */
  readonly corners: SpineCorner[];

  constructor(wire: Wire) {
    this.wire = wire.getShape() as TopoDS_Wire;
    this.closed = wire.isClosed();
    let edges = Explorer.findEdgesInWireOrderWrapped(wire).map(e => SpineAnalysis.describeEdge(e.getShape()));

    // Every junction's turn, including the closing one on a closed spine.
    const junctionCount = this.closed ? edges.length : edges.length - 1;
    let cornerAt = SpineAnalysis.cornerJunctions(edges, junctionCount);

    // A closed spine whose closing junction is smooth would leave the first
    // and last runs as one run split in two: start the walk right after the
    // first corner instead, so every run boundary is a corner.
    if (this.closed && cornerAt.length > 0 && !cornerAt.includes(edges.length - 1)) {
      const first = cornerAt[0] + 1;
      edges = [...edges.slice(first), ...edges.slice(0, first)];
      cornerAt = SpineAnalysis.cornerJunctions(edges, junctionCount);
    }
    this.edges = edges;

    const runs: SpineRun[] = [];
    let current: SpineEdge[] = [];
    edges.forEach((edge, i) => {
      current.push(edge);
      if (cornerAt.includes(i) && i < edges.length - 1) {
        runs.push({ edges: current });
        current = [];
      }
    });
    runs.push({ edges: current });
    this.runs = runs;

    this.corners = cornerAt.map(i => SpineAnalysis.describeCorner(edges[i], edges[(i + 1) % edges.length]));
  }

  get hasCorners(): boolean {
    return this.corners.length > 0;
  }

  /** The corner a run starts at, if any (the closing corner for run 0 of a closed spine). */
  startCorner(runIndex: number): SpineCorner | null {
    if (runIndex > 0) {
      return this.corners[runIndex - 1];
    }
    return this.closed ? this.corners[this.corners.length - 1] ?? null : null;
  }

  /** The corner a run ends at, if any. */
  endCorner(runIndex: number): SpineCorner | null {
    return this.corners[runIndex] ?? null;
  }

  /** Where the sweep begins: the profile is carried from here. */
  get startPoint(): Point {
    return this.edges[0].start;
  }

  /**
   * The wire of one run, with its first/last line edge lengthened by
   * `startExtension` / `endExtension` so the pipe overshoots a mitre corner
   * far enough to be trimmed back to the bisector plane. Only line edges are
   * ever extended (mitres join lines), so lengthening is exact.
   */
  runWire(runIndex: number, startExtension: number, endExtension: number): TopoDS_Wire {
    const runEdges = this.runs[runIndex].edges;
    const edges = runEdges.map(e => e.edge);
    const first = runEdges[0];
    const last = runEdges[runEdges.length - 1];
    let firstStart = first.start;
    if (startExtension > 0) {
      firstStart = first.start.subtract(first.startTangent.multiply(startExtension));
      edges[0] = EdgeOps.makeLineEdge(firstStart, first.end).getShape() as TopoDS_Edge;
    }
    if (endExtension > 0) {
      const lastStart = runEdges.length === 1 ? firstStart : last.start;
      const end = last.end.add(last.endTangent.multiply(endExtension));
      edges[edges.length - 1] = EdgeOps.makeLineEdge(lastStart, end).getShape() as TopoDS_Edge;
    }
    return WireOps.makeWireFromEdgesRaw(edges);
  }

  /**
   * How far a section reaches from the spine, measured from the sweep's start:
   * the farthest any point of it lies from the spine point it travels with.
   * The section moves rigidly, so this holds at every corner.
   */
  sectionRadius(section: TopoDS_Shape): number {
    const bbox = ShapeOps.getExactBoundingBoxRaw(section);
    return Math.max(...ShapeOps.boundingBoxCorners(bbox).map(corner => corner.distanceTo(this.startPoint)));
  }

  /**
   * Fixed binormal for MakePipeShell's `SetMode`: it locks the section's
   * "up", so the profile keeps a constant angle to it instead of twisting
   * along the spine. The correct direction is the axis the spine's tangent
   * rotates around — the plane normal for a planar spine, the coil axis for a
   * helix. The tangent keeps a constant, non-zero angle to that axis, so the
   * section never flips and the result is a clean coil.
   *
   * The profile plane's own "up" only works when it happens to equal that
   * axis — true for a profile sketched on a world plane, but NOT for a plane
   * built off a helix, whose in-plane axes are arbitrary. A wrong (e.g.
   * roughly horizontal) binormal lets the helix tangent rotate into it,
   * collapsing `Normal = BiNormal × Tangent` ~twice per turn and shredding
   * the section into a self-intersecting ribbon. A straight spine has no
   * rotation axis (the cross products vanish); its binormal is picked off
   * the profile plane instead — see `straightSpineBinormal`. A spine that
   * turns about several axes has no usable binormal at all.
   */
  trihedron(profilePlane: Plane): SpineTrihedron {
    const rotation = this.tangentRotationAxis();
    if (rotation === "twisted") {
      return { kind: "frenet" };
    }
    const axis = rotation ?? SpineAnalysis.straightSpineBinormal(profilePlane, this.edges[0].startTangent);
    return { kind: "binormal", axis };
  }

  /** Unit tangent of the spine at its start. */
  get startTangent(): Vector3d {
    return this.edges[0].startTangent;
  }

  private static describeEdge(edge: TopoDS_Edge): SpineEdge {
    return {
      edge,
      isLine: EdgeQuery.getEdgeCurveTypeRaw(edge) === "line",
      start: EdgeOps.getVertexPointRaw(EdgeOps.getFirstVertexRaw(edge)),
      end: EdgeOps.getVertexPointRaw(EdgeOps.getLastVertexRaw(edge)),
      startTangent: EdgeOps.getEdgeTangentAtStartRaw(edge),
      endTangent: EdgeOps.getEdgeTangentAtEndRaw(edge),
      length: EdgeOps.getEdgeLengthRaw(edge),
    };
  }

  /** Indices `i` whose junction (end of edge i → start of edge i+1, cyclic) is a sharp corner. */
  private static cornerJunctions(edges: SpineEdge[], junctionCount: number): number[] {
    const corners: number[] = [];
    for (let i = 0; i < junctionCount; i++) {
      const next = edges[(i + 1) % edges.length];
      const angle = edges[i].endTangent.angleTo(next.startTangent);
      if (angle >= SpineAnalysis.CUSP_ANGLE) {
        const p = edges[i].end;
        throw new Error(
          `Sweep path folds back on itself at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}): ` +
          "a profile cannot be carried through a 180° turn.",
        );
      }
      if (angle > SpineAnalysis.CORNER_ANGLE) {
        corners.push(i);
      }
    }
    return corners;
  }

  private static describeCorner(before: SpineEdge, after: SpineEdge): SpineCorner {
    const inTangent = before.endTangent;
    const outTangent = after.startTangent;
    return {
      point: before.end,
      inTangent,
      outTangent,
      axis: inTangent.cross(outTangent).normalize(),
      angle: inTangent.angleTo(outTangent),
      // Two lines meet in a clean mitre: the bisector plane mirrors one
      // cylinder onto the other, so both trims share the same curve. A curved
      // leg's surface has no such mirror image; a round join fills that gap.
      join: before.isLine && after.isLine ? "mitre" : "round",
    };
  }

  /**
   * The axis the spine's tangent rotates around, = normalize(Σ ±Tᵢ × Tᵢ₊₁)
   * over tangents sampled along the spine, each term flipped to agree with
   * the first so an S-bend's opposite turns reinforce rather than cancel.
   * For a planar spine this is the plane normal; for a helix the coil axis.
   * Returns null for a straight spine (every cross product vanishes) and
   * "twisted" when the sampled axes disagree (a non-planar polyline).
   */
  private tangentRotationAxis(): Vector3d | null | "twisted" {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_CompCurve(this.wire, false);
    const u0 = adaptor.FirstParameter();
    const u1 = adaptor.LastParameter();
    const SAMPLES = 64;

    const tangents: Vector3d[] = [];
    const pnt = new oc.gp_Pnt();
    const vec = new oc.gp_Vec();
    for (let i = 0; i <= SAMPLES; i++) {
      const u = u0 + ((u1 - u0) * i) / SAMPLES;
      adaptor.D1(u, pnt, vec);
      const t = new Vector3d(vec.X(), vec.Y(), vec.Z());
      if (t.length() > 1e-9) {
        tangents.push(t.normalize());
      }
    }
    pnt.delete();
    vec.delete();
    adaptor.delete();

    // unit: dimensionless (unit-tangent cross products)
    const turns: Vector3d[] = [];
    for (let i = 0; i + 1 < tangents.length; i++) {
      const turn = tangents[i].cross(tangents[i + 1]);
      if (turn.length() > 1e-6) {
        turns.push(turn);
      }
    }
    if (turns.length === 0) {
      return null;
    }

    let axis = Vector3d.zero();
    for (const turn of turns) {
      axis = axis.add(turn.dot(turns[0]) < 0 ? turn.negate() : turn);
    }
    axis = axis.normalize();
    const aligned = turns.every(turn => Math.abs(turn.normalize().dot(axis)) >= SpineAnalysis.MAX_AXIS_DEVIATION);
    return aligned ? axis : "twisted";
  }

  /**
   * The fixed binormal for a straight spine, whose constant tangent turns
   * around nothing and so names no axis of its own. Any direction the tangent
   * isn't parallel to will serve, since OCC only needs `Normal = BiNormal ×
   * Tangent` to be a direction — so the profile plane's own "up" is kept
   * wherever it works, leaving the section's roll where every sweep built so
   * far has had it.
   *
   * It stops working when the spine runs along that very "up" — a profile
   * sketched on xy and swept along the y axis, say. The cross product then
   * vanishes, and rather than fail, MakePipeShell returns a flat zero-volume
   * sliver. The plane's normal takes over there, and is guaranteed to work:
   * it is perpendicular to the "up" the tangent has just proved itself
   * parallel to. It also keeps the drawn profile's footprint — its own "up"
   * leaves the section plane along with the spine, and the normal is what
   * arrives to replace it.
   */
  private static straightSpineBinormal(plane: Plane, tangent: Vector3d): Vector3d {
    const up = plane.yDirection;
    return Math.abs(up.dot(tangent)) < SpineAnalysis.MAX_BINORMAL_ALIGNMENT ? up : plane.normal;
  }
}
