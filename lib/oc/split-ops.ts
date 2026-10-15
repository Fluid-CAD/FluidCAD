import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { FaceOps } from "./face-ops.js";
import { ShapeOps } from "./shape-ops.js";
import { ShapeProps } from "./props.js";
import { ColorTransfer } from "./color-transfer.js";
import { RenderSeams } from "./render-seams.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { mmTol, mmTol3 } from "../units/tolerance.js";

/** One piece a split made of a solid, with which side of the plane it lies on. */
export type SplitPiece = {
  solid: Solid;
  /** `front` is the side the plane normal points to. */
  side: 'front' | 'back';
};

export type SplitSolidResult = {
  /**
   * The pieces the plane cut the solid into, front side first, each side
   * ordered by distance from the plane. Empty when the plane misses the
   * solid or only grazes it — the solid is then not split at all.
   */
  pieces: SplitPiece[];
  /** Maker history against the input solid, for the caller's provenance records. Null when nothing was split. */
  history: ShapeHistory | null;
};

export class SplitOps {
  /**
   * Fuzzy tolerance for the splitter, the same the feature booleans use: a
   * cut plane lying exactly on a face of the solid (a split at a step, at
   * a symmetry plane that is also a face) would otherwise leave the kernel
   * with a near-coincident contact it resolves at random.
   */
  private static get SPLIT_FUZZY(): number {
    return mmTol(1e-4);
  }

  /**
   * Splits `solid` with the infinite plane: every part of the solid on one
   * side of the plane comes back as its own piece, with the cut face capped
   * flat. A solid the plane never reaches — or merely touches along a face
   * or an edge — is left as it is and reports no pieces, so the caller keeps
   * the original body untouched. The tool is a square face sized from the
   * solid's bounds, which is what the kernel's splitter is built for; an
   * unbounded planar face is not.
   *
   * The pieces' volumes are checked against the input's: a splitter result
   * that lost or doubled material is a kernel failure, never geometry a user
   * asked for, so it is refused here instead of reaching the scene.
   */
  static splitSolidByPlane(solid: Shape, plane: Plane): SplitSolidResult {
    const oc = getOC();
    const none: SplitSolidResult = { pieces: [], history: null };

    const bbox = ShapeOps.getBoundingBox(solid);
    const dx = bbox.maxX - bbox.minX;
    const dy = bbox.maxY - bbox.minY;
    const dz = bbox.maxZ - bbox.minZ;
    const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(diagonal) || diagonal <= 0) {
      return none;
    }

    // Cheap miss test before any boolean: a plane that leaves every corner
    // of the bounds on one side cannot cross the solid.
    const corners = ShapeOps.boundingBoxCorners(bbox);
    const distances = corners.map(c => plane.signedDistanceToPoint(c));
    const touch = mmTol(1e-6);
    if (distances.every(d => d > touch) || distances.every(d => d < -touch)) {
      return none;
    }

    const center = new Point(
      (bbox.minX + bbox.maxX) / 2,
      (bbox.minY + bbox.maxY) / 2,
      (bbox.minZ + bbox.maxZ) / 2,
    );
    const toolPlane = new Plane(plane.projectPoint(center), plane.xDirection, plane.normal);
    // Half-size past every corner of the bounds, whatever the plane's tilt.
    const toolFace = FaceOps.makeSquareFace(toolPlane, diagonal + mmTol(1));

    const argumentList = new oc.TopTools_ListOfShape();
    const toolList = new oc.TopTools_ListOfShape();
    const progress = new oc.Message_ProgressRange();
    const splitter = new oc.BRepAlgoAPI_Splitter();
    let result: TopoDS_Shape | undefined;
    try {
      argumentList.Append(solid.getShape());
      toolList.Append(toolFace);
      splitter.SetArguments(argumentList);
      splitter.SetTools(toolList);
      splitter.SetNonDestructive(true);
      splitter.SetRunParallel(true);
      splitter.SetFuzzyValue(SplitOps.SPLIT_FUZZY);
      splitter.Build(progress);

      if (!splitter.IsDone() || splitter.HasErrors()) {
        throw new Error("split: the kernel could not split the solid with this plane.");
      }
      result = splitter.Shape();
      if (result.IsNull()) {
        throw new Error("split: the kernel returned no shape for the split.");
      }

      const SOLID = oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum;
      const rawPieces = Explorer.findShapes(result, SOLID);
      // One solid back means the plane grazed the body without parting it
      // (a face or an edge on the plane): keep the original, not the copy.
      if (rawPieces.length < 2) {
        return none;
      }

      const sourceVolume = ShapeProps.getVolumeAndCentroid(solid.getShape()).volume;
      let piecesVolume = 0;
      const pieces: (SplitPiece & { distance: number })[] = [];
      for (const raw of rawPieces) {
        const wrapped = Solid.fromTopoDSSolid(Explorer.toSolid(raw));
        const { volume, centroid } = ShapeProps.getVolumeAndCentroid(raw);
        piecesVolume += volume;
        const distance = plane.signedDistanceToPoint(new Point(centroid.x, centroid.y, centroid.z));
        pieces.push({ solid: wrapped, side: distance >= 0 ? 'front' : 'back', distance });
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
      toolFace.delete();
    }
  }
}
