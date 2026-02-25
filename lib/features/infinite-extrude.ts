import { Shape, Solid } from "../common/shapes.js";
import { Convert } from "../math/convert.js";
import { Vector3d } from "../math/vector3d.js";
import { Sketch } from "./2d/sketch.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Extrudable } from "../helpers/types.js";

export class ExtrudeThroughAll {

  private shapes: Solid[] = null;

  constructor(public extrudable: Extrudable,
    public symmetric: boolean,
    public reversed: boolean) {
  }

  build(): Solid[] {
    if (this.shapes) {
      return this.shapes;
    }

    const solids: Solid[] = [];

    const wires = this.extrudable.getGeometries();
    const plane = this.extrudable.getPlane();

    const faces = FaceMaker.getFaces(wires, plane);

    console.log("Extruding faces:", faces);

    let dir = plane.normal;

    if (this.reversed) {
      dir = dir.multiply(-1);
    }

    if (this.symmetric) {
      for (const face of faces) {
        const solid = ExtrudeOps.makePrismSymmetric(face, dir);
        solids.push(solid as Solid);
        face.dispose();
      }
    }
    else {
      dir = dir.multiply(100000);

      for (const face of faces) {
        const solid = ExtrudeOps.makePrism(face, dir, 1);
        solids.push(solid as Solid);
        face.dispose();
      }
    }

    this.shapes = solids;
    return solids;
  }
}
