import type { TopoDS_Solid } from "ocjs-fluidcad";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { BodyShape } from "./body-shape.js";
// Installs the explorer walk `BodyShape` lists a solid's faces and edges with.
import "../oc/explorer.js";

export class Solid extends BodyShape<TopoDS_Solid> {
  constructor(solid: TopoDS_Solid) {
    super(solid);
  }

  getType(): ShapeType {
    return "solid";
  }

  override isSolid() {
    return true;
  }

  /**
   * A new wrapper over the same raw handle (so the faces are `IsSame` with
   * the original's) with its render seams. Face colours are the holder's
   * records, not the wrapper's: the object that takes the copy carries them
   * over (`SceneObject.carryFaceColors`).
   */
  override copy(): Shape {
    const copied = new Solid(this.getShape());
    for (const edge of this.getRenderSeams()) copied.recordRenderSeam(edge);
    return copied;
  }

  static fromTopoDSSolid(solid: TopoDS_Solid): Solid {
    return new Solid(solid);
  }
}
