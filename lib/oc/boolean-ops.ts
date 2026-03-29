import type { TopAbs_ShapeEnum, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { FaceOps } from "./face-ops.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Edge } from "../common/edge.js";
import { EdgeOps } from "./edge-ops.js";
import { Plane } from "../math/plane.js";
import { mod, sub } from "three/tsl";

export class BooleanOps {
  static fuseShapes(shape1: Shape, shape2: Shape): Shape {
    const result = BooleanOps.fuseShapesRaw(shape1.getShape(), shape2.getShape());
    return ShapeFactory.fromShape(result);
  }

  static fuseShapesRaw(shape1: TopoDS_Shape, shape2: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    try {
      const fuseProgress = new oc.Message_ProgressRange();
      const fuser = new oc.BRepAlgoAPI_Fuse(shape1, shape2, fuseProgress);
      fuser.SetCheckInverted(true);
      fuser.Build(fuseProgress);

      if (!fuser.IsDone()) {
        fuser.delete();
        throw new Error("Fuse operation failed");
      }

      fuseProgress.delete();

      const fusedResult = fuser.Shape();
      fuser.delete();
      return fusedResult;
    } catch (error) {
      throw new Error(`Error in fuseShapes: ${error}`);
    }
  }

  static fuseFaces(face1: TopoDS_Face, face2: TopoDS_Face): TopoDS_Face {
    const oc = getOC();
    try {
      const fusedResult = BooleanOps.fuseShapesRaw(face1, face2);
      console.log("Fused result is null:", fusedResult.IsNull());

      const freeBounds = new oc.ShapeAnalysis_FreeBounds(fusedResult, oc.Precision.Confusion(), true, false);

      const closedWiresCompound = freeBounds.GetClosedWires();

      let unifiedFace = null;

      if (closedWiresCompound && !closedWiresCompound.IsNull()) {
        const firstWire = Explorer.findFirstShapeOfType(closedWiresCompound, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
        return FaceOps.makeFace(oc.TopoDS.Wire(firstWire));
      }

      freeBounds.delete();

      return unifiedFace;
    } catch (error) {
      throw new Error(`Error in fuseFaces: ${error}`);
    }
  }

  static cutShapes(shape: Shape, tool: Shape): Shape {
    const result = BooleanOps.cutShapesRaw(shape.getShape(), tool.getShape());
    return ShapeFactory.fromShape(result);
  }

  static cutShapesRaw(shape: TopoDS_Shape, tool: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    const progress = new oc.Message_ProgressRange();
    const cutter = new oc.BRepAlgoAPI_Cut(shape, tool, progress);
    cutter.Build(progress);

    if (!cutter.IsDone()) {
      cutter.delete();
      progress.delete();
      throw new Error("Cut operation failed");
    }

    const result = cutter.Shape();
    cutter.delete();
    progress.delete();
    return result;
  }

  static cutMultiShape(stocks: Shape[], tools: Shape[], plane?: Plane, cutDistance: number = 0) {
    const oc = getOC();
    const stockList = new oc.TopTools_ListOfShape();
    for (const s of stocks) {
      stockList.Append(s.getShape());
    }

    const toolList = new oc.TopTools_ListOfShape();
    for (const t of tools) {
      toolList.Append(t.getShape());
    }

    const progress = new oc.Message_ProgressRange();
    const cutMaker = new oc.BRepAlgoAPI_Cut();
    cutMaker.SetArguments(stockList);
    cutMaker.SetTools(toolList);
    cutMaker.SetNonDestructive(true);
    cutMaker.Build(progress);

    const result = cutMaker.Shape();
    const resultSolids = Explorer.findShapes(result, Explorer.getOcShapeType("solid"));
    const wrappedResult = resultSolids.length > 0
      ? Solid.fromTopoDSSolid(Explorer.toSolid(resultSolids[0]))
      : ShapeFactory.fromShape(result);
    const modified = (shape: Shape) =>
      ShapeOps.shapeListToArray(cutMaker.Modified(shape.getShape()))
        .map(s => ShapeFactory.fromShape(s));

    // Build a map of all edges that came from the original stocks (unchanged or modified).
    // Any result edge not in this map is a new edge created by the cut (both opening and floor edges).
    const stockEdgeMap = new oc.TopTools_MapOfShape();
    for (const stock of stocks) {
      const rawEdges = Explorer.findShapes(stock.getShape(), Explorer.getOcShapeType("edge"));
      for (const rawEdge of rawEdges) {
        stockEdgeMap.Add(rawEdge);
        // Also track modified versions of this edge so we don't misidentify them as new.
        const modifiedList = cutMaker.Modified(rawEdge);
        while (modifiedList.Size() > 0) {
          stockEdgeMap.Add(modifiedList.First());
          modifiedList.RemoveFirst();
        }
        modifiedList.delete();
      }
    }

    const resultRawEdges = Explorer.findShapes(result, Explorer.getOcShapeType("edge"));
    const sectionEdges = resultRawEdges
      .filter(re => !stockEdgeMap.Contains(re))
      .map(re => Edge.fromTopoDSEdge(Explorer.toEdge(re)));

    // Classify section edges into start, end, and internal groups using signed
    // distance from the cut plane. Through-all cuts use min/max projection.
    const startEdges: Edge[] = [];
    const endEdges: Edge[] = [];
    const internalEdges: Edge[] = [];

    if (plane && sectionEdges.length > 0) {
      const tolerance = oc.Precision.Confusion();
      const isThroughAll = cutDistance === 0;

      const dists = sectionEdges.map(edge => ({
        edge,
        d: plane.signedDistanceToPoint(EdgeOps.getEdgeMidPoint(edge))
      }));

      const startDist = isThroughAll ? Math.max(...dists.map(e => e.d)) : 0;
      const endDist = isThroughAll ? Math.min(...dists.map(e => e.d)) : -cutDistance;

      for (const { edge, d } of dists) {
        if (Math.abs(d - startDist) < tolerance) {
          startEdges.push(edge);
        } else if (Math.abs(d - endDist) < tolerance) {
          endEdges.push(edge);
        } else {
          internalEdges.push(edge);
        }
      }
    }

    stockEdgeMap.delete();
    progress.delete();
    stockList.delete();
    toolList.delete();

    return { result: wrappedResult, modified, sectionEdges, startEdges, endEdges, internalEdges };
  }

  static fuseMultiShape(args: Shape[], tools: Shape[], checkDeleted: Shape[] = []): {
    result: Shape;
    modifiedShapes: Shape[];
    solids: Solid[];
  } {
    const oc = getOC();

    const argsCompound = ShapeOps.makeCompoundRaw(args.map(a => a.getShape()));
    const argumentsList = new oc.TopTools_ListOfShape();
    argumentsList.Append(argsCompound);

    const toolsList = new oc.TopTools_ListOfShape();
    for (const tool of tools) {
      toolsList.Append(tool.getShape());
    }

    const progress = new oc.Message_ProgressRange();
    new oc.BOPAlgo_CellsBuilder()

    const fuseMaker = new oc.BRepAlgoAPI_Fuse();
    fuseMaker.SetArguments(argumentsList);
    fuseMaker.SetTools(toolsList);
    fuseMaker.SetNonDestructive(true);
    fuseMaker.SetCheckInverted(true);
    fuseMaker.Build(progress);

    if (!fuseMaker.IsDone()) {
      fuseMaker.delete();
      toolsList.delete();
      argumentsList.delete();
      progress.delete();
      throw new Error('Fuse operation failed');
    }

    let resultShape = fuseMaker.Shape();
    const rawSolids = Explorer.findShapes(resultShape, Explorer.getOcShapeType("solid"));
    const solids = rawSolids.map(s => Solid.fromTopoDSSolid(Explorer.toSolid(s)));

    const modifiedShapes: Shape[] = [];
    for (const shape of checkDeleted) {
      if (fuseMaker.IsDeleted(shape.getShape())) {
        modifiedShapes.push(shape);
      }
    }

    fuseMaker.delete();
    toolsList.delete();
    argumentsList.delete();
    progress.delete();

    return { result: solids[0], modifiedShapes, solids };
  }

  static splitShape(shape: Shape, tool: Shape): Shape[] {
    const oc = getOC();
    const splitter = new oc.BOPAlgo_Splitter();
    splitter.SetRunParallel(true);
    splitter.SetNonDestructive(true);
    splitter.AddTool(tool.getShape());
    splitter.AddArgument(shape.getShape());

    const progress = new oc.Message_ProgressRange();
    splitter.Perform(progress);
    progress.delete();

    if (splitter.HasErrors()) {
      splitter.delete();
      throw new Error("Splitter failed");
    }

    const resultShape = splitter.Shape();
    splitter.delete();

    if (Explorer.isSolid(resultShape)) {
      return [ShapeFactory.fromShape(resultShape)];
    }

    return Explorer.findShapes(resultShape, Explorer.getOcShapeType("solid"))
      .map(s => ShapeFactory.fromShape(s));
  }

  static fuseMultiShapeWithCleanup(args: Shape[], tools: Shape[]): {
    newShapes: Shape[],
    modifiedShapes: Shape[]
  } {
    console.log('Fuse: Arguments count:', args.length);
    console.log('Fuse: Tools count:', tools.length);

    const fuseResult = BooleanOps.fuseMultiShape(args, tools, args);

    const resultShape = fuseResult.result;
    console.log('Fuse: Result shape type:', Explorer.getShapeType(resultShape.getShape()));
    const solids = fuseResult.solids;
    console.log('Fuse: Result solids count:', solids.length);

    if (solids.length === (args.length + tools.length)) {
      return {
        newShapes: tools,
        modifiedShapes: []
      }
    }

    const modifiedShapes = fuseResult.modifiedShapes;

    if (!modifiedShapes.length) {
      return {
        newShapes: tools,
        modifiedShapes: []
      }
    }

    const newShapes: Shape[] = [];

    for (const s of solids) {
      const existsInArgs = args.some(arg => arg.getShape().IsPartner(s.getShape()));

      console.log('Fuse: Solid exists in args:', existsInArgs);

      if (!existsInArgs) {
        newShapes.push(ShapeOps.cleanShape(s));
      }
    }

    return {
      newShapes: newShapes,
      modifiedShapes: Array.from(modifiedShapes)
    };
  }

  static commonMultiShape(args: Shape[], tools: Shape[], checkDeleted: Shape[] = []): {
    result: Shape;
    modifiedShapes: Shape[];
    solids: Solid[];
  } {
    const oc = getOC();

    const argsCompound = ShapeOps.makeCompoundRaw(args.map(a => a.getShape()));
    const argumentsList = new oc.TopTools_ListOfShape();
    argumentsList.Append(argsCompound);

    const toolsList = new oc.TopTools_ListOfShape();
    for (const tool of tools) {
      toolsList.Append(tool.getShape());
    }

    const progress = new oc.Message_ProgressRange();

    const commonMaker = new oc.BRepAlgoAPI_Common();
    commonMaker.SetArguments(argumentsList);
    commonMaker.SetTools(toolsList);
    commonMaker.SetNonDestructive(true);
    commonMaker.SetCheckInverted(true);
    commonMaker.Build(progress);

    if (!commonMaker.IsDone()) {
      commonMaker.delete();
      toolsList.delete();
      argumentsList.delete();
      progress.delete();
      throw new Error('Common operation failed');
    }

    let resultShape = commonMaker.Shape();
    const rawSolids = Explorer.findShapes(resultShape, Explorer.getOcShapeType("solid"));
    const solids = rawSolids.map(s => Solid.fromTopoDSSolid(Explorer.toSolid(s)));

    const modifiedShapes: Shape[] = [];
    for (const shape of checkDeleted) {
      if (commonMaker.IsDeleted(shape.getShape())) {
        modifiedShapes.push(shape);
      }
    }

    commonMaker.delete();
    toolsList.delete();
    argumentsList.delete();
    progress.delete();

    return { result: solids[0], modifiedShapes, solids };
  }

  static doShapesIntersect(shape1: Shape, shape2: Shape): boolean {
    const oc = getOC();
    const raw1 = shape1.getShape();
    const raw2 = shape2.getShape();

    const bbox1 = new oc.Bnd_Box();
    const bbox2 = new oc.Bnd_Box();
    oc.BRepBndLib.Add(raw1, bbox1, false);
    oc.BRepBndLib.Add(raw2, bbox2, false);

    if (bbox1.IsOut(bbox2)) {
      bbox1.delete();
      bbox2.delete();
      console.log(`Intersection test: Bounding boxes do not intersect.`);
      return false;
    }

    bbox1.delete();
    bbox2.delete();

    const progress = new oc.Message_ProgressRange();
    const distCalc = new oc.BRepExtrema_DistShapeShape(
      raw1, raw2,
      oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
      oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
      progress
    );

    const distance = distCalc.IsDone() ? distCalc.Value() : Infinity;
    distCalc.delete();

    console.log(`Intersection test: Minimum distance between shapes is ${distance}.`);
    if (distance <= 0) {
      console.log(`Intersection test: Shapes are separated by distance ${distance}.`);
      return true;
    }

    const common = new oc.BRepAlgoAPI_Common(raw1, raw2, progress);
    common.Build(new oc.Message_ProgressRange());

    if (!common.IsDone()) {
      common.delete();
      console.log(`Intersection test: Boolean common operation failed.`);
      return false;
    }

    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(common.Shape(), props, false, false, false);
    const volume = props.Mass();

    props.delete();
    common.delete();

    return volume > 1e-9;
  }
}
