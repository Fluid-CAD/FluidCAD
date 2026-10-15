import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Explorer } from "./explorer.js";
import { FaceOps } from "./face-ops.js";
import { ShapeOps } from "./shape-ops.js";
import { ShapeProps } from "./props.js";
import { ColorTransfer } from "./color-transfer.js";
import { RenderSeams } from "./render-seams.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import type { BoundingBox } from "../helpers/types.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { mmTol, mmTol3 } from "../units/tolerance.js";

/**
 * What a split cuts with: an infinite plane, or the sheet a sketched curve
 * sweeps out of its sketch — the curve's edges extruded along the sketch
 * normal both ways, far enough to pass every solid. The edges are oriented
 * head to tail when they chain, so one side of the sheet is `front` all
 * along: the side to the right of the curve when travelling it from the
 * sketch's front (tangent × sketch normal).
 */
export type SplitCutter =
  | { kind: 'plane'; plane: Plane }
  | { kind: 'sheet'; edges: TopoDS_Edge[]; normal: Vector3d };

/** A sheet cutter, for the callers that have already told the two apart. */
export type SplitSheet = Extract<SplitCutter, { kind: 'sheet' }>;

/** One piece a split made of a solid, with which side of the cut it lies on. */
export type SplitPiece = {
  solid: Solid;
  /** `front` is the side the plane normal — or the sheet's tangent × sketch normal — points to. */
  side: 'front' | 'back';
};

export type SplitSolidResult = {
  /**
   * The pieces the cut made of the solid, front side first, each side
   * ordered by distance from the cut. Empty when the cut misses the solid
   * or only grazes it — the solid is then not split at all.
   */
  pieces: SplitPiece[];
  /** Maker history against the input solid, for the caller's provenance records. Null when nothing was split. */
  history: ShapeHistory | null;
};

type SidedPiece = SplitPiece & { distance: number };

export class SplitOps {
  /**
   * Fuzzy tolerance for the splitter, the same the feature booleans use: a
   * cut lying exactly on a face of the solid (a split at a step, at a
   * symmetry plane that is also a face) would otherwise leave the kernel
   * with a near-coincident contact it resolves at random.
   */
  private static get SPLIT_FUZZY(): number {
    return mmTol(1e-4);
  }

  /** Splits `solid` with the infinite plane — see {@link splitSolid}. */
  static splitSolidByPlane(solid: Shape, plane: Plane): SplitSolidResult {
    return SplitOps.splitSolid(solid, { kind: 'plane', plane });
  }

