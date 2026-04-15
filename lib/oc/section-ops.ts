import type { TopAbs_ShapeEnum } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Explorer } from "./explorer.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";

export class SectionOps {

  static sectionShapeWithPlane(plane: Plane, shape: Shape): Edge[] {
    const oc = getOC();
    const [pln, disposePln] = Convert.toGpPln(plane);
    const progress = new oc.Message_ProgressRange();

    const section = new oc.BRepAlgoAPI_Section(shape.getShape(), pln, false);
    section.Build(progress);

    if (!section.IsDone()) {
      section.delete();
      progress.delete();
      disposePln();
      return [];
    }

    const result = section.Shape();
    const rawEdges = Explorer.findShapes(result, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
    const edges = rawEdges.map(e => Edge.fromTopoDSEdge(Explorer.toEdge(e)));

    section.delete();
    progress.delete();
    disposePln();

    return edges;
  }
}
