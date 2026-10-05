import type { BRepAlgoAPI_Cut, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
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
import { mmTol, mmTol3 } from "../units/tolerance.js";
import { DirectFaces, DirectFacesResult } from "./direct-faces.js";
import { SameDomainMerge, SameDomainMergeResult } from "./same-domain-merge.js";
import { requireValidSolid } from "./solid-validation.js";
import { ShapeValidator } from "./shape-validator.js";

export class BooleanOps {
  // Fuzzy tolerance (mm) for the feature cut/fuse builders. A swept tube whose
  // path lies on a face it's cut from / fused to (e.g. a helical thread at the
  // cylinder's own radius) touches that face tangentially along the contact
  // curves; at zero fuzz OCCT's BOPAlgo silently no-ops (cut removes nothing,
  // fuse returns an empty compound → "Unknown shape type"). A small fuzzy value
  // resolves the near-coincident contact into clean intersections. 1e-4 is the
  // smallest that works reliably here (1e-5 lands in a worse-than-zero regime);
  // at 1e-4 mm it's far below any real feature size, so well-separated geometry
  // is unaffected. Authored in mm and read in the active unit: a metre
  // document would otherwise fuzz at 0.1 mm and merge real 0.2 mm gaps.
  private static get FEATURE_BOOLEAN_FUZZY(): number {
    return mmTol(1e-4);
  }

  /**
   * Boolean inputs that hold two coincident periodic surfaces of opposite
   * handedness (a clockwise-arc ear and the boss sharing its rounded top, a
   * mirrored boss on its twin) are normalized to direct frames before the
   * builder sees them: the face merge the builders run afterwards corrupts
   * such a pair, and it cannot be fed a normalized result — see DirectFaces.
   * Inputs without such a pair pass through untouched, so their face and
   * edge enumeration stays exactly what the caller built.
   */
  private static normalizeMixedInputs(raws: TopoDS_Shape[]): { raws: TopoDS_Shape[]; direct: DirectFacesResult | null } {
    if (raws.length === 0) {
      return { raws, direct: null };
    }
    const compound = ShapeOps.makeCompoundRaw(raws);
    if (!DirectFaces.hasMixedHandedness(compound)) {
      return { raws, direct: null };
    }
    const direct = DirectFaces.applyRaw(compound);
    return { raws: raws.map(r => direct.modified(r)), direct };
  }

  /**
   * The builder's lineage queries, addressed by the pre-normalization inputs
   * the caller holds: each query first follows the input through the
   * rebuild. An input the rebuild copied but the boolean left alone still
   * reports its rebuilt copy as its image, since that copy is what the result
   * contains. `result` stands in for the builder's shape when the result was
   * simplified outside it — see `simplifyResult`.
   */
  private static adaptMaker(builder: any, direct: DirectFacesResult | null, result?: TopoDS_Shape): any {
    const oc = getOC();
    const through = (s: TopoDS_Shape): TopoDS_Shape => direct?.modifiedOrNull(s) ?? s;
    const listOf = (items: TopoDS_Shape[]) => {
      const list = new oc.TopTools_ListOfShape();
      for (const item of items) {
        list.Append(item);
      }
      return list;
    };
    return {
      Shape: () => result ?? builder.Shape(),
      IsDone: () => builder.IsDone(),
      HasErrors: () => builder.HasErrors(),
      HasWarnings: () => builder.HasWarnings(),
      History: () => builder.History(),
      Modified: (s: TopoDS_Shape) => {
        const rebuilt = through(s);
        if (rebuilt.IsSame(s)) {
          return builder.Modified(s);
        }
        const images = ShapeOps.shapeListToArray(builder.Modified(rebuilt));
        return listOf(images.length > 0 || builder.IsDeleted(rebuilt) ? images : [rebuilt]);
      },
      Generated: (s: TopoDS_Shape) => builder.Generated(through(s)),
      IsDeleted: (s: TopoDS_Shape) => builder.IsDeleted(through(s)),
      delete: () => builder.delete(),
    };
  }

  static cutShapes(shape: Shape, tool: Shape): Shape {
    const result = BooleanOps.cutShapesRaw(shape.getShape(), tool.getShape());
    return ShapeFactory.fromShape(result);
  }

  static cutShapesRaw(shape: TopoDS_Shape, tool: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    const inputs = BooleanOps.normalizeMixedInputs([shape, tool]);
    const progress = new oc.Message_ProgressRange();
    let cutter: BRepAlgoAPI_Cut;
    try {
      cutter = new oc.BRepAlgoAPI_Cut(inputs.raws[0], inputs.raws[1], progress);
      cutter.Build(progress);
    } catch {
      progress.delete();
      inputs.direct?.dispose();
      throw new Error("Cut failed");
    }

    if (!cutter.IsDone() || cutter.HasErrors()) {
      cutter.delete();
      progress.delete();
      inputs.direct?.dispose();
      throw new Error("Cut failed");
    }

    const result = cutter.Shape();
    cutter.delete();
    progress.delete();
    inputs.direct?.dispose();
    return result;
  }

  /** Shared feature/hole cut policy and history. Caller owns result and dispose(). */
  static cutWithHistory(stocks: TopoDS_Shape[], tools: TopoDS_Shape[], options: { validate?: boolean; stage?: string } = {}) {
    const oc = getOC();
    const stage = options.stage ?? "Cut result";
    const inputs = BooleanOps.normalizeMixedInputs([...stocks, ...tools]);
    const stockRaws = inputs.raws.slice(0, stocks.length);
    const stockList = new oc.TopTools_ListOfShape();
    const toolList = new oc.TopTools_ListOfShape();
    const progress = new oc.Message_ProgressRange();
    const builder = new oc.BRepAlgoAPI_Cut();
    const maker = inputs.direct ? BooleanOps.adaptMaker(builder, inputs.direct) : builder;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      builder.delete(); progress.delete(); stockList.delete(); toolList.delete(); inputs.direct?.dispose();
    };
    let result: TopoDS_Shape | undefined;
    try {
      stockRaws.forEach(shape => stockList.Append(shape));
      inputs.raws.slice(stocks.length).forEach(shape => toolList.Append(shape));
      builder.SetArguments(stockList); builder.SetTools(toolList);
      builder.SetNonDestructive(true); builder.SetRunParallel(true);
      builder.SetFuzzyValue(BooleanOps.FEATURE_BOOLEAN_FUZZY);
      builder.Build(progress);
      if (!builder.IsDone() || builder.HasErrors()) throw new Error(`${stage}: the boolean operation reported an error.`);
      if (builder.HasWarnings()) console.warn(`${stage}: kernel warnings reported.`);
      result = builder.Shape();
      if (result.IsNull()) throw new Error(`${stage}: the boolean operation returned a null shape.`);
      const contents = new oc.TopoDS_Iterator(result, true, true);
      let empty: boolean;
      try { empty = result.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND && !contents.More(); }
      finally { contents.delete(); }
      // An empty, successful CUT is valid only when its history deletes every
      // stock. No solid wrappers are constructed for complete removal.
      if (empty && !stocks.every(stock => maker.IsDeleted(stock))) {
        throw new Error(`${stage}: empty result without complete stock-removal history.`);
      }
      if (empty) {
        // OCCT can also return an empty compound AND deletion history after
        // a failed intersection. The tools' total volume must at least cover
        // each stock. Compare individually: distinct stocks may overlap.
        const available = tools.reduce((sum, tool) => sum + Math.abs(ShapeValidator.signedVolume(tool)), 0);
        for (const stock of stocks) {
          const required = Math.abs(ShapeValidator.signedVolume(stock));
          // Numerical allowance for adaptive volume integration, not added
          // geometric/boolean fuzz. This is only a necessary condition.
          const errorBudget = Math.max(mmTol3(1e-6), required * 1e-5);
          if (!Number.isFinite(available) || !Number.isFinite(required) || required - available > errorBudget) {
            throw new Error(`${stage}: empty result is inconsistent with cutter volume (${available}) and stock volume (${required}).`);
          }
        }
      }
      if (options.validate && !empty) requireValidSolid(result, stage);
      return { result, maker, stockRaws, empty, dispose };
    } catch (error) {
      result?.delete(); dispose();
      throw error;
    }
  }

  /**
   * `tools` cut out of every stock — one boolean per stock, because a cut
   * subtracts from each body on its own and no single builder call says
   * that. Stocks handed to one builder as separate arguments are intersected
   * with each other before the tools reach them: bodies resting against one
   * another come back with each other's outline imprinted and every face
   * around the contact rebuilt, bodies that overlap come back split along
   * each other. Stocks bundled into one compound are an argument that
   * interferes with itself, which the builder does not resolve — a tool
   * crossing the overlap of two of them leaves both uncut.
   *
   * `modified` gives the solids a stock became, and none for a stock the cut
   * left as it was (see `cutStock`); `makerOf` gives the boolean that ran
   * against a stock, for its lineage. `sectionEdges` and `internalFaces` are
   * the geometry the cut created, across the stocks it changed.
   */
  static cutMultiShape(stocks: Shape[], tools: Shape[], plane?: Plane, cutDistance: number = 0, options: { validate?: boolean; stage?: string } = {}) {
    const oc = getOC();
    const toolRaws = tools.map(s => s.getShape());
    const cuts = new Map<Shape, ReturnType<typeof BooleanOps.cutStock>>();
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const cut of cuts.values()) cut.dispose();
    };
    try {
      for (const stock of stocks) {
        cuts.set(stock, BooleanOps.cutStock(stock, toolRaws, options));
      }
      const changed = [...cuts.values()].filter(cut => cut.changed);
      const modified = (shape: Shape) => {
        const cut = cuts.get(shape);
        if (!cut || !cut.changed) {
          return [];
        }
        return ShapeOps.shapeListToArray(cut.maker.Modified(shape.getShape())).map(raw => {
          try { return ShapeFactory.fromShape(raw); }
          finally { raw.delete(); }
        });
      };
      const makerOf = (shape: Shape) => cuts.get(shape)!.maker;

      const sectionEdges = changed.flatMap(cut => cut.sectionEdges);

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

      const internalFaces = changed.flatMap(cut => cut.internalFaces);

      return {
        empty: [...cuts.values()].every(cut => cut.empty),
        modified,
        makerOf,
        sectionEdges,
        startEdges,
        endEdges,
        internalEdges,
        internalFaces,
        dispose,
      };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  /**
   * One stock against the tools, with the geometry the boolean created in
   * it: every result face and edge that is neither a sub-shape of the stock
   * nor the `Modified()` image of one.
   *
   * `changed` tells a cut from a touch. The kernel reports a stock Modified
   * as soon as a tool lands on it — a hole whose floor stops on one of its
   * faces, a wall running flush along its side — and hands back a copy with
   * that face split along the contact: the body it was. A stock the cut
   * changed holds a face that descends from none of its own (the tool's
   * wall, laid bare inside it), or has lost one of its own.
   */
  private static cutStock(stock: Shape, tools: TopoDS_Shape[], options: { validate?: boolean; stage?: string }) {
    const oc = getOC();
    const cut = BooleanOps.cutWithHistory([stock.getShape()], tools, options);
    const { result, maker: cutMaker, stockRaws } = cut;
    const owned: TopoDS_Shape[] = [];
    const own = (raw: TopoDS_Shape) => { owned.push(raw); return raw; };
    const stockEdgeMap = new oc.TopTools_MapOfShape();
    const stockFaceMap = new oc.TopTools_MapOfShape();
    try {
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        result.delete(); cut.dispose();
      };

      // A stock with no image is in the result as it was, or gone from it;
      // either way the boolean created nothing in it.
      const images = cutMaker.Modified(stock.getShape());
      const imageCount = images.Size();
      images.delete();
      if (imageCount === 0) {
        return { maker: cutMaker, empty: cut.empty, changed: cut.empty, sectionEdges: [] as Edge[], internalFaces: [] as Face[], dispose };
      }

      // Build maps of all edges and faces that came from the original stock (unchanged or modified).
      // Any result edge/face not in these maps is new, created by the cut.
      let lostFace = false;
      for (const stockRaw of stockRaws) {
        const rawEdges = Explorer.findShapes(stockRaw, Explorer.getOcShapeType("edge")).map(own);
        for (const rawEdge of rawEdges) {
          stockEdgeMap.Add(rawEdge);
          // Also track modified versions of this edge so we don't misidentify them as new.
          const modifiedList = cutMaker.Modified(rawEdge);
          while (modifiedList.Size() > 0) {
            stockEdgeMap.Add(own(modifiedList.First()));
            modifiedList.RemoveFirst();
          }
          modifiedList.delete();
        }

        const rawFaces = Explorer.findShapes(stockRaw, Explorer.getOcShapeType("face")).map(own);
        for (const rawFace of rawFaces) {
          stockFaceMap.Add(rawFace);
          const modifiedList = cutMaker.Modified(rawFace);
          if (modifiedList.Size() === 0 && cutMaker.IsDeleted(rawFace)) {
            lostFace = true;
          }
          while (modifiedList.Size() > 0) {
            stockFaceMap.Add(own(modifiedList.First()));
            modifiedList.RemoveFirst();
          }
          modifiedList.delete();
        }
      }

      const resultRawEdges = Explorer.findShapes(result, Explorer.getOcShapeType("edge")).map(own);
      const sectionEdges = resultRawEdges
        .filter(re => !stockEdgeMap.Contains(re))
        .map(re => Edge.fromTopoDSEdge(Explorer.toEdge(re)));

      const resultRawFaces = Explorer.findShapes(result, Explorer.getOcShapeType("face")).map(own);
      const internalFaces = resultRawFaces
        .filter(rf => !stockFaceMap.Contains(rf))
        .map(rf => Face.fromTopoDSFace(Explorer.toFace(rf)));

      return {
        maker: cutMaker,
        empty: cut.empty,
        changed: internalFaces.length > 0 || lostFace,
        sectionEdges,
        internalFaces,
        dispose,
      };
    } catch (error) {
      result.delete(); cut.dispose();
      throw error;
    } finally {
      owned.forEach(shape => shape.delete()); stockEdgeMap.delete(); stockFaceMap.delete();
    }
  }

  /**
   * Fuse with proper OpenCascade argument-vs-tool separation. Use this for
   * operations that fuse newly built geometry into an existing scene (extrude,
   * revolve, sweep, loft) where we need `maker.Modified(stockFace)` lineage to
   * track which existing face became which result face.
   *
   * Returns the underlying `BRepAlgoAPI_Fuse` so the caller can query
   * `Modified()` / `Generated()` / `IsDeleted()` for history tracking. The
   * caller MUST invoke `dispose()` exactly once to release the maker.
   *
   * Do not use this for the user-facing `Fuse` scene object (keep
   * `BooleanOps.fuse` for that — it treats all inputs as symmetric peers).
   */
  /**
   * Whether a fuse result is safe to adopt. A BOP can come back empty without
   * raising an error — it marks the inputs deleted and returns no solid (seen
   * with a strongly skewed loft fused into a sweep body) — and a fuse that
   * consumed stock but produced no solid would leave the scene with nothing.
   * A fuse that consumed nothing and produced nothing is fine: the callers
   * keep the tools as they are.
   */
  static diagnoseFuseResult(
    result: Shape[],
    modifiedShapes: Shape[],
    maker: { HasErrors(): boolean },
  ): { ok: true } | { ok: false; reason: string } {
    if (maker.HasErrors()) {
      return { ok: false, reason: 'the kernel reported a boolean error' };
    }
    const producedSolid = result.some(s => s.getType() === 'solid');
    if (!producedSolid && modifiedShapes.length > 0) {
      return { ok: false, reason: 'the boolean consumed the existing solid but returned no solid' };
    }
    return { ok: true };
  }

  static fuseStockAndTools(
    stock: Shape[],
    tools: Shape[],
    opts?: { glue?: 'full' | 'shift'; skipSimplify?: boolean }
  ): {
    result: Shape[];
    modifiedShapes: Shape[];
    newShapes: Shape[];
    maker: any;
    dispose: () => void;
  } {
    const oc = getOC();
    const inputs = BooleanOps.normalizeMixedInputs([...stock, ...tools].map(s => s.getShape()));
    const stockRaws = inputs.raws.slice(0, stock.length);
    const toolRaws = inputs.raws.slice(stock.length);
    const builder = new oc.BRepAlgoAPI_Fuse();
    builder.SetNonDestructive(true);
    builder.SetCheckInverted(true);
    builder.SetRunParallel(true);
    builder.SetFuzzyValue(BooleanOps.FEATURE_BOOLEAN_FUZZY);
    if (opts?.glue === 'full') {
      builder.SetGlue((oc as any).BOPAlgo_GlueEnum.BOPAlgo_GlueFull);
    } else if (opts?.glue === 'shift') {
      builder.SetGlue((oc as any).BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    }

    // Wrap all stocks in a single compound argument. OCC's pave-filling step
    // computes intersections between distinct arguments — so two touching
    // stocks passed as separate args end up merged with each other even when
    // the tool doesn't touch them. Bundling them under one TopoDS_Compound
    // keeps stock-to-stock relationships out of the result; only stock↔tool
    // interactions are computed.
    const stockCompound = ShapeOps.makeCompoundRaw(stockRaws);
    const stockList = new oc.TopTools_ListOfShape();
    stockList.Append(stockCompound);

    const toolList = new oc.TopTools_ListOfShape();
    for (const raw of toolRaws) {
      toolList.Append(raw);
    }

    builder.SetArguments(stockList);
    builder.SetTools(toolList);

    const progress = new oc.Message_ProgressRange();
    builder.Build(progress);
    const built = builder.Shape();
    const resultShape = opts?.skipSimplify
      ? built
      : BooleanOps.simplifyResult(builder, built, BooleanOps.FEATURE_BOOLEAN_FUZZY);
    const rawShapes = Explorer.findAllShapes(resultShape);
    const result = rawShapes.map(s => ShapeFactory.fromShape(s));

    const allInputs = [...stock, ...tools];
    const modifiedShapes: Shape[] = [];
    allInputs.forEach((shape, index) => {
      if (builder.IsDeleted(inputs.raws[index])) {
        modifiedShapes.push(shape);
      }
    });

    const newShapes: Shape[] = [];
    for (const s of result) {
      const existsInArgs = inputs.raws.some(raw => raw.IsPartner(s.getShape()));
      if (!existsInArgs) {
        newShapes.push(s);
      }
    }

    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      builder.delete();
      progress.delete();
      inputs.direct?.dispose();
    };

    const maker = inputs.direct || resultShape !== built
      ? BooleanOps.adaptMaker(builder, inputs.direct, resultShape)
      : builder;
    return { result, newShapes, modifiedShapes, maker, dispose };
  }

  /**
   * The builder's own `SimplifyResult(false, true, angular)` — the same
   * unifier with the same settings — run through `SameDomainMerge` instead.
   * `SimplifyResult` overwrites the builder's result with whatever the
   * unifier hands back, and a merge the kernel gives up on can hand back a
   * BRepCheck-invalid body that no later cleanup recovers. Here such a merge
   * is retried, and one that stays invalid is dropped: the unsimplified
   * result is returned and the caller's cleanup merges what it can.
   *
   * The merge's history is folded into the builder's, as `SimplifyResult`
   * does, so the lineage queries keep following the merged faces. The
   * builder's own `Shape()` stays unsimplified — hand the returned shape on.
   */
  private static simplifyResult(builder: any, built: TopoDS_Shape, linearTolerance: number): TopoDS_Shape {
    const oc = getOC();
    let merge: SameDomainMergeResult;
    try {
      merge = SameDomainMerge.run(built, {
        unifyEdges: false,
        unifyFaces: true,
        concatBSplines: true,
        linearTolerance,
        angularTolerance: oc.Precision.Angular(),
        safeInput: true,
        allowInternalEdges: false,
        trustSafeMerge: true,
      });
    } catch {
      return built;
    }
    try {
      if (!merge.valid) {
        return built;
      }
      const history = builder.History();
      history.Merge(merge.history);
      history.delete();
      return merge.shape;
    } finally {
      merge.dispose();
    }
  }

  static fuse(args: Shape[], opts?: { glue?: 'full' | 'shift' }): {
    result: Shape[];
    modifiedShapes: Shape[];
    newShapes: Shape[];
    maker: any;
    dispose: () => void;
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

    const inputs = BooleanOps.normalizeMixedInputs(args.map(a => a.getShape()));
    const argsList = new oc.TopTools_ListOfShape();
    for (const raw of inputs.raws) {
      argsList.Append(raw);
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

    const tUnify = performance.now();
    const resultShape = BooleanOps.unifyEdgesSplitByBoolean(
      builder,
      inputs.raws,
      builder.Shape(),
    );
    console.log(`[perf] BooleanOps.fuse.unifyEdgesSplitByBoolean: ${(performance.now() - tUnify).toFixed(1)} ms`);

    const tExplore = performance.now();
    const rawShapes = Explorer.findAllShapes(resultShape);
    console.log(`[perf] BooleanOps.fuse.findAllShapes (count=${rawShapes.length}): ${(performance.now() - tExplore).toFixed(1)} ms`);
    const result = rawShapes.map(s => ShapeFactory.fromShape(s));

    const modifiedShapes: Shape[] = [];
    args.forEach((shape, index) => {
      if (builder.IsDeleted(inputs.raws[index])) {
        modifiedShapes.push(shape);
      }
    });

    const newShapes: Shape[] = [];

    const tPartner = performance.now();
    for (const s of result) {
      const existsInArgs = inputs.raws.some(raw => raw.IsPartner(s.getShape()));

      if (!existsInArgs) {
        newShapes.push(s);
      }
    }
    console.log(`[perf] BooleanOps.fuse.IsPartner check (result=${result.length} x args=${args.length}): ${(performance.now() - tPartner).toFixed(1)} ms`);

    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      builder.delete();
      progress.delete();
      inputs.direct?.dispose();
    };

    const maker = inputs.direct ? BooleanOps.adaptMaker(builder, inputs.direct) : builder;
    return { result, newShapes, modifiedShapes, maker, dispose };
  }

  /**
   * Merge result edges that the fuse split at vertices the boolean itself
   * created. A fuse's pave filler cuts smooth edges wherever the arguments'
   * faces intersect — e.g. two coaxial equal-radius cylinders joined end to
   * end leave each junction circle as two 180° arcs — and `SimplifyResult`
   * runs with edge unification off, so those splits survive.
   *
   * A global edge-unify would also merge colinear/co-curve edges the USER
   * modeled (breakpoint splits, chained segments) and churn the TShape
   * identity callers match with IsSame. So merging is restricted to the
   * boolean's own artifacts: every STRUCTURAL input vertex — one bounding
   * two or more distinct input edges — is registered via `KeepShape`
   * (together with the substituted copies the NonDestructive boolean records
   * under `Modified`), leaving as merge candidates only vertices the boolean
   * created plus closure vertices of closed input edges. A closure vertex
   * (the parametric origin a full circle's single vertex sits at) is an
   * accident of parametrization, not modeling intent — and it is exactly
   * what survives as the split points when a fuse unifies two coincident
   * circles whose origins differ (e.g. one argument rotated 180°: the
   * junction circle comes out as two 180° arcs). Faces adjacent to merged
   * vertices necessarily contain a split or re-imprinted edge, so they are
   * boolean-rebuilt TShapes, never subshapes shared with an input — which is
   * what makes the in-place `SetSafeInputMode(false)` pass (needed to keep
   * untouched faces' identity) safe.
   *
   * The unifier's history is merged into the builder's, exactly like
   * `SimplifyResult` does internally, so the maker's `Modified` /
   * `Generated` / `IsDeleted` lineage queries (color transfer, history
   * recording) keep answering correctly for rebuilt faces.
   *
   * Returns the input shape unchanged when the boolean created no vertices
   * or the unified result fails validation.
   */
  private static unifyEdgesSplitByBoolean(
    builder: any,
    argRaws: TopoDS_Shape[],
    resultShape: TopoDS_Shape,
  ): TopoDS_Shape {
    const oc = getOC();
    const VERTEX = Explorer.getOcShapeType("vertex");

    const EDGE = Explorer.getOcShapeType("edge");

    // A closure vertex is the single distinct vertex of a closed input edge
    // (a full circle); it may also bound open edges (a cylinder's seam), so
    // collect closure vertices first and exclude them from the kept set.
    const closureVertices = new oc.TopTools_MapOfShape();
    for (const raw of argRaws) {
      for (const e of Explorer.findShapes(raw, EDGE)) {
        const edgeVertices = Explorer.findShapes(e, VERTEX);
        if (edgeVertices.length === 1) {
          closureVertices.Add(edgeVertices[0]);
        }
      }
    }

    const structuralVertices = new oc.TopTools_MapOfShape();
    for (const raw of argRaws) {
      for (const v of Explorer.findShapes(raw, VERTEX)) {
        if (closureVertices.Contains(v)) {
          continue;
        }
        structuralVertices.Add(v);
        const modifiedList = builder.Modified(v);
        while (modifiedList.Size() > 0) {
          structuralVertices.Add(modifiedList.First());
          modifiedList.RemoveFirst();
        }
        modifiedList.delete();
      }
    }
    closureVertices.delete();

    const keptVertices: TopoDS_Shape[] = [];
    let candidateCount = 0;
    for (const v of Explorer.findShapes(resultShape, VERTEX)) {
      if (structuralVertices.Contains(v)) {
        keptVertices.push(v);
      } else {
        candidateCount++;
      }
    }
    structuralVertices.delete();

    if (candidateCount === 0) {
      return resultShape;
    }

    try {
      const unify = new oc.ShapeUpgrade_UnifySameDomain(resultShape, true, false, false);
      unify.SetSafeInputMode(false);
      for (const v of keptVertices) {
        unify.KeepShape(v);
      }
      unify.Build();
      const unified = unify.Shape();

      const checker = new oc.BRepCheck_Analyzer(unified, true, true);
      const valid = checker.IsValid();
      checker.delete();
      if (!valid) {
        unify.delete();
        return resultShape;
      }

      const builderHistory = builder.History();
      const unifyHistory = unify.History();
      builderHistory.Merge(unifyHistory);
      unifyHistory.delete();
      builderHistory.delete();
      unify.delete();
      return unified;
    } catch {
      return resultShape;
    }
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

    const inputs = BooleanOps.normalizeMixedInputs(args.map(a => a.getShape()));
    const argsList = new oc.TopTools_ListOfShape();
    for (const raw of inputs.raws) {
      argsList.Append(raw);
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

    args.forEach((shape, index) => {
      if (builder.IsDeleted(inputs.raws[index])) {
        modifiedShapes.push(shape);
      }
      else {
        const modified = builder.Modified(inputs.raws[index]);
        if (modified.Size() > 0) {
          modifiedShapes.push(shape);
        }
      }
    });

    builder.delete();
    progress.delete();
    inputs.direct?.dispose();

    const newShapes: Shape[] = [];

    for (const s of result) {
      const existsInArgs = inputs.raws.some(raw => raw.IsPartner(s.getShape()));

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

    return volume > mmTol3(1e-9);
  }
}