  /**
   * Splits `solid` with the cutter: every part of the solid on one side of
   * the cut comes back as its own piece, capped where the cut went. A solid
   * the cut never reaches — or merely touches along a face or an edge, or
   * that a sheet enters without coming out the other side — is left as it
   * is and reports no pieces, so the caller keeps the original body
   * untouched. The tool is sized from the solid's bounds: a square face on
   * the plane, or the sheet extruded past the bounds both ways, which is
   * what the kernel's splitter is built for; an unbounded surface is not.
   *
   * The pieces' volumes are checked against the input's: a splitter result
   * that lost or doubled material is a kernel failure, never geometry a user
   * asked for, so it is refused here instead of reaching the scene.
   */
  static splitSolid(solid: Shape, cutter: SplitCutter): SplitSolidResult {
    const oc = getOC();
    const none: SplitSolidResult = { pieces: [], history: null };

    const bbox = ShapeOps.getBoundingBox(solid);
    const diagonal = SplitOps.diagonalOf(bbox);
    if (!Number.isFinite(diagonal) || diagonal <= 0) {
      return none;
    }

    if (cutter.kind === 'plane') {
      // Cheap miss test before any boolean: a plane that leaves every corner
      // of the bounds on one side cannot cross the solid.
      const corners = ShapeOps.boundingBoxCorners(bbox);
      const distances = corners.map(c => cutter.plane.signedDistanceToPoint(c));
      const touch = mmTol(1e-6);
      if (distances.every(d => d > touch) || distances.every(d => d < -touch)) {
        return none;
      }
    }

    const tool = cutter.kind === 'plane'
      ? SplitOps.makePlaneTool(cutter.plane, bbox, diagonal)
      : SplitOps.makeSheetTool(cutter, bbox);

    if (cutter.kind === 'sheet' && !SplitOps.boundsOverlap(bbox, ShapeOps.getBoundingBox(tool), mmTol(1e-6))) {
      tool.delete();
      return none;
    }

    const argumentList = new oc.TopTools_ListOfShape();
    const toolList = new oc.TopTools_ListOfShape();
    const progress = new oc.Message_ProgressRange();
    const splitter = new oc.BRepAlgoAPI_Splitter();
    let result: TopoDS_Shape | undefined;
    try {
      argumentList.Append(solid.getShape());
      toolList.Append(tool);
      splitter.SetArguments(argumentList);
      splitter.SetTools(toolList);
      splitter.SetNonDestructive(true);
      splitter.SetRunParallel(true);
      splitter.SetFuzzyValue(SplitOps.SPLIT_FUZZY);
      splitter.Build(progress);

      if (!splitter.IsDone() || splitter.HasErrors()) {
        throw new Error(`split: the kernel could not split the solid with this ${cutter.kind === 'plane' ? 'plane' : 'sketched curve'}.`);
      }
      result = splitter.Shape();
      if (result.IsNull()) {
        throw new Error("split: the kernel returned no shape for the split.");
      }

      const SOLID = oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum;
      const rawPieces = Explorer.findShapes(result, SOLID);
      // One solid back means the cut grazed the body without parting it (a
      // face or an edge on the plane, a curve that stops inside the body):
      // keep the original, not the copy.
      if (rawPieces.length < 2) {
        return none;
      }

      const sourceVolume = ShapeProps.getVolumeAndCentroid(solid.getShape()).volume;
      let piecesVolume = 0;
      const pieces: SidedPiece[] = [];
      for (const raw of rawPieces) {
        const wrapped = Solid.fromTopoDSSolid(Explorer.toSolid(raw));
        const { volume, centroid } = ShapeProps.getVolumeAndCentroid(raw);
        piecesVolume += volume;
        const probe = new Point(centroid.x, centroid.y, centroid.z);
        const sided = cutter.kind === 'plane'
          ? SplitOps.sideOfPlane(probe, cutter.plane)
          : SplitOps.sideOfSheet(SplitOps.interiorPoint(raw, probe, diagonal), cutter);
        pieces.push({ solid: wrapped, ...sided });
      }

      const budget = Math.max(mmTol3(1e-6), Math.abs(sourceVolume) * 1e-5);
      if (!Number.isFinite(piecesVolume) || Math.abs(piecesVolume - sourceVolume) > budget) {
        throw new Error(
          `split: the pieces do not add up to the solid (${piecesVolume} vs ${sourceVolume}) — the kernel lost material at the cut.`,
        );
      }

      pieces.sort((a, b) => {
        if (a.side !== b.side) {
          return a.side === 'front' ? -1 : 1;
        }
        return Math.abs(a.distance) - Math.abs(b.distance);
      });

      const solids = pieces.map(p => p.solid);
      solids.forEach(target => RenderSeams.throughHistory(target, [solid], splitter));
      ColorTransfer.applyThroughMaker([solid], solids, splitter);
      ColorTransfer.applyBleeding([solid], solids, splitter);
      const history = ShapeHistoryTracker.collect(splitter, [solid]);

      return {
        pieces: pieces.map(({ solid, side }) => ({ solid, side })),
        history,
      };
    } finally {
      result?.delete();
      splitter.delete();
      progress.delete();
      argumentList.delete();
      toolList.delete();
      tool.delete();
    }
  }

