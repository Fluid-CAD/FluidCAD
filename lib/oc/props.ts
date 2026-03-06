import type { TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";

export interface ShapeProperties {
  volumeMm3: number;
  surfaceAreaMm2: number;
  centroid: { x: number; y: number; z: number };
}

export class ShapeProps {
  static getProperties(shape: TopoDS_Shape): ShapeProperties {
    const oc = getOC();

    const volumeProps = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape, volumeProps, false, false, false);
    const volumeMm3 = volumeProps.Mass();
    const cog = volumeProps.CentreOfMass();
    const centroid = { x: cog.X(), y: cog.Y(), z: cog.Z() };
    cog.delete();
    volumeProps.delete();

    const surfaceProps = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(shape, surfaceProps, false, false);
    const surfaceAreaMm2 = surfaceProps.Mass();
    surfaceProps.delete();

    return { volumeMm3, surfaceAreaMm2, centroid };
  }
}
