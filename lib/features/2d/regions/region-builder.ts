// Builds the regions of a sketch — the cells its edges cut the plane into —
// and names each one by the statements on its outer loop.
//
// The arrangement is OCCT's: BOPAlgo_CellsBuilder splits every edge at its
// crossings, BRepAlgoAPI_Splitter partitions a bounded plane face by the
// pieces. Both keep history, so every boundary edge of every cell traces back
// to the sketch edge(s) it was cut from, and from there to the statement that
// drew it. Which side of that source edge the cell lies on completes the
// half-edge: the outer wire of a cell runs counter-clockwise about the cell's
// normal, so comparing the traversal direction with the source edge's own
// direction says left or right.
//
// The result is a topological description of each region — nothing in it
// depends on where the geometry sits, only on which statements bound it.

import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { Edge } from "../../../common/edge.js";
import { Face } from "../../../common/face.js";
import { Plane } from "../../../math/plane.js";
import { Point } from "../../../math/point.js";
import { Vector3d } from "../../../math/vector3d.js";
import { getOC } from "../../../oc/init.js";
import { Explorer } from "../../../oc/explorer.js";
import { Convert } from "../../../oc/convert.js";
import { FaceOps } from "../../../oc/face-ops.js";
import { EdgeOps } from "../../../oc/edge-ops.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { mmTol } from "../../../units/tolerance.js";
import { GeometrySceneObject } from "../geometry.js";
import { SketchStatementKeys } from "./statement-keys.js";
import { RegionKeyItem, formatRegionKey, formatRegionKeyItem } from "./region-key.js";

export type SketchRegion = {
  /** The cell, holes included — its inner loops are the shapes drawn inside it. */
  face: Face;
  /** The region's key, as `.region()` accepts it. */
  key: string;
  /** The key's items in loop order, starting from the oldest statement. */
  items: RegionKeyItem[];
  /** Position in the canonical order — what `.region(2)` selects. */
  index: number;
};

/** Edge roles that only say "the statement's one edge" — no sub-key needed. */
const DEFAULT_ROLES = new Set(['body', 'perimeter']);

type HalfEdge = RegionKeyItem & { order: number };

type PieceTable = {
  /** Hashed by IsSame — piece i (1-based) was cut from `sources[i]`. */
  index: any;
  sources: Edge[][];
  /** Pieces registered so far (the map's extent). */
  count: number;
  dispose(): void;
};

export class SketchRegionBuilder {
  private readonly ownerOf: Map<Edge, GeometrySceneObject>;
  private readonly labelCache = new Map<Edge, HalfEdge | null>();

  constructor(
    edgesWithOwner: Map<Edge, GeometrySceneObject>,
    private readonly plane: Plane,
    private readonly keys: SketchStatementKeys,
  ) {
    this.ownerOf = edgesWithOwner;
  }

  build(): SketchRegion[] {
    const sources = [...this.ownerOf.keys()];
    if (sources.length === 0) {
      return [];
    }
    const pieces = this.splitAtCrossings(sources);
    try {
      const faces = this.partitionPlane(pieces);
      const regions = faces.map(face => this.describe(face, pieces));
      return canonicalize(regions);
    } finally {
      pieces.dispose();
    }
  }

