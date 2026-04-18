import type { TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Shape } from "../common/shape.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { ShapeOps } from "./shape-ops.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";

export class DraftOps {
  static applyDraft(solid: Shape, faceRaws: TopoDS_Shape[], angle: number): Shape {
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
      let addedCount = 0;

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
          addedCount++;
        }

        explorer.Next();
      }

      explorer.delete();

      if (addedCount === 0) {
        draftMaker.delete();
        return null;
      }

      const progress = new oc.Message_ProgressRange();
      draftMaker.Build(progress);
      progress.delete();

      if (!draftMaker.IsDone()) {
        draftMaker.delete();
        throw new Error("Failed to apply draft angle.");
      }

      const result = draftMaker.Shape();
      draftMaker.delete();
      return ShapeFactory.fromShape(result);
    } finally {
      disposeDir();
      disposePln();
    }
  }
}
