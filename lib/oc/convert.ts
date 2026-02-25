import type {
  gp_Pnt,
  gp_Pnt2d,
  gp_Vec,
  gp_Dir,
  gp_Ax1,
  gp_Ax2,
  gp_Ax3,
  gp_Pln,
  gp_Trsf,
  gp_Quaternion,
} from "occjs-wrapper";
import { getOC } from "./init.js";
import { Point, Point2D } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Axis } from "../math/axis.js";
import { Plane } from "../math/plane.js";
import { CoordinateSystem } from "../math/coordinate-system.js";
import { Matrix4 } from "../math/matrix4.js";
import { Quaternion } from "../math/quaternion.js";

export type Disposable<T> = [T, () => void];

export class Convert {
  static toGpPnt(point: Point): Disposable<gp_Pnt> {
    const oc = getOC();
    const result = new oc.gp_Pnt(point.x, point.y, point.z);
    return [result, () => result.delete()];
  }

  static toPoint(gpPnt: gp_Pnt, deleteSource: boolean = false): Point {
    const result = new Point(gpPnt.X(), gpPnt.Y(), gpPnt.Z());
    if (deleteSource) {
      gpPnt.delete();
    }
    return result;
  }

  static toGpPnt2d(point: Point2D): Disposable<gp_Pnt2d> {
    const oc = getOC();
    const result = new oc.gp_Pnt2d(point.x, point.y);
    return [result, () => result.delete()];
  }

  static toPoint2D(gpPnt2d: gp_Pnt2d, deleteSource: boolean = false): Point2D {
    const result = new Point2D(gpPnt2d.X(), gpPnt2d.Y());
    if (deleteSource) {
      gpPnt2d.delete();
    }
    return result;
  }

  static toGpPntFrom2D(point: Point2D): Disposable<gp_Pnt> {
    const oc = getOC();
    const result = new oc.gp_Pnt(point.x, point.y, 0);
    return [result, () => result.delete()];
  }

  static toPoint2DFromGpPnt(gpPnt: gp_Pnt, deleteSource: boolean = false): Point2D {
    const result = new Point2D(gpPnt.X(), gpPnt.Y());
    if (deleteSource) {
      gpPnt.delete();
    }
    return result;
  }

  static toGpVec(vector: Vector3d): Disposable<gp_Vec> {
    const oc = getOC();
    const result = new oc.gp_Vec(vector.x, vector.y, vector.z);
    return [result, () => result.delete()];
  }

  static toVector3d(gpVec: gp_Vec, deleteSource: boolean = false): Vector3d {
    const result = new Vector3d(gpVec.X(), gpVec.Y(), gpVec.Z());
    if (deleteSource) {
      gpVec.delete();
    }
    return result;
  }

  static toGpDir(vector: Vector3d): Disposable<gp_Dir> {
    const oc = getOC();
    const result = new oc.gp_Dir(vector.x, vector.y, vector.z);
    return [result, () => result.delete()];
  }

  static toVector3dFromGpDir(gpDir: gp_Dir, deleteSource: boolean = false): Vector3d {
    const result = new Vector3d(gpDir.X(), gpDir.Y(), gpDir.Z());
    if (deleteSource) {
      gpDir.delete();
    }
    return result;
  }

  static toGpVecFromPoint(point: Point): Disposable<gp_Vec> {
    const oc = getOC();
    const result = new oc.gp_Vec(point.x, point.y, point.z);
    return [result, () => result.delete()];
  }

  static toVector3dFromGpPnt(gpPnt: gp_Pnt, deleteSource: boolean = false): Vector3d {
    const result = new Vector3d(gpPnt.X(), gpPnt.Y(), gpPnt.Z());
    if (deleteSource) {
      gpPnt.delete();
    }
    return result;
  }

  static toGpAx1(axis: Axis): Disposable<gp_Ax1> {
    const oc = getOC();
    const [pnt, disposePnt] = Convert.toGpPnt(axis.origin);
    const [dir, disposeDir] = Convert.toGpDir(axis.direction);
    const result = new oc.gp_Ax1(pnt, dir);
    return [result, () => { result.delete(); disposePnt(); disposeDir(); }];
  }

  static toAxis(gpAx1: gp_Ax1, deleteSource: boolean = false): Axis {
    const origin = Convert.toPoint(gpAx1.Location(), true);
    const direction = Convert.toVector3dFromGpDir(gpAx1.Direction(), true);
    if (deleteSource) {
      gpAx1.delete();
    }
    return new Axis(origin, direction);
  }

  static toGpAx2(cs: CoordinateSystem): Disposable<gp_Ax2> {
    const oc = getOC();
    const [pnt, disposePnt] = Convert.toGpPnt(cs.origin);
    const [mainDir, disposeMainDir] = Convert.toGpDir(cs.mainDirection);
    const [xDir, disposeXDir] = Convert.toGpDir(cs.xDirection);
    const result = new oc.gp_Ax2(pnt, mainDir, xDir);
    return [result, () => { result.delete(); disposePnt(); disposeMainDir(); disposeXDir(); }];
  }

  static toCoordinateSystem(gpAx2: gp_Ax2, deleteSource: boolean = false): CoordinateSystem {
    const origin = Convert.toPoint(gpAx2.Location(), true);
    const mainDirection = Convert.toVector3dFromGpDir(gpAx2.Direction(), true);
    const xDirection = Convert.toVector3dFromGpDir(gpAx2.XDirection(), true);
    if (deleteSource) {
      gpAx2.delete();
    }
    return new CoordinateSystem(origin, mainDirection, xDirection);
  }

