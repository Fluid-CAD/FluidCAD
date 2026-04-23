import type {
  TopTools_ListOfShape,
  TopoDS_Shape,
} from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shape.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { BoundingBox } from "../helpers/types.js";

export class ShapeOps {
  static transform(shape: Shape, matrix: Matrix4): Shape {
    const oc = getOC();
    const [trsf, disposeTrsf] = Convert.toGpTrsf(matrix);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(shape.getShape(), true);
    const raw = transformer.Shape();
    const transformed = ShapeFactory.fromShape(raw);

    if (shape.hasColors()) {
      const sourceFaces = shape.getSubShapes("face");

      for (const sourceFace of sourceFaces) {
        const faceColor = shape.getColor(sourceFace.getShape());
        if (faceColor) {
          const modifiedFace = transformer.ModifiedShape(sourceFace.getShape());
          transformed.setColor(modifiedFace, faceColor);
        }
      }
    }

    if (shape.isMetaShape()) {
      transformed.markAsMetaShape(shape.metaType);
    }

    if (shape.isGuideShape()) {
      transformed.markAsGuide();
    }

    transformer.delete();
    disposeTrsf();

    return transformed;
  }

  static getBoundingBox(shape: Shape | TopoDS_Shape): BoundingBox {
    const raw = shape instanceof Shape ? shape.getShape() : shape;
    return ShapeOps.getBoundingBoxRaw(raw);
  }

  static getBoundingBoxRaw(shape: TopoDS_Shape): BoundingBox {
    const oc = getOC();
    const bbox = new oc.Bnd_Box();
    oc.BRepBndLib.Add(shape, bbox, true);

    const minPnt = bbox.CornerMin();
    const maxPnt = bbox.CornerMax();

    bbox.delete();

    return {
      minX: minPnt.X(),
      minY: minPnt.Y(),
      minZ: minPnt.Z(),
      maxX: maxPnt.X(),
      maxY: maxPnt.Y(),
      maxZ: maxPnt.Z(),
      centerX: (minPnt.X() + maxPnt.X()) / 2,
      centerY: (minPnt.Y() + maxPnt.Y()) / 2,
      centerZ: (minPnt.Z() + maxPnt.Z()) / 2,
    };
  }

  static makeCompound(shapes: Shape[]): Shape {
    const raw = ShapeOps.makeCompoundRaw(shapes.map(s => s.getShape()));
    return ShapeFactory.fromShape(raw);
  }

  static makeCompoundRaw(shapes: TopoDS_Shape[]) {
    const oc = getOC();
    const compoundBuilder = new oc.BRep_Builder();
    const compound = new oc.TopoDS_Compound();
    compoundBuilder.MakeCompound(compound);

    for (const shape of shapes) {
      compoundBuilder.Add(compound, shape);
    }

    return compound;
  }

  static cleanShape(shape: Shape): Shape {
    return ShapeFactory.fromShape(ShapeOps.cleanShapeRaw(shape.getShape()));
  }

  static cleanShapeRaw(shape: TopoDS_Shape) {
    const oc = getOC();

    // Full unification: merge redundant edges AND co-surface faces
    const unify = new oc.ShapeUpgrade_UnifySameDomain(shape, false, true, false);
    unify.Build();
    let cleaned = unify.Shape();
    unify.delete();

    // Validate — UnifySameDomain can corrupt periodic surfaces (e.g. cylinders)
    const checker = new oc.BRepCheck_Analyzer(cleaned, true, true);
    if (checker.IsValid()) {
      checker.delete();
      return cleaned;
    }
    checker.delete();

    // Repair with ShapeFix_Shape (fixes seam edges, wire orientation, SameParameter)
    const fixer = new oc.ShapeFix_Shape(cleaned);
    const progress = new oc.Message_ProgressRange();
    fixer.Perform(progress);
    const fixed = fixer.Shape();
    fixer.delete();
    progress.delete();

    return fixed;
  }

  static shapeListToArray(list: TopTools_ListOfShape) {
    let res: TopoDS_Shape[] = [];
    while (list.Size() > 0) {
      res.push(list.First());
      list.RemoveFirst();
    }
    list.delete();
    return res;
  }
}
