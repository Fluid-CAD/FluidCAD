import { Solid } from "../common/shapes.js";
import { Face } from "../common/face.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";

export class ExtrudeThroughAll {

  private shapes: Solid[] = null;

  constructor(public extrudable: Extrudable,
    public symmetric: boolean,
    public reversed: boolean,
    public pickedFaces?: Face[]) {
  }

  build(): Solid[] {
    if (this.shapes) {
      return this.shapes;
    }

    const solids: Solid[] = [];

    const plane = this.extrudable.getPlane();

    const faces = this.pickedFaces ?? FaceMaker2.getRegions(
      this.extrudable.getGeometries(), plane);

    console.log("Extruding faces:", faces);

    let dir = plane.normal;

    if (this.reversed) {
      dir = dir.multiply(-1);
    }

    const shouldDispose = !this.pickedFaces;

    if (this.symmetric) {
      for (const face of faces) {
        const solid = ExtrudeOps.makePrismSymmetric(face, dir);
        solids.push(solid as Solid);
        if (shouldDispose) { face.dispose(); }
      }
    } else {
      dir = dir.multiply(100000);

      for (const face of faces) {
        const solid = ExtrudeOps.makePrism(face, dir, 1);
        solids.push(solid as Solid);
        if (shouldDispose) { face.dispose(); }
      }
    }

    this.shapes = solids;
    return solids;
  }
}
