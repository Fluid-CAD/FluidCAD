import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../../../oc/init.js";

// Raw-kernel test solids for the drawing tests: exact primitives whose
// projections have closed forms. Shapes are never freed — the tests are
// short-lived and the handful of solids is noise next to a scene.

type V3 = [number, number, number];

export class DrawingModels {
  /** A box from the origin corner `at`, `size` along X, Y, Z. */
  static box(size: V3, at: V3 = [0, 0, 0]): TopoDS_Shape {
    const oc = getOC();
    const corner = new oc.gp_Pnt(at[0], at[1], at[2]);
    const maker = new oc.BRepPrimAPI_MakeBox(corner, size[0], size[1], size[2]);
    const shape = maker.Shape();
    corner.delete();
    return shape;
  }

  /** A cylinder whose base centre is `base`, axis along `axis`. */
  static cylinder(radius: number, height: number, base: V3 = [0, 0, 0], axis: V3 = [0, 0, 1]): TopoDS_Shape {
    const oc = getOC();
    const origin = new oc.gp_Pnt(base[0], base[1], base[2]);
    const dir = new oc.gp_Dir(axis[0], axis[1], axis[2]);
    const frame = new oc.gp_Ax2(origin, dir);
    const shape = new oc.BRepPrimAPI_MakeCylinder(frame, radius, height).Shape();
    frame.delete();
    dir.delete();
    origin.delete();
    return shape;
  }

  static sphere(radius: number, center: V3 = [0, 0, 0]): TopoDS_Shape {
    const oc = getOC();
    const origin = new oc.gp_Pnt(center[0], center[1], center[2]);
    const shape = new oc.BRepPrimAPI_MakeSphere(origin, radius).Shape();
    origin.delete();
    return shape;
  }

  static cut(base: TopoDS_Shape, tool: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    const progress = new oc.Message_ProgressRange();
    const op = new oc.BRepAlgoAPI_Cut(base, tool, progress);
    op.Build(progress);
    const shape = op.Shape();
    progress.delete();
    return shape;
  }

  static fuse(a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    const progress = new oc.Message_ProgressRange();
    const op = new oc.BRepAlgoAPI_Fuse(a, b, progress);
    op.Build(progress);
    const shape = op.Shape();
    progress.delete();
    return shape;
  }

  /** A 40 × 30 × 10 plate with a through hole of radius 5 at (20, 15). */
  static plateWithHole(): TopoDS_Shape {
    return DrawingModels.cut(
      DrawingModels.box([40, 30, 10]),
      DrawingModels.cylinder(5, 12, [20, 15, -1]),
    );
  }
}