  static toGpAx3(cs: CoordinateSystem): Disposable<gp_Ax3> {
    const oc = getOC();
    const [pnt, disposePnt] = Convert.toGpPnt(cs.origin);
    const [mainDir, disposeMainDir] = Convert.toGpDir(cs.mainDirection);
    const [xDir, disposeXDir] = Convert.toGpDir(cs.xDirection);
    const result = new oc.gp_Ax3(pnt, mainDir, xDir);
    return [result, () => { result.delete(); disposePnt(); disposeMainDir(); disposeXDir(); }];
  }

  static toCoordinateSystemFromGpAx3(gpAx3: gp_Ax3, deleteSource: boolean = false): CoordinateSystem {
    const origin = Convert.toPoint(gpAx3.Location(), true);
    const mainDirection = Convert.toVector3dFromGpDir(gpAx3.Direction(), true);
    const xDirection = Convert.toVector3dFromGpDir(gpAx3.XDirection(), true);
    if (deleteSource) {
      gpAx3.delete();
    }
    return new CoordinateSystem(origin, mainDirection, xDirection);
  }

  static toGpPln(plane: Plane): Disposable<gp_Pln> {
    const oc = getOC();
    const [pnt, disposePnt] = Convert.toGpPnt(plane.origin);
    const [normalDir, disposeNormalDir] = Convert.toGpDir(plane.normal);
    const [xDir, disposeXDir] = Convert.toGpDir(plane.xDirection);
    const ax3 = new oc.gp_Ax3(pnt, normalDir, xDir);
    const result = new oc.gp_Pln(ax3);
    return [result, () => { result.delete(); ax3.delete(); disposePnt(); disposeNormalDir(); disposeXDir(); }];
  }

  static toPlane(gpPln: gp_Pln, deleteSource: boolean = false): Plane {
    const origin = Convert.toPoint(gpPln.Location(), true);
    const xDirection = Convert.toVector3dFromGpDir(gpPln.XAxis().Direction(), true);
    const normal = Convert.toVector3dFromGpDir(gpPln.Axis().Direction(), true);
    if (deleteSource) {
      gpPln.delete();
    }
    return new Plane(origin, xDirection, normal);
  }

  static toGpTrsf(matrix: Matrix4): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const m = matrix.elements;
    trsf.SetValues(
      m[0], m[4], m[8], m[12],
      m[1], m[5], m[9], m[13],
      m[2], m[6], m[10], m[14]
    );
    return [trsf, () => trsf.delete()];
  }

  static toMatrix4(gpTrsf: gp_Trsf, deleteSource: boolean = false): Matrix4 {
    const elements = [
      gpTrsf.Value(1, 1), gpTrsf.Value(2, 1), gpTrsf.Value(3, 1), 0,
      gpTrsf.Value(1, 2), gpTrsf.Value(2, 2), gpTrsf.Value(3, 2), 0,
      gpTrsf.Value(1, 3), gpTrsf.Value(2, 3), gpTrsf.Value(3, 3), 0,
      gpTrsf.Value(1, 4), gpTrsf.Value(2, 4), gpTrsf.Value(3, 4), 1,
    ];
    if (deleteSource) {
      gpTrsf.delete();
    }
    return new Matrix4(elements);
  }

  static toGpQuaternion(quaternion: Quaternion): Disposable<gp_Quaternion> {
    const oc = getOC();
    const result = new oc.gp_Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    return [result, () => result.delete()];
  }

  static toQuaternion(gpQuaternion: gp_Quaternion, deleteSource: boolean = false): Quaternion {
    const result = new Quaternion(
      gpQuaternion.X(),
      gpQuaternion.Y(),
      gpQuaternion.Z(),
      gpQuaternion.W()
    );
    if (deleteSource) {
      gpQuaternion.delete();
    }
    return result;
  }

  static toGpTrsfTranslation(dx: number, dy: number, dz: number): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const vec = new oc.gp_Vec(dx, dy, dz);
    trsf.SetTranslation(vec);
    return [trsf, () => { trsf.delete(); vec.delete(); }];
  }

  static toGpTrsfTranslationVec(vector: Vector3d): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const [vec, disposeVec] = Convert.toGpVec(vector);
    trsf.SetTranslation(vec);
    return [trsf, () => { trsf.delete(); disposeVec(); }];
  }

  static toGpTrsfRotation(axis: Axis, angle: number): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const [ax1, disposeAx1] = Convert.toGpAx1(axis);
    trsf.SetRotation(ax1, angle);
    return [trsf, () => { trsf.delete(); disposeAx1(); }];
  }

  static toGpTrsfScale(center: Point, factor: number): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const [pnt, disposePnt] = Convert.toGpPnt(center);
    trsf.SetScale(pnt, factor);
    return [trsf, () => { trsf.delete(); disposePnt(); }];
  }

  static toGpTrsfMirrorPoint(point: Point): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const [pnt, disposePnt] = Convert.toGpPnt(point);
    trsf.SetMirror(pnt);
    return [trsf, () => { trsf.delete(); disposePnt(); }];
  }

  static toGpTrsfMirrorAxis(axis: Axis): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const [ax1, disposeAx1] = Convert.toGpAx1(axis);
    trsf.SetMirror(ax1);
    return [trsf, () => { trsf.delete(); disposeAx1(); }];
  }

  static toGpTrsfMirrorPlane(plane: Plane): Disposable<gp_Trsf> {
    const oc = getOC();
    const trsf = new oc.gp_Trsf();
    const [pnt, disposePnt] = Convert.toGpPnt(plane.origin);
    const [dir, disposeDir] = Convert.toGpDir(plane.normal);
    const ax2 = new oc.gp_Ax2(pnt, dir);
    trsf.SetMirror(ax2);
    return [trsf, () => { trsf.delete(); ax2.delete(); disposePnt(); disposeDir(); }];
  }
}
