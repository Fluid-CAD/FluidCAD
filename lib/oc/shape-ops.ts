import type {
  TopTools_ListOfShape,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Solid,
} from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Matrix4 } from "../math/matrix4.js";
import { Vector3d } from "../math/vector3d.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Solid } from "../common/solid.js";
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
    const unify = new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
    unify.Build();
    let cleaned = unify.Shape();
    unify.delete();

    // Validate — UnifySameDomain can corrupt periodic surfaces (e.g. cylinders)
    const checker = new oc.BRepCheck_Analyzer(cleaned, true, false);
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

  static getSolidOutwardNormal(face: Face, solid: Solid): Vector3d {
    return ShapeOps.getSolidOutwardNormalRaw(face.getShape() as TopoDS_Face, solid.getShape() as TopoDS_Solid);
  }

  static getSolidOutwardNormalRaw(face: TopoDS_Face, solid: TopoDS_Solid): Vector3d {
    const oc = getOC();

    const surfaceAdaptor = new oc.BRepAdaptor_Surface(face, true);
    const type = surfaceAdaptor.GetType();

    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      surfaceAdaptor.delete();
      throw new Error("Non-planar faces not supported for normal calculation");
    }

    const uFirst = surfaceAdaptor.FirstUParameter();
    const uLast = surfaceAdaptor.LastUParameter();
    const vFirst = surfaceAdaptor.FirstVParameter();
    const vLast = surfaceAdaptor.LastVParameter();

    const u = (uFirst + uLast) / 2.0;
    const v = (vFirst + vLast) / 2.0;

    const testPoint = new oc.gp_Pnt();
    const du = new oc.gp_Vec();
    const dv = new oc.gp_Vec();

    surfaceAdaptor.D1(u, v, testPoint, du, dv);

    const geometricNormal = surfaceAdaptor.Plane().Position().Direction();

    if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
      geometricNormal.Reverse();
    }

    const offset = 1e-6;
    const testPointOffset = new oc.gp_Pnt(
      testPoint.X() + geometricNormal.X() * offset,
      testPoint.Y() + geometricNormal.Y() * offset,
      testPoint.Z() + geometricNormal.Z() * offset
    );

    const classifier = new oc.BRepClass3d_SolidClassifier(solid, testPointOffset, oc.Precision.Confusion());
    const state = classifier.State();

    let result: Vector3d;

    if (state === oc.TopAbs_State.TopAbs_IN) {
      result = new Vector3d(
        -geometricNormal.X(),
        -geometricNormal.Y(),
        -geometricNormal.Z()
      );
    } else {
      result = new Vector3d(
        geometricNormal.X(),
        geometricNormal.Y(),
        geometricNormal.Z()
      );
    }

    classifier.delete();
    testPointOffset.delete();
    geometricNormal.delete();
    du.delete();
    dv.delete();
    testPoint.delete();
    surfaceAdaptor.delete();

    return result;
  }

  static mirrorShape(shape: Shape, mirrorPoint: { x: number; y: number; z: number }): Shape {
    const result = ShapeOps.mirrorShapeRaw(shape.getShape(), mirrorPoint);
    return ShapeFactory.fromShape(result);
  }

  static mirrorShapeRaw(shape: TopoDS_Shape, mirrorPoint: { x: number; y: number; z: number }): TopoDS_Shape {
    const oc = getOC();
    const point = new oc.gp_Pnt(mirrorPoint.x, mirrorPoint.y, mirrorPoint.z);
    const trsf = new oc.gp_Trsf();
    trsf.SetMirror(point);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(shape, true);
    const result = transformer.Shape();
    transformer.delete();
    trsf.delete();
    point.delete();
    return result;
  }

  static translateShape(shape: Shape, direction: Vector3d): Shape {
    const result = ShapeOps.translateShapeRaw(shape.getShape(), direction);
    return ShapeFactory.fromShape(result);
  }

  static translateShapeRaw(shape: TopoDS_Shape, direction: Vector3d): TopoDS_Shape {
    const oc = getOC();
    const [vec, disposeVec] = Convert.toGpVec(direction);
    const trsf = new oc.gp_Trsf();
    trsf.SetTranslation(vec);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(shape, false);
    const result = transformer.Shape();
    transformer.delete();
    trsf.delete();
    disposeVec();
    return result;
  }

  static rotateShape(shape: TopoDS_Shape, axis: any, angle: number): TopoDS_Shape {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    trsf.SetRotation(axis, angle);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(shape, false);
    const result = transformer.Shape();
    transformer.delete();
    trsf.delete();
    return result;
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

  static edgeMiddlePoint(edge: TopoDS_Edge) {
    const oc = getOC();
    const curveAdaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const curve = curveAdaptor.Curve();

    const midParam = (curve.FirstParameter() + curve.LastParameter()) / 2.0;
    const midPoint = curve.Value(midParam);

    const result = new oc.gp_Pnt(midPoint.X(), midPoint.Y(), midPoint.Z());

    curveAdaptor.delete();

    return result;
  }
}
