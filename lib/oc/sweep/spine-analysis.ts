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
import type { SweepTransport } from "./sweep-spec.js";
import { mmTol } from "../../units/tolerance.js";

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
 * Compatibility name used by the corner builder. Transport selection and
 * profile placement are recorded separately in ResolvedSweepSpec.
 */
export type SpineTrihedron = SweepTransport;

/**
 * Reads a sweep spine as a sequence of G1 runs separated by sharp corners,
 * with the geometry each corner join needs (point, tangents, turn axis).
 */
export class SpineAnalysis {
  /** Junctions turning less than this (rad) are G1 and stay inside a run. */
  static readonly CORNER_ANGLE = 1e-3;

  /** A junction turning this far (rad) folds the spine back on itself: no pipe can cross it. */
  static readonly CUSP_ANGLE = Math.PI - 0.025;

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
   * General paths: constant frame on straight lines, fixed binormal on a
   * kernel-verified plane, otherwise explicit corrected Frenet. Helix axes
   * come only from geometry provenance in resolveSweepSpec, never sampling.
   */
  trihedron(profilePlane: Plane): SpineTrihedron {
    if (this.edges.every(edge => edge.isLine && edge.startTangent.cross(this.startTangent).length() < 1e-9)) {
      return { kind: "binormal", axis: SpineAnalysis.straightSpineBinormal(profilePlane, this.startTangent) };
    }
    const oc = getOC();
    const finder = new oc.BRepBuilderAPI_FindPlane(this.wire, mmTol(1e-6));
    try {
      if (!finder.Found()) return { kind: "correctedFrenet" };
      const plane = finder.Plane();
      const axis = plane.Axis();
      const dir = axis.Direction();
      try {
        return { kind: "binormal", axis: new Vector3d(dir.X(), dir.Y(), dir.Z()) };
      } finally { dir.delete(); axis.delete(); plane.delete(); }
    } finally { finder.delete(); }
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
