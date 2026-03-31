import { TopoDS_Shape } from "occjs-wrapper";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { Explorer } from "./explorer.js";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { FaceOps } from "./face-ops.js";
import { Face } from "../common/face.js";
import { ShapeOps } from "./shape-ops.js";

export class FaceMaker2 {
  static getFaces(shapes: Array<Wire | Edge>, plane: Plane, drill: boolean = true) {
    const splitEdges = this.getSplitEdges(shapes);
    if (drill) {
      const faces = this.getDrilledFaces(splitEdges, plane);
      return faces;
    }
    const faces = this.getSplitFaces(splitEdges, plane);
    return faces;
  }

  private static getDrilledFaces(edges: Edge[], plane: Plane) {
    const allFaces = this.getSplitFaces(edges, plane);
    const oc = getOC();

    // For each face, collect its outer wire edges and inner wire edges
    const faceData = allFaces.map(face => {
      const topoFace = oc.TopoDS.Face(face.getShape());
      const outerWire = oc.BRepTools.OuterWire(topoFace);
      const outerEdges = Explorer.findShapes(outerWire, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
      const innerEdges: TopoDS_Shape[] = [];
      const wires = Explorer.findShapes(topoFace, oc.TopAbs_ShapeEnum.TopAbs_WIRE);
      for (const w of wires) {
        const wire = oc.TopoDS.Wire(w);
        if (!wire.IsSame(outerWire)) {
          innerEdges.push(...Explorer.findShapes(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE));
        }
      }
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

  private static getSplitFaces(edges: Edge[], plane: Plane) {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const oc = getOC();
    const planeFace = FaceOps.makeFaceFromPlane2(gpPln);

    // Collect boundary edges of the big face before splitting
    const boundaryEdges = Explorer.findShapes(planeFace, oc.TopAbs_ShapeEnum.TopAbs_EDGE);

    const splitter = new oc.BRepAlgoAPI_Splitter();
    const objects = new oc.TopTools_ListOfShape();
    objects.Append(planeFace);
    splitter.SetArguments(objects);
    const toolsList = new oc.TopTools_ListOfShape();
    for (const edge of edges) {
      toolsList.Append(edge.getShape());
    }
    splitter.SetTools(toolsList);
    splitter.SetNonDestructive(true);
    splitter.SetCheckInverted(true);
    const progress = new oc.Message_ProgressRange();
    splitter.Build(progress);
    const result = splitter.Shape();

    // Collect all modified boundary edges
    const modifiedBoundaryEdges: TopoDS_Shape[] = [];
    for (const bEdge of boundaryEdges) {
      const modified = ShapeOps.shapeListToArray(splitter.Modified(bEdge));
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
    const filtered = allFaces.filter(f => {
      const faceEdges = Explorer.findShapes(f, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
      return !faceEdges.some(fe =>
        modifiedBoundaryEdges.some(be => oc.TopoDS.Edge(fe).IsSame(be))
      );
    });

    progress.delete();
    splitter.delete();
    dispose();

    return filtered.map(f => Face.fromTopoDSFace(oc.TopoDS.Face(f)));
  }

  private static getSplitEdges(shapes: Array<Wire | Edge>) {
    const oc = getOC();
    console.log('Getting split edges for shapes:', shapes.length);

    if (shapes.length === 1) {
      if (shapes[0] instanceof Edge) {
        console.log('Single edge shape, using directly as split edge');
        return [shapes[0] as Edge];
      }
    }

    const cellsBuilder = new oc.BOPAlgo_CellsBuilder();
    const argsList = new oc.TopTools_ListOfShape();

    for (const shape of shapes) {
      argsList.Append(shape.getShape());
    }

    cellsBuilder.SetArguments(argsList);
    cellsBuilder.SetNonDestructive(true);

    const progress = new oc.Message_ProgressRange();
    cellsBuilder.Perform(progress);

    if (cellsBuilder.HasErrors()) {
      cellsBuilder.delete();
      argsList.delete();
      progress.delete();

      return shapes;
    }

    cellsBuilder.AddAllToResult(0, false);
    const allParts = cellsBuilder.GetAllParts();
    return Explorer.findShapes(allParts, oc.TopAbs_ShapeEnum.TopAbs_EDGE).map(e =>
      Edge.fromTopoDSEdge(oc.TopoDS.Edge(e))
    );
  }
}