  /**
   * Every source edge split at its crossings with the others, each piece
   * remembering which source(s) it came from. Overlapping edges share one
   * piece with several sources.
   */
  private splitAtCrossings(sources: Edge[]): PieceTable {
    const oc = getOC();
    const index = new oc.TopTools_IndexedMapOfShape();
    const table: PieceTable = {
      index,
      sources: [],
      count: 0,
      dispose: () => index.delete(),
    };
    const register = (piece: TopoDS_Shape, source: Edge) => {
      const i = index.Add(piece);
      table.count = Math.max(table.count, i);
      const list = table.sources[i] ?? (table.sources[i] = []);
      if (!list.includes(source)) {
        list.push(source);
      }
    };

    if (sources.length === 1) {
      register(sources[0].getShape(), sources[0]);
      return table;
    }

    const builder = new oc.BOPAlgo_CellsBuilder();
    const args = new oc.TopTools_ListOfShape();
    for (const source of sources) {
      args.Append(source.getShape());
    }
    builder.SetArguments(args);
    builder.SetNonDestructive(true);
    builder.SetToFillHistory(true);
    const progress = new oc.Message_ProgressRange();
    try {
      builder.Perform(progress);
      if (builder.HasErrors()) {
        for (const source of sources) {
          register(source.getShape(), source);
        }
        return table;
      }
      builder.AddAllToResult(0, false);
      let split = 0;
      for (const source of sources) {
        const raw = source.getShape();
        const modified = ShapeOps.shapeListToArray(builder.Modified(raw));
        if (modified.length > 0) {
          split++;
          for (const piece of modified) {
            register(piece, source);
          }
        } else if (!builder.IsDeleted(raw)) {
          register(raw, source);
        }
      }
      if (split === 0) {
        // No history came back: take the builder's parts and attribute each
        // to the source(s) it lies on.
        const parts = Explorer.findShapes(builder.GetAllParts(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
        if (parts.length > sources.length) {
          table.sources = [];
          table.count = 0;
          index.Clear(false);
          const tol = mmTol(1e-5);
          for (const part of parts) {
            const wrapped = Edge.fromTopoDSEdge(oc.TopoDS.Edge(part));
            const owners = sources.filter(source => EdgeOps.edgeLiesOnEdge(wrapped, source, tol));
            for (const source of owners) {
              register(part, source);
            }
          }
        }
      }
      return table;
    } finally {
      progress.delete();
      args.delete();
      builder.delete();
    }
  }

  /** The cells of the plane bounded by the pieces — every face the splitter
   * makes that does not touch the bounding face's own edges. */
  private partitionPlane(pieces: PieceTable): TopoDS_Face[] {
    const oc = getOC();
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const [gpPln, disposePln] = Convert.toGpPln(this.plane);
    const pieceShapes: TopoDS_Shape[] = [];
    const allSources = pieces.sources.flat();
    for (let i = 1; i <= pieces.count; i++) {
      pieceShapes.push(pieces.index.FindKey(i));
    }
    const planeFace = FaceOps.makeFaceFromPlane2(gpPln, boundsAround(allSources, this.plane));
    const boundaryEdges = Explorer.findShapes(planeFace, EDGE);

    const splitter = new oc.BRepAlgoAPI_Splitter();
    const args = new oc.TopTools_ListOfShape();
    const tools = new oc.TopTools_ListOfShape();
    const progress = new oc.Message_ProgressRange();
    try {
      args.Append(planeFace);
      for (const piece of pieceShapes) {
        tools.Append(piece);
      }
      splitter.SetArguments(args);
      splitter.SetTools(tools);
      splitter.SetRunParallel(true);
      splitter.SetNonDestructive(true);
      splitter.SetCheckInverted(true);
      splitter.Build(progress);
      const result = splitter.Shape();

      // A piece the splitter cut further (it met the bounding face's edge)
      // keeps its sources under its new pieces.
      const extent = pieces.count;
      for (let i = 1; i <= extent; i++) {
        const piece = pieces.index.FindKey(i);
        for (const sub of ShapeOps.shapeListToArray(splitter.Modified(piece))) {
          const j = pieces.index.Add(sub);
          pieces.count = Math.max(pieces.count, j);
          if (!pieces.sources[j]) {
            pieces.sources[j] = pieces.sources[i];
          }
        }
      }

      const modifiedBoundary: TopoDS_Shape[] = [];
      for (const edge of boundaryEdges) {
        const modified = ShapeOps.shapeListToArray(splitter.Modified(edge));
        modifiedBoundary.push(...modified);
        if (!splitter.IsDeleted(edge) && modified.length === 0) {
          modifiedBoundary.push(edge);
        }
      }

      const faces = Explorer.findShapes(result, FACE).filter(face => {
        const edges = Explorer.findShapes(face, EDGE);
        return !edges.some(fe => modifiedBoundary.some(be => oc.TopoDS.Edge(fe).IsSame(be)));
      });
      return faces.map(face => stripDanglingWires(oc.TopoDS.Face(face)));
    } finally {
      progress.delete();
      tools.delete();
      args.delete();
      splitter.delete();
      disposePln();
    }
  }

  /** The region a cell is: its outer loop as half-edges of source statements. */
  private describe(raw: TopoDS_Face, pieces: PieceTable): { face: Face; halfEdges: HalfEdge[] } {
    const oc = getOC();
    const WIRE = oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

    // The cell's own normal: its outer wire runs counter-clockwise about it.
    const normal = FaceOps.calculateNormalRaw(raw);
    const cellLeftOfTraversal = normal.dot(this.plane.normal) > 0;

    const outer = oc.BRepTools.OuterWire(raw);
    const halfEdges: HalfEdge[] = [];
    const seen = new Set<string>();
    try {
      const wire = Explorer.findShapes<TopoDS_Wire>(raw, WIRE).find(w => w.IsSame(outer));
      // TopExp_Explorer composes each edge's orientation down the path (what
      // the side needs) but lists them in storage order; the wire explorer
      // walks them connected end to end (what a readable key needs).
      const oriented = wire ? Explorer.findShapes(wire, EDGE).map(e => oc.TopoDS.Edge(e)) : [];
      const edges = wire ? walkWire(oc.TopoDS.Wire(wire), raw, oriented) : [];
      for (const edge of edges) {
        const traversalForward = edge.Orientation() !== oc.TopAbs_Orientation.TopAbs_REVERSED;
        for (const source of this.sourcesOf(edge, pieces)) {
          const label = this.labelOf(source);
          if (!label) {
            continue;
          }
          const agrees = traversalAgreesWithSource(edge, oc.TopoDS.Edge(source.getShape()), traversalForward);
          const halfEdge: HalfEdge = { ...label, right: cellLeftOfTraversal !== agrees };
          const text = formatRegionKeyItem(halfEdge);
          if (!seen.has(text)) {
            seen.add(text);
            halfEdges.push(halfEdge);
          }
        }
      }
    } finally {
      outer.delete();
    }
    // Keys read counter-clockwise in the sketch plane; a cell whose normal
    // points the other way was walked clockwise.
    if (!cellLeftOfTraversal) {
      halfEdges.reverse();
    }
    return { face: Face.fromTopoDSFace(raw), halfEdges };
  }

  /** The source edge(s) a cell boundary edge was cut from. */
  private sourcesOf(edge: TopoDS_Edge, pieces: PieceTable): Edge[] {
    const i = pieces.index.FindIndex(edge);
    if (i > 0 && pieces.sources[i]) {
      return pieces.sources[i];
    }
    // No history for this edge — find the source it lies on.
    const mid = EdgeGeometry.midPoint(edge);
    const tol = mmTol(1e-5);
    for (const source of this.ownerOf.keys()) {
      if (EdgeGeometry.distanceToEdge(mid, getOC().TopoDS.Edge(source.getShape())) < tol) {
        return [source];
      }
    }
    return [];
  }

  /** The statement identity of a source edge plus its sub-key inside a
   * multi-edge statement; null when the owner has no key (never for a
   * sketch child, kept for safety). */
  private labelOf(source: Edge): HalfEdge | null {
    const cached = this.labelCache.get(source);
    if (cached !== undefined) {
      return cached;
    }
    const owner = this.ownerOf.get(source);
    const entity = owner ? this.keys.keyOf(owner) : null;
    if (!owner || !entity) {
      this.labelCache.set(source, null);
      return null;
    }
    const label: HalfEdge = {
      entity,
      path: edgePath(owner, source),
      right: false,
      order: this.keys.orderOf(owner),
    };
    this.labelCache.set(source, label);
    return label;
  }
}

/**
 * The wire's edges in connection order, each taken from `oriented` (the
 * same edges with their orientation composed from the face) so both the
 * order and the side are right. Edges the walk does not reach (a wire the
 * explorer cannot chain) follow in storage order.
 */
function walkWire(wire: TopoDS_Wire, face: TopoDS_Face, oriented: TopoDS_Edge[]): TopoDS_Edge[] {
  const oc = getOC();
  const explorer = new oc.BRepTools_WireExplorer(wire, face);
  const ordered: TopoDS_Edge[] = [];
  const taken = new Set<TopoDS_Edge>();
  try {
    while (explorer.More()) {
      const current = explorer.Current();
      const match = oriented.find(e => !taken.has(e) && e.IsSame(current));
      if (match) {
        taken.add(match);
        ordered.push(match);
      }
      explorer.Next();
    }
  } finally {
    explorer.delete();
  }
  for (const edge of oriented) {
    if (!taken.has(edge)) {
      ordered.push(edge);
    }
  }
  return ordered;
}

/** Sub-key of an edge inside its statement: none for a single-edge
 * statement, its role for a named edge (`top`), else its build index (`e3`). */
function edgePath(owner: GeometrySceneObject, edge: Edge): string[] {
  const edges = owner.getShapes({ excludeMeta: true, excludeGuide: false })
    .filter((s): s is Edge => s instanceof Edge);
  if (edges.length <= 1) {
    return [];
  }
  if (edge.role !== undefined && !DEFAULT_ROLES.has(edge.role)) {
    return [`${edge.role}${edge.roleIndex ?? ''}`];
  }
  const index = edges.indexOf(edge);
  return [`e${index + 1}`];
}

/**
 * Whether walking a cell boundary edge in its traversal direction runs the
 * same way as the source edge it was cut from. A piece shares its source's
 * curve, so the orientation flags say it directly — checked by evaluating
 * the source at the piece's mid parameter; when the curves differ the
 * tangents are compared at the closest point instead.
 */
function traversalAgreesWithSource(piece: TopoDS_Edge, source: TopoDS_Edge, traversalForward: boolean): boolean {
  const oc = getOC();
  const sourceForward = source.Orientation() !== oc.TopAbs_Orientation.TopAbs_REVERSED;
  const pieceAdaptor = new oc.BRepAdaptor_Curve(piece);
  const sourceAdaptor = new oc.BRepAdaptor_Curve(source);
  try {
    const tMid = (pieceAdaptor.FirstParameter() + pieceAdaptor.LastParameter()) / 2;
    const onPiece = Convert.toPoint(pieceAdaptor.Value(tMid), true);
    const onSource = Convert.toPoint(sourceAdaptor.Value(tMid), true);
    if (onPiece.distanceTo(onSource) < mmTol(1e-6)) {
      return traversalForward === sourceForward;
    }
    const traversal = EdgeGeometry.tangentAt(pieceAdaptor, tMid).multiply(traversalForward ? 1 : -1);
    const tSource = EdgeGeometry.closestParameter(onPiece, source);
    const along = EdgeGeometry.tangentAt(sourceAdaptor, tSource).multiply(sourceForward ? 1 : -1);
    return traversal.dot(along) > 0;
  } finally {
    sourceAdaptor.delete();
    pieceAdaptor.delete();
  }
}

class EdgeGeometry {
  static midPoint(edge: TopoDS_Edge): Point {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    try {
      return Convert.toPoint(adaptor.Value((adaptor.FirstParameter() + adaptor.LastParameter()) / 2), true);
    } finally {
      adaptor.delete();
    }
  }

  static tangentAt(adaptor: any, t: number): Vector3d {
    const oc = getOC();
    const pnt = new oc.gp_Pnt();
    const vec = new oc.gp_Vec();
    try {
      adaptor.D1(t, pnt, vec);
      return Convert.toVector3d(vec).normalize();
    } finally {
      vec.delete();
      pnt.delete();
    }
  }

  /** Parameter on `edge` of the point closest to `point`. */
  static closestParameter(point: Point, edge: TopoDS_Edge): number {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const found = EdgeGeometry.withExtrema(point, edge, extrema => {
        if (!extrema.IsDone() || extrema.NbSolution() === 0) {
          return null;
        }
        // On the edge's interior the solution carries a parameter; at an
        // end it is the vertex, so the parameter is that end's.
        if (Explorer.isEdge(extrema.SupportOnShape2(1))) {
          return extrema.ParOnEdgeS2(1).t;
        }
        const atFirst = Convert.toPoint(adaptor.Value(first), true);
        const atLast = Convert.toPoint(adaptor.Value(last), true);
        return point.distanceTo(atFirst) <= point.distanceTo(atLast) ? first : last;
      });
      return found ?? (first + last) / 2;
    } finally {
      adaptor.delete();
    }
  }

  static distanceToEdge(point: Point, edge: TopoDS_Edge): number {
    return EdgeGeometry.withExtrema(point, edge, extrema => extrema.IsDone() ? extrema.Value() : Infinity);
  }

  private static withExtrema<T>(point: Point, edge: TopoDS_Edge, read: (extrema: any) => T): T {
    const oc = getOC();
    const [gpPnt, disposePnt] = Convert.toGpPnt(point);
    const vertexMaker = new oc.BRepBuilderAPI_MakeVertex(gpPnt);
    const progress = new oc.Message_ProgressRange();
    const extrema = new oc.BRepExtrema_DistShapeShape(
      vertexMaker.Shape(),
      edge,
      oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
      oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
      progress,
    );
    try {
      return read(extrema);
    } finally {
      extrema.delete();
      progress.delete();
      vertexMaker.delete();
      disposePnt();
    }
  }
}

/**
 * Order the regions and their items canonically. Items sort by the age of
 * their statement (sketch order), then sub-key, then side; a region's items
 * are rotated to start at its oldest half-edge and regions sort by their
 * item lists — so `.region(0)` is the region on the sketch's first-drawn
 * geometry, new shapes drawn in empty space take the last positions, and
 * existing regions keep their relative order (a position only shifts when
 * a new region sorts before it: a split of older geometry).
 */
function canonicalize(regions: { face: Face; halfEdges: HalfEdge[] }[]): SketchRegion[] {
  const compareItems = (a: HalfEdge, b: HalfEdge) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    const pa = a.path.join('.');
    const pb = b.path.join('.');
    if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
    return Number(a.right) - Number(b.right);
  };