  /**
   * The sheet a sketched curve cuts with, sized to `bounds`: each edge of
   * the curve extruded along the sketch normal from below the bounds to
   * above them, the faces sewn into one shell where the edges chain. Shared
   * with the split ghost, which draws it. The caller owns the shape.
   */
  static makeSheetTool(sheet: SplitSheet, bounds: BoundingBox): TopoDS_Shape {
    const oc = getOC();
    const normal = sheet.normal.normalize();
    const reach = SplitOps.diagonalOf(bounds) + mmTol(1);
    const center = SplitOps.centerOf(bounds);
    // Every edge lies in the sketch plane, so one shift along the normal
    // takes them all to the level `reach` below the bounds' centre.
    const onPlane = SplitOps.edgeStart(sheet.edges[0]);
    const shift = center.subtract(onPlane).toVector3d().dot(normal) - reach;

    const [trsf, disposeTrsf] = Convert.toGpTrsfTranslationVec(normal.multiply(shift));
    const [sweep, disposeSweep] = Convert.toGpVec(normal.multiply(2 * reach));
    const faces: TopoDS_Shape[] = [];
    try {
      for (const edge of sheet.edges) {
        const transformer = new oc.BRepBuilderAPI_Transform(trsf);
        transformer.Perform(edge, true);
        const moved = transformer.Shape();
        const prism = new oc.BRepPrimAPI_MakePrism(moved, sweep, false, true);
        faces.push(prism.Shape());
        prism.delete();
        moved.delete();
        transformer.delete();
      }
    } finally {
      disposeSweep();
      disposeTrsf();
    }

    if (faces.length === 1) {
      return faces[0];
    }
    const sewing = new oc.BRepBuilderAPI_Sewing(mmTol(1e-5), true, true, true, false);
    const progress = new oc.Message_ProgressRange();
    try {
      for (const face of faces) {
        sewing.Add(face);
      }
      sewing.Perform(progress);
      const sewn = sewing.SewedShape();
      if (!sewn.IsNull()) {
        return sewn;
      }
      return ShapeOps.makeCompoundRaw(faces);
    } finally {
      progress.delete();
      sewing.delete();
      for (const face of faces) {
        face.delete();
      }
    }
  }

  /**
   * Where `point` stands relative to a sheet: the side of the curve its
   * foot on the curve puts it on, and how far from the sheet it is. Works
   * for any point off the sheet; the caller hands in one inside the piece.
   */
  static sideOfSheet(point: Point, sheet: SplitSheet): { side: 'front' | 'back'; distance: number } {
    const nearest = SplitOps.nearestOnCurve(point, sheet.edges);
    const front = nearest.tangent.cross(sheet.normal).normalize();
    const distance = point.subtract(nearest.foot).toVector3d().dot(front);
    return { side: distance >= 0 ? 'front' : 'back', distance };
  }

  /** The front direction of a sheet at the point of its curve nearest `point` — the ghost's arrow. */
  static sheetFrontAt(point: Point, sheet: SplitSheet): { foot: Point; front: Vector3d } {
    const nearest = SplitOps.nearestOnCurve(point, sheet.edges);
    return { foot: nearest.foot, front: nearest.tangent.cross(sheet.normal).normalize() };
  }

  private static sideOfPlane(point: Point, plane: Plane): { side: 'front' | 'back'; distance: number } {
    const distance = plane.signedDistanceToPoint(point);
    return { side: distance >= 0 ? 'front' : 'back', distance };
  }

  private static makePlaneTool(plane: Plane, bounds: BoundingBox, diagonal: number): TopoDS_Face {
    const toolPlane = new Plane(plane.projectPoint(SplitOps.centerOf(bounds)), plane.xDirection, plane.normal);
    // Half-size past every corner of the bounds, whatever the plane's tilt.
    return FaceOps.makeSquareFace(toolPlane, diagonal + mmTol(1));
  }

  /**
   * A point strictly inside `solid`: its centroid when that is inside (any
   * convex piece), else a point just under one of its faces. A piece of a
   * sheet split can wrap around the cut — the outer part of a plate split
   * by a circle — so its centroid may sit on the far side of the curve; a
   * point of its own material never does. Falls back to the centroid.
   */
  private static interiorPoint(solid: TopoDS_Shape, centroid: Point, diagonal: number): Point {
    const oc = getOC();
    const tolerance = mmTol(1e-7);
    const inside = (candidate: Point): boolean => {
      const [gpPnt, dispose] = Convert.toGpPnt(candidate);
      const classifier = new oc.BRepClass3d_SolidClassifier(solid, gpPnt, tolerance);
      try {
        return classifier.State() === oc.TopAbs_State.TopAbs_IN;
      } finally {
        classifier.delete();
        dispose();
      }
    };
    if (inside(centroid)) {
      return centroid;
    }
    const step = Math.max(mmTol(1e-3), diagonal * 1e-4);
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    for (const face of Explorer.findShapes(solid, FACE)) {
      const probe = SplitOps.probeFace(Explorer.toFace(face));
      if (!probe) {
        continue;
      }
      const candidate = probe.point.subtract(probe.outward.multiply(step));
      if (inside(candidate)) {
        return candidate;
      }
    }
    return centroid;
  }

