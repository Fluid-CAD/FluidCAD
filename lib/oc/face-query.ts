import type { gp_Pln, gp_Cylinder, TopAbs_ShapeEnum, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { FaceOps } from "./face-ops.js";
import { Convert } from "./convert.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";

export class FaceQuery {
  // Wrapper methods (public API for external callers)
  static isCircleFace(face: Shape, diameter?: number): boolean {
    return FaceQuery.isCircleFaceRaw(face.getShape(), diameter);
  }

  static isConeFace(face: Shape): boolean {
    return FaceQuery.isConeFaceRaw(face.getShape());
  }

  static isCylinderFace(face: Shape, diameter?: number): boolean {
    return FaceQuery.isCylinderFaceRaw(face.getShape(), diameter);
  }

  static isCylinderCurveFace(face: Shape, diameter?: number): boolean {
    return FaceQuery.isCylinderCurveFaceRaw(face.getShape(), diameter);
  }

  static isTorusFace(face: Shape, majorRadius?: number, minorRadius?: number): boolean {
    return FaceQuery.isTorusFaceRaw(face.getShape(), majorRadius, minorRadius);
  }

  static isFaceOnPlane(face: Shape, plane: Plane): boolean {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const result = FaceQuery.isFaceOnPlaneRaw(face.getShape(), gpPln);
    dispose();
    return result;
  }

  static doesFaceIntersectPlane(face: Shape, plane: Plane): boolean {
    const oc = getOC();
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const planeFace = FaceOps.makeFaceFromPlane(gpPln);

    const tool = new oc.IntTools_FaceFace();
    tool.Perform(oc.TopoDS.Face(face.getShape()), planeFace, false);

    let result = false;
    if (tool.IsDone()) {
      result = tool.Lines().Length() > 0 || tool.Points().Length() > 0;
    }

    tool.delete();
    planeFace.delete();
    dispose();
    return result;
  }

  static isFaceParallelToPlane(face: Shape, plane: Plane): boolean {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const result = FaceQuery.isFaceParallelToPlaneRaw(face.getShape(), gpPln);
    dispose();
    return result;
  }

  static isPlanarFace(face: Shape): boolean {
    return FaceQuery.isPlanarFaceRaw(face.getShape());
  }

  static getSurfaceType(face: Shape): string {
    return FaceQuery.getSurfaceTypeRaw(face.getShape());
  }

  static getSurfacePlane(face: Shape): Plane {
    const gpPln = FaceQuery.getSurfaceAdaptorPlaneRaw(face.getShape());
    const result = Convert.toPlane(gpPln);
    gpPln.delete();
    return result;
  }

  static areFacePlanesParallel(face1: Shape, face2: Shape): boolean {
    const plane1 = FaceQuery.getSurfaceAdaptorPlaneRaw(face1.getShape());
    const plane2 = FaceQuery.getSurfaceAdaptorPlaneRaw(face2.getShape());
    const result = FaceQuery.arePlanesParallelRaw(plane1, plane2);
    plane1.delete();
    plane2.delete();
    return result;
  }

  static getSignedPlaneDistance(startFace: Shape, targetFace: Shape): number {
    const startPlane = FaceQuery.getSurfaceAdaptorPlaneRaw(startFace.getShape());
    const targetPlane = FaceQuery.getSurfaceAdaptorPlaneRaw(targetFace.getShape());
    const result = FaceQuery.getSignedPlaneDistanceRaw(startPlane, targetPlane);
    startPlane.delete();
    targetPlane.delete();
    return result;
  }

  static findFarthestCornerDistanceFromFace(targetFace: Shape, sourceFace: Shape): number {
    const sourcePlane = FaceQuery.getSurfaceAdaptorPlaneRaw(sourceFace.getShape());
    const result = FaceQuery.findFarthestCornerDistanceRaw(targetFace.getShape(), sourcePlane);
    sourcePlane.delete();
    return result;
  }

  static makeInfinitePlanarFace(face: Shape, offset?: number, offsetDirection?: Vector3d): Face {
    const gpPln = FaceQuery.getSurfaceAdaptorPlaneRaw(face.getShape());

    if (offset && offsetDirection) {
      const [vec, disposeVec] = Convert.toGpVec(offsetDirection);
      vec.Multiply(offset);
      gpPln.Translate(vec);
      disposeVec();
    }

    const rawFace = FaceOps.makeFaceFromPlane(gpPln);
    gpPln.delete();
    return Face.fromTopoDSFace(rawFace);
  }

  static makeInfiniteCylindricalFace(face: Shape, offset?: number): Face {
    const oc = getOC();
    const cylinder = FaceQuery.getSurfaceAdaptorCylinderRaw(face.getShape());
    const cylMaker = new oc.gce_MakeCylinder(cylinder, offset || 0);
    const rawFace = FaceOps.makeFaceFromCylinder(cylMaker.Value());
    cylinder.delete();
    cylMaker.delete();
    return Face.fromTopoDSFace(rawFace);
  }

  // Raw methods (for oc-internal and common/ use)
  static isCircleFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const faceAdaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const type = faceAdaptor.GetType();

    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      faceAdaptor.delete();
      return false;
    }

    faceAdaptor.delete();

    const edges = Explorer.findShapes(ocFace, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);

    for (const e of edges) {
      const edge = oc.TopoDS.Edge(e);
      const curveAdaptor = new oc.BRepAdaptor_Curve(edge);

      const curveType = curveAdaptor.GetType();
      if (curveType !== oc.GeomAbs_CurveType.GeomAbs_Circle) {
        curveAdaptor.delete();
        return false;
      }

      if (curveAdaptor.IsClosed()) {
        if (diameter === undefined) {
          curveAdaptor.delete();
          return true;
        }

        const circle = curveAdaptor.Circle();
        const r = circle.Radius();
        circle.delete();
        curveAdaptor.delete();
        return Math.abs(r - diameter / 2) <= oc.Precision.Confusion();
      }

      curveAdaptor.delete();
    }

    return false;
  }

  static isConeFaceRaw(face: TopoDS_Shape): boolean {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const faceAdaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const type = faceAdaptor.GetType();
    faceAdaptor.delete();
    return type === oc.GeomAbs_SurfaceType.GeomAbs_Cone;
  }

  static isCylinderFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const faceAdaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const type = faceAdaptor.GetType();
    faceAdaptor.delete();

    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      return false;
    }

    const edges = Explorer.findShapes(ocFace, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);

    for (const edge of edges) {
      const curveAdaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
      const curveType = curveAdaptor.GetType();
      if (curveAdaptor.IsClosed() && curveType === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        if (diameter === undefined) {
          curveAdaptor.delete();
          return true;
        }

        const circle = curveAdaptor.Circle();
        const r = circle.Radius();
        circle.delete();
        curveAdaptor.delete();
        return Math.abs(r - diameter / 2) <= oc.Precision.Confusion();
      }

      curveAdaptor.delete();
    }

    return false;
  }

  static isCylinderCurveFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const faceAdaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const type = faceAdaptor.GetType();
    faceAdaptor.delete();

    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      return false;
    }

    const edges = Explorer.findShapes(ocFace, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);

    for (const edge of edges) {
      const curveAdaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
      const curveType = curveAdaptor.GetType();
      if (curveType === oc.GeomAbs_CurveType.GeomAbs_Circle && !curveAdaptor.IsClosed()) {
        if (diameter === undefined) {
          curveAdaptor.delete();
          return true;
        }

        const circle = curveAdaptor.Circle();
        const r = circle.Radius();
        circle.delete();
        curveAdaptor.delete();
        return Math.abs(r - diameter / 2) <= oc.Precision.Confusion();
      }

      curveAdaptor.delete();
    }

    return false;
  }

  static isTorusFaceRaw(face: TopoDS_Shape, majorRadius?: number, minorRadius?: number): boolean {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const faceAdaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const type = faceAdaptor.GetType();

    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
      faceAdaptor.delete();
      return false;
    }

    if (majorRadius === undefined && minorRadius === undefined) {
      faceAdaptor.delete();
      return true;
    }

    const torus = faceAdaptor.Torus();
    const actualMajor = torus.MajorRadius();
    const actualMinor = torus.MinorRadius();
    torus.delete();
    faceAdaptor.delete();

    const tol = oc.Precision.Confusion();
    if (majorRadius !== undefined && Math.abs(actualMajor - majorRadius) > tol) {
      return false;
    }
    if (minorRadius !== undefined && Math.abs(actualMinor - minorRadius) > tol) {
      return false;
    }
    return true;
  }

  static isFaceOnPlaneRaw(face: TopoDS_Shape, plane: gp_Pln): boolean {
    const oc = getOC();
    return FaceOps.faceOnPlane(oc.TopoDS.Face(face), plane);
  }

  static isFaceParallelToPlaneRaw(face: TopoDS_Shape, plane: gp_Pln): boolean {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const faceAdaptor = new oc.BRepAdaptor_Surface(ocFace, true);

    const facePlane = faceAdaptor.Plane();
    const faceAxis = facePlane.Axis();
    const targetAxis = plane.Axis();
    const faceNormal = faceAxis.Direction();
    const targetNormal = targetAxis.Direction();

    const result = faceNormal.IsParallel(targetNormal, oc.Precision.Angular());

    faceNormal.delete();
    targetNormal.delete();
    faceAxis.delete();
    targetAxis.delete();
    facePlane.delete();
    faceAdaptor.delete();

    return result;
  }

  static isPlanarFaceRaw(face: TopoDS_Shape): boolean {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const result = adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane;
    adaptor.delete();
    return result;
  }

  static getSurfaceTypeRaw(face: TopoDS_Shape): string {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const type = adaptor.GetType();
    adaptor.delete();
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) return "plane";
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return "cylinder";
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) return "cone";
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) return "sphere";
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) return "torus";
    return "other";
  }

  static getSurfaceAdaptorPlaneRaw(face: TopoDS_Shape): gp_Pln {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const plane = adaptor.Plane();
    adaptor.delete();
    return plane;
  }

  static getSurfaceAdaptorCylinderRaw(face: TopoDS_Shape): gp_Cylinder {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const cylinder = adaptor.Cylinder();
    adaptor.delete();
    return cylinder;
  }

  static findFarthestCornerDistanceRaw(face: TopoDS_Shape, plane: gp_Pln): number {
    const oc = getOC();
    const bbox = new oc.Bnd_Box();
    oc.BRepBndLib.Add(face, bbox, true);
    const minPnt = bbox.CornerMin();
    const maxPnt = bbox.CornerMax();
    bbox.delete();

    const corners = [
      new oc.gp_Pnt(minPnt.X(), minPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), minPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(minPnt.X(), maxPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(minPnt.X(), minPnt.Y(), maxPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), maxPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), minPnt.Y(), maxPnt.Z()),
      new oc.gp_Pnt(minPnt.X(), maxPnt.Y(), maxPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), maxPnt.Y(), maxPnt.Z())
    ];

    const planeAxis = plane.Axis();
    const planePoint = planeAxis.Location();
    const planeNormal = planeAxis.Direction();

    let maxDistance = 0;

    for (const corner of corners) {
      const vectorToPoint = new oc.gp_Vec(planePoint, corner);
      const distance = vectorToPoint.Dot(new oc.gp_Vec(planeNormal));

      if (!maxDistance || Math.abs(distance) > Math.abs(maxDistance)) {
        maxDistance = distance;
      }

      vectorToPoint.delete();
      corner.delete();
    }

    planeAxis.delete();
    planePoint.delete();
    planeNormal.delete();

    return maxDistance;
  }

  static arePlanesParallelRaw(plane1: gp_Pln, plane2: gp_Pln): boolean {
    const oc = getOC();
    const dir1 = plane1.Axis().Direction();
    const dir2 = plane2.Axis().Direction();
    const result = dir1.IsParallel(dir2, oc.Precision.Angular());
    dir1.delete();
    dir2.delete();
    return result;
  }

  static findFaceByDistance(faces: Face[], plane: Plane, mode: 'first' | 'last'): Face | null {
    const oc = getOC();
    const tolerance = oc.Precision.Confusion();
    let bestFace: Face | null = null;
    let bestDistance = mode === 'first' ? Infinity : -Infinity;

    for (const face of faces) {
      const distance = plane.distanceToPoint(face.center());
      if (distance < tolerance) {
        continue;
      }
      if (mode === 'first' ? distance < bestDistance : distance > bestDistance) {
        bestDistance = distance;
        bestFace = face;
      }
    }

    return bestFace;
  }

  static getSignedPlaneDistanceRaw(startPlane: gp_Pln, targetPlane: gp_Pln): number {
    const startPlanePosition = startPlane.Location();
    const targetPlanePosition = targetPlane.Location();

    let normalizedStart = Convert.toVector3dFromGpPnt(startPlanePosition);
    if (normalizedStart.length() === 0) {
      const normal = startPlane.Axis().Direction();
      normalizedStart = Convert.toVector3dFromGpDir(normal).normalize();
      normal.delete();
    } else {
      normalizedStart = normalizedStart.normalize();
    }

    let normalizedTarget = Convert.toVector3dFromGpPnt(targetPlanePosition);
    if (normalizedTarget.length() === 0) {
      const normal = targetPlane.Axis().Direction();
      normalizedTarget = Convert.toVector3dFromGpDir(normal).normalize();
      normal.delete();
    } else {
      normalizedTarget = normalizedTarget.normalize();
    }

    const dot = normalizedStart.dot(normalizedTarget);

    let distance = startPlane.Distance(targetPlane);
    if (dot < 0) {
      distance = -distance;
    }

    startPlanePosition.delete();
    targetPlanePosition.delete();
    return distance;
  }
}