  const described = regions.map(({ face, halfEdges }) => {
    let first = 0;
    for (let i = 1; i < halfEdges.length; i++) {
      if (compareItems(halfEdges[i], halfEdges[first]) < 0) {
        first = i;
      }
    }
    const loopOrder = [...halfEdges.slice(first), ...halfEdges.slice(0, first)];
    const sorted = [...halfEdges].sort(compareItems);
    return { face, loopOrder, sorted };
  });

  described.sort((a, b) => {
    const n = Math.min(a.sorted.length, b.sorted.length);
    for (let i = 0; i < n; i++) {
      const c = compareItems(a.sorted[i], b.sorted[i]);
      if (c !== 0) {
        return c;
      }
    }
    return a.sorted.length - b.sorted.length;
  });

  return described.map(({ face, loopOrder }, index) => {
    const items = loopOrder.map(({ entity, path, right }) => ({ entity, path, right }));
    return { face, items, key: formatRegionKey(items), index };
  });
}

/** A bounded plane face large enough to enclose the edges with margin. */
function boundsAround(edges: Edge[], plane: Plane) {
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const edge of edges) {
    const bbox = ShapeOps.getBoundingBox(edge);
    for (const x of [bbox.minX, bbox.maxX]) {
      for (const y of [bbox.minY, bbox.maxY]) {
        for (const z of [bbox.minZ, bbox.maxZ]) {
          const uv = plane.worldToLocal(new Point(x, y, z));
          uMin = Math.min(uMin, uv.x);
          uMax = Math.max(uMax, uv.x);
          vMin = Math.min(vMin, uv.y);
          vMax = Math.max(vMax, uv.y);
        }
      }
    }
  }
  const half = Math.max(Math.abs(uMin), Math.abs(uMax), Math.abs(vMin), Math.abs(vMax), 1000) * 1.5;
  return { uMin: -half, uMax: half, vMin: -half, vMax: half };
}

