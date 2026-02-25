import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";

export class LoftOps {
  static makeLoft(wires: Wire[]): Solid[] {
    const oc = getOC();

    const thruSections = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);

    for (const wire of wires) {
      thruSections.AddWire(wire.getShape());
    }

    const progress = new oc.Message_ProgressRange();
    thruSections.Build(progress);
    progress.delete();

    if (!thruSections.IsDone()) {
      thruSections.delete();
      throw new Error("Loft operation failed.");
    }

    const result = thruSections.Shape();
    thruSections.delete();

    const solids = Explorer.findShapes(result, Explorer.getOcShapeType("solid"));

    if (solids.length === 0) {
      throw new Error("Loft produced no solids.");
    }

    return solids.map(s => Solid.fromTopoDSSolid(Explorer.toSolid(s)));
  }
}
