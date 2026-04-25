import type { BRepPrimAPI_MakeRevol, gp_Pln, gp_Vec, TopoDS_Face, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { Axis } from "../math/axis.js";
import { Explorer } from "./explorer.js";
import { Shape } from "../common/shape.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { ShapeOps } from "./shape-ops.js";

export class ExtrudeOps {
  static makePrism(shape: Shape, direction: Vector3d, distance: number): Shape {
    const oc = getOC();
    const [vec, disposeVec] = Convert.toGpVec(direction.multiply(distance));
    const prism = new oc.BRepPrimAPI_MakePrism(shape.getShape(), vec, false, true);
    const result = prism.Shape();
    prism.delete();
    disposeVec();
    return ShapeFactory.fromShape(result);
  }

  static makePrismFromVec(shape: Shape, vec: Vector3d): { solid: Shape; firstFace: Shape; lastFace: Shape } {
    const oc = getOC();
    const [gpVec, disposeVec] = Convert.toGpVec(vec);
    const prism = new oc.BRepPrimAPI_MakePrism(shape.getShape(), gpVec, true, true);
    if (!prism.IsDone()) {
      prism.delete();
      disposeVec();
      throw new Error("Extrusion failed");
    }
    const solid = prism.Shape();
    const firstFace = prism.FirstShape();
    const lastFace = prism.LastShape();
    prism.delete();
    disposeVec();
    return {
      solid: ShapeFactory.fromShape(solid),
      firstFace: ShapeFactory.fromShape(firstFace),
      lastFace: ShapeFactory.fromShape(lastFace),
    };
  }

  static makePrismInfinite(shape: Shape, direction: Vector3d): Shape {
    const oc = getOC();
    const [vec, disposeVec] = Convert.toGpVec(direction);
    const prism = new oc.BRepPrimAPI_MakePrism(shape.getShape(), vec, true, true);
    const result = prism.Shape();
    prism.delete();
    disposeVec();
    return ShapeFactory.fromShape(result);
  }

  static makePrismSymmetric(shape: Shape, direction: Vector3d): Shape {
    const oc = getOC();
    const [dir, disposeDir] = Convert.toGpDir(direction);
    const prism = new oc.BRepPrimAPI_MakePrism(shape.getShape(), dir, true, false, true);
    if (!prism.IsDone()) {
      prism.delete();
      disposeDir();
      throw new Error("Symmetric extrusion failed");
    }
    const result = prism.Shape();
    prism.delete();
    disposeDir();
    return ShapeFactory.fromShape(result);
  }

  static makeRevol(shape: Shape, axis: Axis, angle: number): Shape {
    const oc = getOC();
    const [ax1, disposeAx1] = Convert.toGpAx1(axis);
    let revol: BRepPrimAPI_MakeRevol;
    try {
      revol = new oc.BRepPrimAPI_MakeRevol(shape.getShape(), ax1, angle, true);
    } catch {
      disposeAx1();
      throw new Error("Revolution failed");
    }
    if (!revol.IsDone()) {
      revol.delete();
      disposeAx1();
      throw new Error("Revolution failed");
    }
    const rawResult = revol.Shape();
    revol.delete();
    disposeAx1();

    // A profile face whose normal points "backwards" relative to the axis
    // produces a closed solid with inverted shell orientation. Volume can
    // still be positive but downstream boolean ops fail. OrientClosedSolid
    // flips the shell to outward-facing when needed.
    let oriented = rawResult;
    if (Explorer.isSolid(rawResult)) {
      const solid = Explorer.toSolid(rawResult);
      oc.BRepLib.OrientClosedSolid(solid);
      oriented = solid;
    }

    const clean = ShapeOps.cleanShapeRaw(oriented);
    return ShapeFactory.fromShape(clean);
  }

  static applyDraftOnSideFaces(
    solid: Shape,
    firstFace: Shape,
    lastFace: Shape,
    plane: Plane,
    angle: number
  ): { solid: Shape; firstFace: Shape; lastFace: Shape } {
    const oc = getOC();
    const [dir, disposeDir] = Convert.toGpDir(plane.normal);
    const [pln, disposePln] = Convert.toGpPln(plane);

    const solidRaw = solid.getShape();
    const firstFaceRaw = firstFace.getShape();
    const lastFaceRaw = lastFace.getShape();

    const draftMaker = new oc.BRepOffsetAPI_DraftAngle(solidRaw);
    const sideFaces = Explorer.findShapes(solidRaw, Explorer.getOcShapeType("face")).filter(
      f => !f.IsSame(firstFaceRaw) && !f.IsSame(lastFaceRaw)
    );

    for (const face of sideFaces) {
      draftMaker.Add(Explorer.toFace(face), dir, angle, pln, true);
    }

    const progress = new oc.Message_ProgressRange();
    draftMaker.Build(progress);
    progress.delete();

    if (!draftMaker.IsDone()) {
      draftMaker.delete();
      disposeDir();
      disposePln();
      throw new Error("Draft application failed");
    }

    const modifiedFirst = ShapeOps.shapeListToArray(draftMaker.Modified(firstFaceRaw));
    const modifiedLast = ShapeOps.shapeListToArray(draftMaker.Modified(lastFaceRaw));

    const newFirstFace = modifiedFirst.length > 0
      ? ShapeFactory.fromShape(modifiedFirst[0])
      : firstFace;
    const newLastFace = modifiedLast.length > 0
      ? ShapeFactory.fromShape(modifiedLast[0])
      : lastFace;

    const result = draftMaker.Shape();
    draftMaker.delete();
    disposeDir();
    disposePln();
    return {
      solid: ShapeFactory.fromShape(result),
      firstFace: newFirstFace,
      lastFace: newLastFace,
    };
  }

  static applyDraft(shape: TopoDS_Shape, direction: Vector3d, angle: number): TopoDS_Shape {
    const oc = getOC();
    const [dir, disposeDir] = Convert.toGpDir(direction);

    const draftMaker = new oc.BRepOffsetAPI_DraftAngle(shape);
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);

    while (explorer.More()) {
      const face = oc.TopoDS.Face(explorer.Current());
      const adaptor = new oc.BRepAdaptor_Surface(face, true);

      if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        adaptor.delete();
        explorer.Next();
        continue;
      }

      const facePlane = adaptor.Plane();
      const faceNormal = facePlane.Axis().Direction();
      const dot = Math.abs(faceNormal.Dot(dir));
      faceNormal.delete();
      adaptor.delete();

      if (dot > 0.999) {
        facePlane.delete();
        explorer.Next();
        continue;
      }

      draftMaker.Add(face, dir, angle, facePlane, true);
      facePlane.delete();
      explorer.Next();
    }

    explorer.delete();
    const progress = new oc.Message_ProgressRange();
    draftMaker.Build(progress);
    progress.delete();

    if (!draftMaker.IsDone()) {
      draftMaker.delete();
      disposeDir();
      throw new Error("Draft operation failed");
    }

    const result = draftMaker.Shape();
    draftMaker.delete();
    disposeDir();
    return result;
  }
}