/**
 * Drops the wires the splitter embeds for open edges ending inside a cell
 * (a line from a circle's centre): INTERNAL/EXTERNAL wires bound nothing,
 * and a cap face carrying one faults `BRepAdaptor_CompCurve`.
 */
function stripDanglingWires(face: TopoDS_Face): TopoDS_Face {
  const oc = getOC();
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
  const isDangling = (wire: TopoDS_Shape) => {
    const orientation = wire.Orientation();
    if (orientation === oc.TopAbs_Orientation.TopAbs_INTERNAL || orientation === oc.TopAbs_Orientation.TopAbs_EXTERNAL) {
      return true;
    }
    const edges = Explorer.findShapes(wire, EDGE);
    return edges.length > 0 && edges.every(e =>
      e.Orientation() === oc.TopAbs_Orientation.TopAbs_INTERNAL
      || e.Orientation() === oc.TopAbs_Orientation.TopAbs_EXTERNAL);
  };

  const dangling: TopoDS_Shape[] = [];
  const it = new oc.TopoDS_Iterator(face, true, true);
  while (it.More()) {
    if (isDangling(it.Value())) {
      dangling.push(it.Value());
    }
    it.Next();
  }
  it.delete();

  if (dangling.length > 0) {
    const builder = new oc.BRep_Builder();
    for (const wire of dangling) {
      builder.Remove(face, wire);
    }
    builder.delete();
  }
  return face;
}