  /** A point on the face's surface at its parametric middle, with the face's outward normal there. */
  private static probeFace(face: TopoDS_Face): { point: Point; outward: Vector3d } | null {
    const oc = getOC();
    const bounds = oc.BRepTools.UVBounds(face);
    const surface = oc.BRep_Tool.Surface(face);
    const props = new oc.GeomLProp_SLProps(surface, (bounds.UMin + bounds.UMax) / 2, (bounds.VMin + bounds.VMax) / 2, 1, 1e-6);
    try {
      if (!props.IsNormalDefined()) {
        return null;
      }
      let normal = Convert.toVector3dFromGpDir(props.Normal());
      if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
        normal = normal.negate();
      }
      return { point: Convert.toPoint(props.Value()), outward: normal.normalize() };
    } catch {
      return null;
    } finally {
      props.delete();
      surface.delete();
    }
  }

  /**
   * The point of the curve nearest `point`, with the curve's tangent there
   * in the edges' own direction (a reversed edge runs backwards along its
   * curve). The curve is planar, so the foot of a point off its plane is
   * the foot of the point's projection.
   */
  private static nearestOnCurve(point: Point, edges: TopoDS_Edge[]): { foot: Point; tangent: Vector3d } {
    const oc = getOC();
    let best: { distance: number; foot: Point; tangent: Vector3d } | null = null;
    const [gpPnt, disposePnt] = Convert.toGpPnt(point);
    const vertexMaker = new oc.BRepBuilderAPI_MakeVertex(gpPnt);
    const vertex = vertexMaker.Shape();
    try {
      for (const edge of edges) {
        const adaptor = new oc.BRepAdaptor_Curve(edge);
        const progress = new oc.Message_ProgressRange();
        const extrema = new oc.BRepExtrema_DistShapeShape(
          vertex, edge, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress,
        );
        try {
          if (!extrema.IsDone() || extrema.NbSolution() === 0) {
            continue;
          }
          const distance = extrema.Value();
          if (best && distance >= best.distance) {
            continue;
          }
          const first = adaptor.FirstParameter();
          const last = adaptor.LastParameter();
          let parameter: number;
          if (Explorer.isEdge(extrema.SupportOnShape2(1))) {
            parameter = extrema.ParOnEdgeS2(1).t;
          } else {
            // The nearest point is a vertex: the parameter is that end's.
            const atFirst = Convert.toPoint(adaptor.Value(first), true);
            const atLast = Convert.toPoint(adaptor.Value(last), true);
            parameter = point.distanceTo(atFirst) <= point.distanceTo(atLast) ? first : last;
          }
          const pnt = new oc.gp_Pnt();
          const vec = new oc.gp_Vec();
          try {
            adaptor.D1(parameter, pnt, vec);
            let tangent = Convert.toVector3d(vec).normalize();
            if (edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
              tangent = tangent.negate();
            }
            best = { distance, foot: Convert.toPoint(pnt), tangent };
          } finally {
            vec.delete();
            pnt.delete();
          }
        } finally {
          extrema.delete();
          progress.delete();
          adaptor.delete();
        }
      }
    } finally {
      vertex.delete();
      vertexMaker.delete();
      disposePnt();
    }
    if (!best) {
      throw new Error("split: could not find the sketched curve from the piece.");
    }
    return { foot: best.foot, tangent: best.tangent };
  }

  private static edgeStart(edge: TopoDS_Edge): Point {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    try {
      return Convert.toPoint(adaptor.Value(adaptor.FirstParameter()), true);
    } finally {
      adaptor.delete();
    }
  }

  private static diagonalOf(bounds: BoundingBox): number {
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private static centerOf(bounds: BoundingBox): Point {
    return new Point(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    );
  }

  private static boundsOverlap(a: BoundingBox, b: BoundingBox, slack: number): boolean {
    return a.minX <= b.maxX + slack && b.minX <= a.maxX + slack
      && a.minY <= b.maxY + slack && b.minY <= a.maxY + slack
      && a.minZ <= b.maxZ + slack && b.minZ <= a.maxZ + slack;
  }
}
