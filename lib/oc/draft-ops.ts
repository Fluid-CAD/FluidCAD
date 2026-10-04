import type { BRepOffsetAPI_DraftAngle, TopAbs_ShapeEnum, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Explorer } from "./explorer.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { ShapeOps } from "./shape-ops.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";

export type DraftResult = {
  shape: Shape;
  /** Maker history against the input solid — the caller records provenance. */
  history: ShapeHistory;
};

export class DraftOps {
  static applyDraft(solid: Shape, faceRaws: TopoDS_Shape[], angle: number): DraftResult | null {
    return DraftOps.withDraft(solid, faceRaws, angle, (draftMaker) => {
      const result = draftMaker.Shape();
      const history = ShapeHistoryTracker.collect(draftMaker, [solid]);
      return { shape: ShapeFactory.fromShape(result), history };
    });
  }

  /**
   * The faces a draft tilts: what `applyDraft` makes of the given faces of
   * `solid`, as the drafted solid holds them — a preview draws them and
   * nothing else, so the faces the draft leaves alone don't cover the
   * model. Null when none of the faces is the solid's. Every face returned
   * is the caller's to free; the drafted solid itself is freed here.
   */
  static draftedFaces(solid: Shape, faceRaws: TopoDS_Shape[], angle: number): Face[] | null {
    const oc = getOC();
    return DraftOps.withDraft(solid, faceRaws, angle, (draftMaker, drafted) => {
      // The draft reports a tilted face as generated from the one it tilts;
      // modified is read too, for whatever the kernel reports that way.
      const images = drafted.flatMap(face => [
        ...ShapeOps.shapeListToArray(draftMaker.Generated(face)),
        ...ShapeOps.shapeListToArray(draftMaker.Modified(face)),
      ]);
      const result = draftMaker.Shape();
      try {
        return Explorer.findShapes(result, oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum)
          .filter(face => images.some(image => image.IsSame(face)))
          .map(face => Face.fromTopoDSFace(Explorer.toFace(face)));
      } finally {
        for (const image of images) {
          image.delete();
        }
        result.delete();
      }
    });
  }

  /**
   * Draft `solid`'s faces that are among `faceRaws` by `angle` about the
   * neutral plane at the bottom of the solid, pulling along +Z, and hand the
   * built maker to `read` with the faces it drafted. Null when none of them
   * is the solid's; throws when the draft fails.
   */
  private static withDraft<T>(
    solid: Shape,
    faceRaws: TopoDS_Shape[],
    angle: number,
    read: (draftMaker: BRepOffsetAPI_DraftAngle, drafted: TopoDS_Face[]) => T,
  ): T | null {
    const oc = getOC();
    const solidRaw = solid.getShape();
    const bbox = ShapeOps.getBoundingBox(solid);

    const neutralPlane = new Plane(
      new Point(0, 0, bbox.minZ),
      new Vector3d(1, 0, 0),
      new Vector3d(0, 0, 1)
    );
    const [dir, disposeDir] = Convert.toGpDir(neutralPlane.normal);
    const [pln, disposePln] = Convert.toGpPln(neutralPlane);

    try {
      const draftMaker = new oc.BRepOffsetAPI_DraftAngle(solidRaw);
      const drafted: TopoDS_Face[] = [];

      const explorer = new oc.TopExp_Explorer(
        solidRaw,
        oc.TopAbs_ShapeEnum.TopAbs_FACE,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE
      );

      while (explorer.More()) {
        const currentShape = explorer.Current();
        const isSelected = faceRaws.some(sel => sel.IsSame(currentShape));

        if (isSelected) {
          const face = oc.TopoDS.Face(currentShape);
          draftMaker.Add(face, dir, -angle, pln, true);
          drafted.push(face);
        }

        explorer.Next();
      }

      explorer.delete();

      try {
        if (drafted.length === 0) {
          return null;
        }

        const progress = new oc.Message_ProgressRange();
        draftMaker.Build(progress);
        progress.delete();

        if (!draftMaker.IsDone()) {
          throw new Error("Failed to apply draft angle.");
        }

        return read(draftMaker, drafted);
      } finally {
        draftMaker.delete();
      }
    } finally {
      disposeDir();
      disposePln();
    }
  }
}
