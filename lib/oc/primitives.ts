import type { TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Solid } from "../common/solid.js";
import { Explorer } from "./explorer.js";

export class Primitives {
  static makeCylinder(radius: number, height: number): Solid {
    const oc = getOC();
    const cylinderMaker = new oc.BRepPrimAPI_MakeCylinder(radius, height);
    const shape = cylinderMaker.Shape();
    cylinderMaker.delete();
    return Solid.fromTopoDSSolid(Explorer.toSolid(shape));
  }

  static makeSphere(radius: number, angle: number): Solid {
    const oc = getOC();
    const sphereMaker = new oc.BRepPrimAPI_MakeSphere(radius, angle);
    const sphere = sphereMaker.Shape();
    sphereMaker.delete();
    return Solid.fromTopoDSSolid(Explorer.toSolid(sphere));
  }
}
