import type { TopAbs_ShapeEnum, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";

export interface FaceProperties {
  surfaceType: 'plane' | 'circle' | 'cylinder' | 'sphere' | 'torus' | 'cone' | 'other';
  areaMm2?: number;
  radius?: number;
  majorRadius?: number;
  minorRadius?: number;
  halfAngleDeg?: number;
}

export class FaceProps {
  static getProperties(face: TopoDS_Shape): FaceProperties {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(ocFace, true);
    const type = adaptor.GetType();

    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      adaptor.delete();
      // Check if it's a circular face (plane with a single closed circular edge)
      const edges = Explorer.findShapes(ocFace, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
      let isCircle = false;
      let circleRadius = 0;

      if (edges.length >= 1) {
        let allCircular = true;
        let closedCircleFound = false;

        for (const e of edges) {
          const curveAdaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e));
          const curveType = curveAdaptor.GetType();
          if (curveType !== oc.GeomAbs_CurveType.GeomAbs_Circle) {
            allCircular = false;
            curveAdaptor.delete();
            break;
          }
          if (curveAdaptor.IsClosed()) {
            const circle = curveAdaptor.Circle();
            circleRadius = circle.Radius();
            circle.delete();
            closedCircleFound = true;
          }
          curveAdaptor.delete();
        }

        isCircle = allCircular && closedCircleFound;
      }

      if (isCircle) {
        return { surfaceType: 'circle', radius: circleRadius };
      }

      const surfaceProps = new oc.GProp_GProps();
      oc.BRepGProp.SurfaceProperties(ocFace, surfaceProps, false, false);
      const areaMm2 = surfaceProps.Mass();
      surfaceProps.delete();
      return { surfaceType: 'plane', areaMm2 };
    }

    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      const cylinder = adaptor.Cylinder();
      const radius = cylinder.Radius();
      cylinder.delete();
      adaptor.delete();
      return { surfaceType: 'cylinder', radius };
    }

    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
      const sphere = adaptor.Sphere();
      const radius = sphere.Radius();
      sphere.delete();
      adaptor.delete();
      return { surfaceType: 'sphere', radius };
    }

    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
      const torus = adaptor.Torus();
      const majorRadius = torus.MajorRadius();
      const minorRadius = torus.MinorRadius();
      torus.delete();
      adaptor.delete();
      return { surfaceType: 'torus', majorRadius, minorRadius };
    }

    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
      const cone = adaptor.Cone();
      const halfAngleDeg = cone.SemiAngle() * (180 / Math.PI);
      cone.delete();
      adaptor.delete();
      return { surfaceType: 'cone', halfAngleDeg };
    }

    adaptor.delete();

    const surfaceProps = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(ocFace, surfaceProps, false, false);
    const areaMm2 = surfaceProps.Mass();
    surfaceProps.delete();
    return { surfaceType: 'other', areaMm2 };
  }
}
