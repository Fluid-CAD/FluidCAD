import type { TopoDS_Face, TopoDS_Solid } from "occjs-wrapper";
import { ShapeOps } from "../oc/shape-ops.js";
import { FaceQuery } from "../oc/face-query.js";
import { Face } from "./face.js";

export class SolidFace extends Face {
  constructor(private solid: TopoDS_Solid, private face: TopoDS_Face) {
    super(face);
    this.setNormal();
  }

  setNormal(): void {
    if (!FaceQuery.isPlanarFaceRaw(this.face)) {
      return;
    }

    this.normal = ShapeOps.getSolidOutwardNormalRaw(this.face, this.solid);
  }

  static fromTopoDSSolidAndFace(solid: TopoDS_Solid, face: TopoDS_Face): Face {
    return new SolidFace(solid, face);
  }
}
