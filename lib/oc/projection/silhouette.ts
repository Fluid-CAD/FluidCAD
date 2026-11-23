import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Convert } from "../convert.js";
import { Explorer } from "../explorer.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { HiddenLineProjection } from "./hidden-line.js";

/**
 * Outline (apparent-contour, "silhouette") edges of a face for a viewing
 * direction — the generatrices of a cylinder or cone seen from the side, the
 * great circle of a sphere, the crest curve of a torus or B-spline surface.
 * Projecting a curved face onto a sketch plane needs them next to the face's
 * boundary edges, or a side-on cylinder projects to nothing but its end
 * circles.
 *
 * Computed by OCCT's hidden-line front end without the hiding pass
 * (`HiddenLineProjection.withAlgo`): HLRBRep_Algo.Update() runs the
 * apparent-contour computation (Contap) and
 * splits the face along it, ShowAll() marks every edge visible so no
 * visibility work runs, and HLRToShape's 3D outline compound hands back the
 * contour as real edges on the surface, in world coordinates, trimmed to the
 * face.
 */
export class SilhouetteOps {
  static outlineEdgesRaw(face: TopoDS_Face, direction: Vector3d): TopoDS_Edge[] {
    const oc = getOC();
    const [origin, disposeOrigin] = Convert.toGpPnt(new Point(0, 0, 0));
    const [dir, disposeDir] = Convert.toGpDir(direction.normalize());
    const frame = new oc.gp_Ax2(origin, dir);
    try {
      return HiddenLineProjection.withAlgo([face], frame, false, (toShape) => {
        const compound = toShape.OutLineVCompound3d();
        if (compound.IsNull()) {
          return [];
        }
        const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
        return Explorer.findShapes<TopoDS_Edge>(compound, EDGE)
          .map(e => oc.TopoDS.Edge(e))
          .filter(e => !oc.BRep_Tool.Degenerated(e));
      });
    } finally {
      frame.delete();
      disposeDir();
      disposeOrigin();
    }
  }
}
