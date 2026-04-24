import type { TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { EdgeOps } from "./edge-ops.js";
import { Plane } from "../math/plane.js";

export class BooleanOps {
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
    cutMaker.SetRunParallel(true);
    cutMaker.Build(progress);

    const result = cutMaker.Shape();
    const resultSolids = Explorer.findShapes(result, Explorer.getOcShapeType("solid"));
    const wrappedResult = resultSolids.length > 0
      ? Solid.fromTopoDSSolid(Explorer.toSolid(resultSolids[0]))
      : ShapeFactory.fromShape(result);
    const modified = (shape: Shape) =>
      ShapeOps.shapeListToArray(cutMaker.Modified(shape.getShape()))
        .map(s => ShapeFactory.fromShape(s));

    // Build maps of all edges and faces that came from the original stocks (unchanged or modified).
    // Any result edge/face not in these maps is new, created by the cut.
    const stockEdgeMap = new oc.TopTools_MapOfShape();
    const stockFaceMap = new oc.TopTools_MapOfShape();
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

      const rawFaces = Explorer.findShapes(stock.getShape(), Explorer.getOcShapeType("face"));
      for (const rawFace of rawFaces) {
        stockFaceMap.Add(rawFace);
        const modifiedList = cutMaker.Modified(rawFace);
        while (modifiedList.Size() > 0) {
          stockFaceMap.Add(modifiedList.First());
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

    const resultRawFaces = Explorer.findShapes(result, Explorer.getOcShapeType("face"));
    const internalFaces = resultRawFaces
      .filter(rf => !stockFaceMap.Contains(rf))
      .map(rf => Face.fromTopoDSFace(Explorer.toFace(rf)));

    stockEdgeMap.delete();
    stockFaceMap.delete();
    progress.delete();
    stockList.delete();
    toolList.delete();

    return { result: wrappedResult, modified, sectionEdges, startEdges, endEdges, internalEdges, internalFaces };
  }

  static fuse(args: Shape[], opts?: { glue?: 'full' | 'shift' }): {
    result: Shape[];
    modifiedShapes: Shape[];
    newShapes: Shape[];
  } {
    const oc = getOC();
    const builder = new oc.BRepAlgoAPI_Fuse();
    builder.SetNonDestructive(true);
    builder.SetCheckInverted(true);
    builder.SetRunParallel(true);
    if (opts?.glue === 'full') {
      builder.SetGlue((oc as any).BOPAlgo_GlueEnum.BOPAlgo_GlueFull);
    } else if (opts?.glue === 'shift') {
      builder.SetGlue((oc as any).BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    }

    const argsList = new oc.TopTools_ListOfShape();
    for (const arg of args) {
      argsList.Append(arg.getShape());
    }

    const empty = ShapeOps.makeCompoundRaw([])
    const list = new oc.TopTools_ListOfShape();
    list.Append(empty);
    builder.SetArguments(list);
    builder.SetTools(argsList);


    const progress = new oc.Message_ProgressRange();
    const tBuild = performance.now();
    builder.Build(progress);
    console.log(`[perf] BooleanOps.fuse.Build (args=${args.length}): ${(performance.now() - tBuild).toFixed(1)} ms`);
    const tSimplify = performance.now();
    builder.SimplifyResult(false, true, oc.Precision.Angular());
    console.log(`[perf] BooleanOps.fuse.SimplifyResult: ${(performance.now() - tSimplify).toFixed(1)} ms`);

    const resultShape = builder.Shape();

    const tExplore = performance.now();
    const rawShapes = Explorer.findAllShapes(resultShape);
    console.log(`[perf] BooleanOps.fuse.findAllShapes (count=${rawShapes.length}): ${(performance.now() - tExplore).toFixed(1)} ms`);
    const result = rawShapes.map(s => ShapeFactory.fromShape(s));

    const modifiedShapes: Shape[] = [];
    for (const shape of args) {
      if (builder.IsDeleted(shape.getShape())) {
        modifiedShapes.push(shape);
      }
    }

    builder.delete();
    progress.delete();

    const newShapes: Shape[] = [];

    const tPartner = performance.now();
    for (const s of result) {
      const existsInArgs = args.some(arg => arg.getShape().IsPartner(s.getShape()));

      if (!existsInArgs) {
        newShapes.push(s);
      }
    }
    console.log(`[perf] BooleanOps.fuse.IsPartner check (result=${result.length} x args=${args.length}): ${(performance.now() - tPartner).toFixed(1)} ms`);

    return { result, newShapes, modifiedShapes };
  }

  static fuseFaces(args: Shape[]): {
    result: Shape[];
    modifiedShapes: Shape[];
    newShapes: Shape[];
  } {
    const oc = getOC();
    const builder = new oc.BRepAlgoAPI_Fuse();
    builder.SetNonDestructive(true);
    builder.SetRunParallel(true);

    const argsList = new oc.TopTools_ListOfShape();
    for (const arg of args) {
      argsList.Append(arg.getShape());
    }

    const empty = ShapeOps.makeCompoundRaw([])
    const list = new oc.TopTools_ListOfShape();
    list.Append(empty);
    builder.SetArguments(list);

    builder.SetTools(argsList);

    const progress = new oc.Message_ProgressRange();
    builder.Build(progress);

    const resultShape = builder.Shape();

    const unify = new oc.ShapeUpgrade_UnifySameDomain(resultShape, true, true, false);
    unify.Build();
    const mergedShape = unify.Shape();

    const rawShapes = Explorer.findAllShapes(mergedShape);

    if (rawShapes.length === args.length || rawShapes.length === 0) {
      return {
        result: args,
        newShapes: [],
        modifiedShapes: []
      }
    }

    console.log('FuseMultiShape: Result shapes count:', rawShapes.length);
    const result = rawShapes.map(s => ShapeFactory.fromShape(s));

    const modifiedShapes: Shape[] = [];
    for (const shape of args) {
      if (builder.IsDeleted(shape.getShape())) {
        console.log('=======', 'Shape was deleted in fuse:', shape);
        modifiedShapes.push(shape);
      }
    }

    builder.delete();
    progress.delete();

    const newShapes: Shape[] = [];

    for (const s of result) {
      const existsInArgs = args.some(arg => arg.getShape().IsPartner(s.getShape()));

      if (!existsInArgs) {
        newShapes.push(s);
      }
    }

    const cleanResult = result.map(s => ShapeOps.cleanShape(s));
    const cleanNewShapes = newShapes.map(s => ShapeOps.cleanShape(s));

    return { result: cleanResult, newShapes: cleanNewShapes, modifiedShapes };
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

  static common(args: Shape[]): {
    result: Shape[];
    modifiedShapes: Shape[];
    newShapes: Shape[];
  } {
    const oc = getOC();

    const argsList = new oc.TopTools_ListOfShape();
    for (const arg of args) {
      argsList.Append(arg.getShape());
    }

    const empty = ShapeOps.makeCompoundRaw([])
    const list = new oc.TopTools_ListOfShape();
    list.Append(empty);
    const progress = new oc.Message_ProgressRange();

    const builder = new oc.BOPAlgo_CellsBuilder();
    builder.SetArguments(argsList);
    builder.SetNonDestructive(true);
    builder.SetCheckInverted(true);
    builder.SetRunParallel(true);
    builder.Perform(progress);

    if (builder.HasErrors()) {
      builder.delete();
      progress.delete();
      list.delete();
      throw new Error('Common operation failed');
    }

    builder.RemoveAllFromResult();
    const inside = new oc.TopTools_ListOfShape();
    for (const arg of args) {
      inside.Append(arg.getShape());
    }

    const outside = new oc.TopTools_ListOfShape();
    builder.AddToResult(inside, outside, 0, false);
    builder.MakeContainers()

    const resultShape = builder.Shape();

    const rawShapes = Explorer.findAllShapes(resultShape);
    const result = rawShapes.map(s => ShapeFactory.fromShape(s));
    console.log('Common operation: result shape type:', rawShapes.length);

    const modifiedShapes: Shape[] = [];

    for (const shape of args) {
      if (builder.IsDeleted(shape.getShape())) {
        modifiedShapes.push(shape);
      }
      else {
        const modified = builder.Modified(shape.getShape());
        if (modified.Size() > 0) {
          modifiedShapes.push(shape);
        }
      }
    }

    builder.delete();
    progress.delete();

    const newShapes: Shape[] = [];

    for (const s of result) {
      const existsInArgs = args.some(arg => arg.getShape().IsPartner(s.getShape()));

      if (!existsInArgs) {
        newShapes.push(s);
      }
    }

    const cleanResult = result.map(s => ShapeOps.cleanShape(s));
    const cleanNewShapes = newShapes.map(s => ShapeOps.cleanShape(s));

    console.log('Common operation: result shapes count:', cleanResult.length);
    console.log('Common operation: new shapes count:', cleanNewShapes.length);
    console.log('Common operation: modified shapes count:', modifiedShapes.length);

    return { result: cleanResult, newShapes: cleanNewShapes, modifiedShapes };
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

    distCalc.SetMultiThread(true);

    const distance = distCalc.IsDone() ? distCalc.Value() : Infinity;
    distCalc.delete();

    console.log(`Intersection test: Minimum distance between shapes is ${distance}.`);
    if (distance <= 0) {
      console.log(`Intersection test: Shapes are separated by distance ${distance}.`);
      return true;
    }

    const common = new oc.BRepAlgoAPI_Common(raw1, raw2, progress);
    common.SetRunParallel(true);
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
