import type { BRepBuilderAPI_MakeShape, gp_Pln, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { WireOps } from "./wire-ops.js";
import { rad } from "../helpers/math-helpers.js";
import { ColorTransfer, type CarriedColor, type SourceColors } from "./color-transfer.js";
import { Explorer } from "./explorer.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { RenderSeams } from "./render-seams.js";
import { FaceQuery } from "./face-query.js";

export type FilletResult = {
  solids: Solid[];
  /** Maker history against the input solid — the caller records provenance. */
  history: ShapeHistory;
  /** The source's colours carried (and bled) onto the results — the caller records them. */
  colors: CarriedColor[];
};

/** The two edge breaks, for the messages they share. */
export type EdgeBreak = 'fillet' | 'chamfer';

export class FilletOps {
  /**
   * The edges of `edges` that lie between two faces of one surface: the
   * seam a boolean leaves when the kernel cannot merge such faces back into
   * one (see SameDomainMerge), not a corner. The surfaces meet at 180°
   * there, so a fillet or chamfer has nothing to break and the kernel
   * refuses the whole operation.
   */
  static seamsAmong(solid: Solid, edges: Edge[]): Edge[] {
    return edges.filter(edge => {
      const faces = solid.getFacesOfEdge(edge);
      return faces.length === 2 && FaceQuery.isSameSurface(faces[0], faces[1]);
    });
  }

  /**
   * How many seams (as `seamsAmong` finds them) bound the faces on either
   * side of `edges`: where a blend along those edges would have to end or
   * turn on a corner that is not there.
   */
  static seamsAround(solid: Solid, edges: Edge[]): number {
    const faces = new Set<Face>();
    for (const edge of edges) {
      for (const face of solid.getFacesOfEdge(edge)) {
        faces.add(face);
      }
    }
    const seen = new Set<Edge>();
    let count = 0;
    for (const face of faces) {
      for (const edge of face.getEdges()) {
        if (seen.has(edge) || edges.includes(edge)) {
          continue;
        }
        seen.add(edge);
        if (FilletOps.seamsAmong(solid, [edge]).length > 0) {
          count++;
        }
      }
    }
    return count;
  }

  /** The surface kinds the seams lie on, for a message: "sphere", or "sphere or torus". */
  private static seamSurfaces(solid: Solid, seams: Edge[]): string {
    const kinds = new Set<string>();
    for (const seam of seams) {
      const faces = solid.getFacesOfEdge(seam);
      if (faces.length > 0) {
        kinds.add(FaceQuery.getSurfaceType(faces[0]));
      }
    }
    return [...kinds].join(' or ') || 'surface';
  }

  /** The message for seams found in a selection: what they are, and whether anything was left to break. */
  static seamsMessage(op: EdgeBreak, solid: Solid, seams: Edge[], breakable: number): string {
    const total = seams.length + breakable;
    const where = `lie between two faces of one ${FilletOps.seamSurfaces(solid, seams)} — a seam left where a ` +
      `boolean could not merge the faces, not a corner — `;
    if (breakable === 0) {
      return `${op}: the ${total} selected edge(s) ${where}so there is nothing to ${op}. ` +
        `The solid was left un${op}ed.\n` +
        `Hint: select the edges where two different surfaces meet, e.g. ` +
        `edge().belongsToFace(<face>).belongsToFace(<neighbouring face>).`;
    }
    return `${op}: ${seams.length} of the ${total} selected edge(s) ${where}and were skipped; ` +
      `the other ${breakable} were ${op}ed.`;
  }

  /** The message for a kernel refusal: the usual cause, and the seam cause when seams bound the selection's faces. */
  static refusedMessage(op: EdgeBreak, value: string, solid: Solid, edges: Edge[]): string {
    const around = FilletOps.seamsAround(solid, edges);
    const seamCause = around > 0
      ? `, or the chain ends on a seam between two faces of one surface that a boolean left unmerged ` +
        `(${around} such seam(s) bound the faces next to the selection)`
      : '';
    return `${op}: the kernel could not build ${value} on the ${edges.length} selected edge(s). ` +
      `The ${op === 'fillet' ? 'radius' : 'distance'} may be too large for the adjacent faces${seamCause}. ` +
      `The solid was left un${op}ed.`;
  }

  static makeFillet(source: SourceColors, edges: Edge[], radius: number): FilletResult {
    const oc = getOC();
    const solid = source.shape;
    const maker = new oc.BRepFilletAPI_MakeFillet(solid.getShape(), oc.ChFi3d_FilletShape.ChFi3d_Rational);

    for (const edge of edges) {
      FilletOps.withEdge(edge, raw => maker.Add(radius, raw));
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create fillet.");
    }

    const result = maker.Shape();
    const solids = FilletOps.wrapResultSolids(result);
    solids.forEach(target => RenderSeams.throughHistory(target, [solid], maker));
    const colors = FilletOps.carryColors(source, solids, maker);
    const history = ShapeHistoryTracker.collect(maker, [solid]);
    maker.delete();
    return { solids, history, colors };
  }

  static makeChamfer(source: SourceColors, edges: Edge[], distance: number): FilletResult {
    const oc = getOC();
    const solid = source.shape;
    const maker = new oc.BRepFilletAPI_MakeChamfer(solid.getShape());

    for (const edge of edges) {
      FilletOps.withEdge(edge, raw => maker.Add(distance, raw));
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create chamfer.");
    }

    const result = maker.Shape();
    const solids = FilletOps.wrapResultSolids(result);
    solids.forEach(target => RenderSeams.throughHistory(target, [solid], maker));
    const colors = FilletOps.carryColors(source, solids, maker);
    const history = ShapeHistoryTracker.collect(maker, [solid]);
    maker.delete();
    return { solids, history, colors };
  }

  /** The source's colours through the maker, then bled onto the blend faces (see ColorTransfer). */
  private static carryColors(source: SourceColors, solids: Solid[], maker: BRepBuilderAPI_MakeShape): CarriedColor[] {
    const colors = ColorTransfer.applyThroughMaker([source], solids, maker);
    colors.push(...ColorTransfer.applyBleeding([source], solids, maker, undefined, colors));
    return colors;
  }

  /**
   * The maker's `Shape()` is a copy of its own that the wrappers never hold —
   * each takes a typed copy — so it is freed here with the explorer copies
   * it was walked through. The maker keeps the result for its history.
   */
  private static wrapResultSolids(result: TopoDS_Shape): Solid[] {
    const oc = getOC();
    try {
      if (Explorer.isSolid(result)) {
        return [Solid.fromTopoDSSolid(Explorer.toSolid(result))];
      }
      return Explorer.withShapes(result, oc.TopAbs_ShapeEnum.TopAbs_SOLID as any,
        raws => raws.map(r => Solid.fromTopoDSSolid(Explorer.toSolid(r))));
    } finally {
      result.delete();
    }
  }

  /** Feed the maker a typed copy of the edge's handle and free it after — the maker keeps its own. */
  private static withEdge(edge: Edge, fn: (raw: TopoDS_Edge) => void): void {
    const oc = getOC();
    const raw = oc.TopoDS.Edge(edge.getShape());
    try {
      fn(raw);
    } finally {
      raw.delete();
    }
  }

  private static withEdgeAndFace(edge: Edge, face: Face, fn: (rawEdge: TopoDS_Edge, rawFace: TopoDS_Face) => void): void {
    const oc = getOC();
    const rawFace = oc.TopoDS.Face(face.getShape());
    try {
      FilletOps.withEdge(edge, rawEdge => fn(rawEdge, rawFace));
    } finally {
      rawFace.delete();
    }
  }

  static makeChamferTwoDistances(source: SourceColors, edges: Edge[], distance1: number, distance2: number, faces: Face[], isAngle: boolean = false): FilletResult {
    const oc = getOC();
    const solid = source.shape;
    const maker = new oc.BRepFilletAPI_MakeChamfer(solid.getShape());

    for (let i = 0; i < edges.length; i++) {
      const face = faces[i];
      if (!face) {
        throw new Error("Chamfer: Failed to find common face for chamfer.");
      }

      FilletOps.withEdgeAndFace(edges[i], face, (rawEdge, rawFace) => {
        if (isAngle) {
          maker.AddDA(distance1, rad(distance2), rawEdge, rawFace);
        } else {
          maker.Add(distance1, distance2, rawEdge, rawFace);
        }
      });
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create chamfer.");
    }

    const result = maker.Shape();
    const solids = FilletOps.wrapResultSolids(result);
    solids.forEach(target => RenderSeams.throughHistory(target, [solid], maker));
    const colors = FilletOps.carryColors(source, solids, maker);
    const history = ShapeHistoryTracker.collect(maker, [solid]);
    maker.delete();
    return { solids, history, colors };
  }

  static fillet2d(shape: Wire | Edge, plane: Plane, radius: number): Wire {
    const wire = shape instanceof Wire ? shape : WireOps.makeWireFromEdges([shape]);
    const [pln, disposePln] = Convert.toGpPln(plane);
    const result = FilletOps.fillet2dRaw(wire.getShape() as TopoDS_Wire, pln, radius);
    disposePln();
    return Wire.fromTopoDSWire(result);
  }

  static fillet2dRaw(wire: TopoDS_Wire, plane: gp_Pln, radius: number): TopoDS_Wire {
    const oc = getOC();
    const isClosed = wire.Closed();
    const ownedEdges: TopoDS_Edge[] = [];

    // Extract edges in wire traversal order and canonicalize: for each REVERSED edge,
    // build a new FORWARD edge whose natural parameterization matches the wire traversal.
    // ChFi2d_FilletAPI returns modified edges whose natural direction matches the input's
    // natural direction, so aligning natural direction with wire traversal makes the
    // modEdges directly usable when rebuilding the final wire.
    const wireEdges: TopoDS_Edge[] = [];
    {
      const explorer = new oc.BRepTools_WireExplorer(wire);
      while (explorer.More()) {
        // `Current()` is a fresh copy, and so is the typed cast: only the cast lives on.
        const current = explorer.Current();
        const raw = oc.TopoDS.Edge(current);
        current.delete();
        const isReversed = raw.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
        if (!isReversed) {
          wireEdges.push(raw);
          ownedEdges.push(raw);
        } else {
          const adaptor = new oc.BRepAdaptor_Curve(raw);
          const edgeFirst = adaptor.FirstParameter();
          const edgeLast = adaptor.LastParameter();
          adaptor.delete();

          const curveHandle = oc.BRep_Tool.Curve(raw, 0, 1);
          if (!curveHandle) {
            raw.delete();
            explorer.delete();
            ownedEdges.forEach(e => e.delete());
            throw new Error("fillet2d: edge has no 3D curve");
          }

          const curve = curveHandle.returnValue;
          const reversedHandle = curve.Reversed();
          const newFirst = curve.ReversedParameter(edgeLast);
          const newLast = curve.ReversedParameter(edgeFirst);
          const maker = new oc.BRepBuilderAPI_MakeEdge(reversedHandle, newFirst, newLast);
          const newEdge = oc.TopoDS.Edge(maker.Edge());
          maker.delete();
          reversedHandle.delete();
          curve.delete();
          raw.delete();
          wireEdges.push(newEdge);
          ownedEdges.push(newEdge);
        }
        explorer.Next();
      }
      explorer.delete();
    }

    const currentEdges: TopoDS_Edge[] = wireEdges.slice();
    const filletArcs = new Map<number, TopoDS_Edge>();
    const maxCorners = isClosed ? currentEdges.length : currentEdges.length - 1;

    for (let cornerIndex = 0; cornerIndex < maxCorners; cornerIndex++) {
      const nextIndex = (cornerIndex + 1) % currentEdges.length;
      const edge1 = currentEdges[cornerIndex];
      const edge2 = currentEdges[nextIndex];

      const sharedVertex = oc.TopExp.LastVertex(edge1, true);
      const sharedPoint = oc.BRep_Tool.Pnt(sharedVertex);
      sharedVertex.delete();

      const filletAPI = new oc.ChFi2d_FilletAPI(edge1, edge2, plane);
      const success = filletAPI.Perform(radius);

      if (!success || filletAPI.NbResults(sharedPoint) === 0) {
        sharedPoint.delete();
        filletAPI.delete();
        continue;
      }

      const modEdge1 = new oc.TopoDS_Edge();
      const modEdge2 = new oc.TopoDS_Edge();
      const filletEdge = filletAPI.Result(sharedPoint, modEdge1, modEdge2, -1);
      sharedPoint.delete();
      filletAPI.delete();

      currentEdges[cornerIndex] = modEdge1;
      currentEdges[nextIndex] = modEdge2;
      filletArcs.set(cornerIndex, filletEdge);
      ownedEdges.push(modEdge1, modEdge2, filletEdge);
    }

    const edgeList = new oc.TopTools_ListOfShape();
    const append = (edge: TopoDS_Edge) => {
      // The list stores its own copy; the cast and the reference `Append`
      // hands back are both fresh handles to free.
      const typed = oc.TopoDS.Edge(edge);
      edgeList.Append(typed).delete();
      typed.delete();
    };
    for (let i = 0; i < currentEdges.length; i++) {
      append(currentEdges[i]);
      const arc = filletArcs.get(i);
      if (arc) {
        append(arc);
      }
    }

    const wireBuilder = new oc.BRepBuilderAPI_MakeWire();
    wireBuilder.Add(edgeList);
    edgeList.delete();

    if (!wireBuilder.IsDone()) {
      wireBuilder.delete();
      ownedEdges.forEach(e => e.delete());
      throw new Error("fillet2d: failed to build filleted wire");
    }

    const result = wireBuilder.Wire();
    wireBuilder.delete();
    ownedEdges.forEach(e => e.delete());
    return result;
  }
}
