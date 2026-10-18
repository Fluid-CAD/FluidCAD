import { getOC } from "./init.js";
import { ShapeOps } from "./shape-ops.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { ColorTransfer, type CarriedColor, type SourceColors } from "./color-transfer.js";
import { ShapeValidator } from "./shape-validator.js";
import { ShellJoinType } from "../core/interfaces.js";

export class ShellOps {
  /** Relative volume change below which a "shelled" solid is the input handed back. */
  private static readonly UNCHANGED_VOLUME = 1e-9;

  /**
   * Hollows `source.shape`, leaving `faces` open. Returns the shelled solid
   * with the source's colours carried onto its outer faces — the caller
   * records them.
   */
  static makeThickSolid(source: SourceColors, faces: Face[], thickness: number, joinType: ShellJoinType = 'arc'): { shape: Shape; colors: CarriedColor[] } {
    const oc = getOC();
    const solid = source.shape;
    const listOfFaces = new oc.TopTools_ListOfShape();

    for (const f of faces) {
      listOfFaces.Append(f.getShape()).delete();
    }

    const ocJoinType = joinType === 'intersection' ? oc.GeomAbs_JoinType.GeomAbs_Intersection
      : joinType === 'tangent' ? oc.GeomAbs_JoinType.GeomAbs_Tangent
      : oc.GeomAbs_JoinType.GeomAbs_Arc;

    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    const progress = new oc.Message_ProgressRange();
    const typedSolid = oc.TopoDS.Solid(solid.getShape());
    maker.MakeThickSolidByJoin(typedSolid, listOfFaces, thickness, oc.Precision.Confusion(), oc.BRepOffset_Mode.BRepOffset_Skin, false, false, ocJoinType, false, progress);
    typedSolid.delete();

    progress.delete();

    // OCC also reports success when the offset wall collapsed and it glued
    // the input back together: the same solid, opening closed again. A wall
    // of any thickness changes the volume, so an unchanged one is that case.
    const collapsed = () => {
      const before = ShapeValidator.signedVolume(solid.getShape());
      const made = maker.Shape();
      const after = ShapeValidator.signedVolume(made);
      made.delete();
      return Math.abs(after - before) <= Math.abs(before) * ShellOps.UNCHANGED_VOLUME;
    };
    if (!maker.IsDone() || collapsed()) {
      maker.delete();
      listOfFaces.delete();
      throw new Error("Failed to create thick solid.");
    }

    // Wrap the maker output so we can transfer colors before disposing it.
    // The user-painted outer faces are mapped through `Modified()`; new
    // internal walls have no source and stay uncolored — bleeding is
    // intentionally skipped so painting the outside doesn't paint the
    // inside.
    const preClean = ShapeFactory.adopt(maker.Shape());
    const preCleanColors = ColorTransfer.applyThroughMaker([source], [preClean], maker);
    maker.delete();
    listOfFaces.delete();

    // Chain colors through the UnifySameDomain cleanup so any merged faces
    // keep the colors that `applyThroughMaker` just placed.
    const cleanup = ShapeOps.cleanShapeWithLineage(preClean);
    const preCleanView = ColorTransfer.viewOf(preCleanColors, preClean);
    let colors: CarriedColor[];
    try {
      colors = ColorTransfer.applyThroughCleanup({ shape: preClean, colors: preCleanView }, cleanup);
    } finally {
      preCleanView.delete();
    }
    const cleaned = cleanup.shape;
    cleanup.dispose();
    preClean.dispose();
    return { shape: cleaned, colors };
  }
}
