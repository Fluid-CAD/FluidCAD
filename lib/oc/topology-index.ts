import type {
  TopoDS_Shape,
  TopTools_IndexedDataMapOfShapeListOfShape,
  TopTools_MapOfShape,
} from "occjs-wrapper";
import { getOC } from "./init.js";

export class TopologyIndex {
  static buildEdgeToFaces(root: TopoDS_Shape): TopTools_IndexedDataMapOfShapeListOfShape {
    const oc = getOC();
    const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape();
    oc.TopExp.MapShapesAndAncestors(
      root,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      map,
    );
    return map;
  }

  static buildShapeSet(shapes: TopoDS_Shape[]): TopTools_MapOfShape {
    const oc = getOC();
    const map = new oc.TopTools_MapOfShape();
    for (const s of shapes) {
      map.Add(s);
    }
    return map;
  }

  static seekShapes(index: TopTools_IndexedDataMapOfShapeListOfShape, key: TopoDS_Shape): TopoDS_Shape[] {
    const idx = index.FindIndex(key);
    if (idx === 0) {
      return [];
    }
    const list = index.ChangeFromIndex(idx);
    if (!list || list.Size() === 0) {
      return [];
    }
    const oc = getOC();
    const copy = new oc.TopTools_ListOfShape(list);
    const out: TopoDS_Shape[] = [];
    while (copy.Size() > 0) {
      out.push(copy.First());
      copy.RemoveFirst();
    }
    copy.delete();
    return out;
  }
}
