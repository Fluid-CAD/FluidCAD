import { TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { Edge } from "../common/edge.js";
import type { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Explorer } from "./explorer.js";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { FaceOps } from "./face-ops.js";
import { Face } from "../common/face.js";
import { ShapeOps } from "./shape-ops.js";
import { debug } from '../common/log.js';
import { BooleanBuilders } from "./boolean-builders.js";

export class FaceMaker2 {

  static getRegions(shapes: Array<Wire | Edge>, plane: Plane, drill: boolean = true) {
    const splitEdges = this.getSplitEdges(shapes);

    try {
      return drill ? this.getDrilledFaces(splitEdges, plane) : this.getFaces(splitEdges, plane);
    } finally {
      // The split edges only feed the face splitter; the caller's own
      // entities (handed back as they are for a lone edge) stay the caller's.
      for (const edge of splitEdges) {
        if (!(shapes as Shape[]).includes(edge)) edge.dispose();
      }
    }
  }

  private static getDrilledFaces(edges: Edge[], plane: Plane) {
    const allFaces = this.getFaces(edges, plane);
    const oc = getOC();

    // For each face, collect its outer wire edges and inner wire edges.
    // Every raw copy taken here is freed once the containment tree is built.
    const scratch: TopoDS_Shape[] = [];
    const faceData = allFaces.map(face => {
      const topoFace = oc.TopoDS.Face(face.getShape());
      const outerWire = oc.BRepTools.OuterWire(topoFace);
      const outerEdges = Explorer.findShapes(outerWire, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
      const innerEdges: TopoDS_Shape[] = [];
      const wires = Explorer.findShapes(topoFace, oc.TopAbs_ShapeEnum.TopAbs_WIRE);
      for (const w of wires) {
        if (!w.IsSame(outerWire)) {
          innerEdges.push(...Explorer.findShapes(w, oc.TopAbs_ShapeEnum.TopAbs_EDGE));
        }
      }
      scratch.push(topoFace, outerWire, ...wires, ...outerEdges, ...innerEdges);
      return { face, outerEdges, innerEdges };
    });

    // Build containment tree: face i is a child of face j if all of i's outer edges
    // are inner edges of j
    const parentOf = new Array<number>(allFaces.length).fill(-1);
    for (let i = 0; i < faceData.length; i++) {
      for (let j = 0; j < faceData.length; j++) {
        if (i === j) {
          continue;
        }
        const isChild = faceData[i].outerEdges.every(oe =>
          faceData[j].innerEdges.some(ie => oe.IsSame(ie))
        );
        if (isChild) {
          parentOf[i] = j;
          break;
        }
      }
    }

    Explorer.deleteAll(scratch);

    // Compute nesting depth for each face
    const depthCache = new Map<number, number>();
    const getDepth = (i: number): number => {
      if (parentOf[i] === -1) {
        return 0;
      }
      if (depthCache.has(i)) {
        return depthCache.get(i)!;
      }
      const d = 1 + getDepth(parentOf[i]);
      depthCache.set(i, d);
      return d;
    };

    // Even-odd rule: keep faces at even depth (0, 2, 4, ...)
    return allFaces.filter((_, i) => getDepth(i) % 2 === 0);
  }

  private static getFaces(edges: Edge[], plane: Plane) {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const oc = getOC();
    const planeFace = FaceOps.makeFaceFromPlane2(gpPln, this.computePlaneFaceBounds(edges, plane));

    // Collect boundary edges of the big face before splitting
    const boundaryEdges = Explorer.findShapes(planeFace, oc.TopAbs_ShapeEnum.TopAbs_EDGE);

    const splitter = new oc.BRepAlgoAPI_Splitter();

    // The splitter copies its argument and tool lists: ours go as soon as
    // they are set.
    const args = new oc.TopTools_ListOfShape();
    args.Append(planeFace).delete();
    splitter.SetArguments(args);
    args.delete();
    splitter.SetRunParallel(true);

    const toolsList = new oc.TopTools_ListOfShape();

    for (const edge of edges) {
      toolsList.Append(edge.getShape()).delete();
    }

    splitter.SetTools(toolsList);
    toolsList.delete();

    splitter.SetNonDestructive(true);
    splitter.SetCheckInverted(true);

    const progress = new oc.Message_ProgressRange();
    const scratch: TopoDS_Shape[] = [planeFace, ...boundaryEdges];
    try {
      splitter.Build(progress);
      const result = splitter.Shape();
      scratch.push(result);

      // Collect all modified boundary edges
      const modifiedBoundaryEdges: TopoDS_Shape[] = [];
      for (const bEdge of boundaryEdges) {
        const modified = ShapeOps.shapeListToArray(splitter.Modified(bEdge));
        scratch.push(...modified);
        for (const mod of modified) {
          modifiedBoundaryEdges.push(mod);
        }
        // Also include the original if it wasn't modified
        if (!splitter.IsDeleted(bEdge) && modified.length === 0) {
          modifiedBoundaryEdges.push(bEdge);
        }
      }

      // Filter: keep only faces with no boundary edges
      const allFaces = Explorer.findShapes(result, oc.TopAbs_ShapeEnum.TopAbs_FACE);
      scratch.push(...allFaces);
      const filtered = allFaces.filter(f => Explorer.withShapes(f, oc.TopAbs_ShapeEnum.TopAbs_EDGE, faceEdges =>
        !faceEdges.some(fe => modifiedBoundaryEdges.some(be => fe.IsSame(be))),
      ));

      return filtered.map(f => Face.fromTopoDSFace(this.stripDanglingWires(oc.TopoDS.Face(f))));
    } finally {
      Explorer.deleteAll(scratch);
      progress.delete();
      BooleanBuilders.release(splitter);
      dispose();
    }
  }

  /**
   * Removes the wires the splitter embeds for open edges that end inside a
   * region — a sketch line drawn from a circle's centre, a segment whose
   * far end lands inside a copied profile. They come back as wires whose
   * edges are all INTERNAL (or EXTERNAL) and bound nothing: a region is its
   * closed loops. Left in place they reach the extruded cap, and
   * `BRepAdaptor_CompCurve` over such a wire has no traversable edge — its
   * `Value()` faults inside OCC ("memory access out of bounds").
   */
  private static stripDanglingWires(face: TopoDS_Face): TopoDS_Face {
    const oc = getOC();
    const dangling: TopoDS_Shape[] = [];
    const it = new oc.TopoDS_Iterator(face, true, true);
    while (it.More()) {
      const wire = it.Value();
      if (this.isDanglingWire(wire)) {
        dangling.push(wire);
      } else {
        wire.delete();
      }
      it.Next();
    }
    it.delete();

    if (dangling.length > 0) {
      const builder = new oc.BRep_Builder();
      for (const wire of dangling) {
        builder.Remove(face, wire);
        wire.delete();
      }
      builder.delete();
    }
    return face;
  }

  private static isDanglingWire(wire: TopoDS_Shape): boolean {
    const oc = getOC();
    const orientation = wire.Orientation();
    if (orientation === oc.TopAbs_Orientation.TopAbs_INTERNAL
        || orientation === oc.TopAbs_Orientation.TopAbs_EXTERNAL) {
      return true;
    }
    return Explorer.withShapes(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, edges =>
      edges.length > 0 && edges.every(e =>
        e.Orientation() === oc.TopAbs_Orientation.TopAbs_INTERNAL
        || e.Orientation() === oc.TopAbs_Orientation.TopAbs_EXTERNAL,
      ));
  }

  /**
   * Sizes the bounded plane face used by `getFaces`'s splitter so it always
   * encloses the input edges with margin. The default ±1000 face used to
   * silently swallow sketches placed far from origin: edges that crossed the
   * boundary produced regions touching `boundaryEdges`, which the filter at
   * the end of `getFaces` then dropped — leaving an extrude with zero faces.
   */
  private static computePlaneFaceBounds(edges: Edge[], plane: Plane) {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const edge of edges) {
      const bbox = ShapeOps.getBoundingBox(edge);
      const corners = [
        new Point(bbox.minX, bbox.minY, bbox.minZ),
        new Point(bbox.maxX, bbox.minY, bbox.minZ),
        new Point(bbox.minX, bbox.maxY, bbox.minZ),
        new Point(bbox.maxX, bbox.maxY, bbox.minZ),
        new Point(bbox.minX, bbox.minY, bbox.maxZ),
        new Point(bbox.maxX, bbox.minY, bbox.maxZ),
        new Point(bbox.minX, bbox.maxY, bbox.maxZ),
        new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
      ];
      for (const c of corners) {
        const uv = plane.worldToLocal(c);
        if (uv.x < uMin) { uMin = uv.x; }
        if (uv.x > uMax) { uMax = uv.x; }
        if (uv.y < vMin) { vMin = uv.y; }
        if (uv.y > vMax) { vMax = uv.y; }
      }
    }

    const half = Math.max(
      Math.abs(uMin), Math.abs(uMax), Math.abs(vMin), Math.abs(vMax), 1000,
    ) * 1.5;
    return { uMin: -half, uMax: half, vMin: -half, vMax: half };
  }

  private static getSplitEdges(shapes: Array<Wire | Edge>) {
    const oc = getOC();
    debug('Getting split edges for shapes:', shapes.length);

    if (shapes.length === 1) {
      if (shapes[0] instanceof Edge) {
        debug('Single edge shape, using directly as split edge');
        return [shapes[0] as Edge];
      }
    }

    // The general fuse of the shapes is every piece they split each other
    // into — what a cells builder's parts are with all of them kept — run
    // through the API algorithm, which releases its intersection data
    // (BooleanBuilders); BOPAlgo_CellsBuilder never does.
    const generalFuse = new oc.BRepAlgoAPI_BuilderAlgo();
    const argsList = new oc.TopTools_ListOfShape();
    const progress = new oc.Message_ProgressRange();
    try {
      for (const shape of shapes) {
        argsList.Append(shape.getShape()).delete();
      }

      generalFuse.SetArguments(argsList);
      generalFuse.SetNonDestructive(true);
      generalFuse.Build(progress);

      if (!generalFuse.IsDone() || generalFuse.HasErrors()) {
        return shapes;
      }

      const allParts = generalFuse.Shape();
      try {
        return Explorer.withShapes(allParts, oc.TopAbs_ShapeEnum.TopAbs_EDGE, raws =>
          raws.map(e => Edge.fromTopoDSEdge(oc.TopoDS.Edge(e))));
      } finally {
        allParts.delete();
      }
    } finally {
      BooleanBuilders.release(generalFuse);
      argsList.delete();
      progress.delete();
    }
  }
}
