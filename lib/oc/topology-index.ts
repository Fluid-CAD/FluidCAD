import type {
  TopAbs_ShapeEnum,
  TopoDS_Shape,
  TopTools_IndexedDataMapOfShapeListOfShape,
  TopTools_MapOfShape,
} from "ocjs-fluidcad";
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

  /** Whether `sub` (a face/edge/vertex) is a sub-shape of `root`, by TShape identity. */
  static containsSubShape(root: TopoDS_Shape, sub: TopoDS_Shape): boolean {
    const oc = getOC();
    const explorer = new oc.TopExp_Explorer(root, sub.ShapeType(), oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum);
    try {
      while (explorer.More()) {
        if (explorer.Current().IsSame(sub)) {
          return true;
        }
        explorer.Next();
      }
      return false;
    } finally {
      explorer.delete();
    }
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
