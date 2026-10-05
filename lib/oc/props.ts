import type { TopoDS_Shape } from "ocjs-fluidcad";
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
    // Eps-driven adaptive integration: the default fixed-order quadrature
    // under-integrates faces trimmed by fitted B-spline pcurves (seen with
    // wrap() pads — ~7% volume error) while this overload stays exact.
    oc.BRepGProp.VolumeProperties(shape, volumeProps, 1e-6, false, false);
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

  /**
   * Volume and centre of mass by the kernel's fixed-order quadrature — several
   * times cheaper than {@link getProperties}' adaptive pass, and less exact on
   * the faces that pass exists for. It integrates the same geometry to the
   * same number every time, which is all telling two bodies apart needs; a
   * number shown to the user wants `getProperties`.
   */
  static getVolumeAndCentroid(shape: TopoDS_Shape): { volume: number; centroid: { x: number; y: number; z: number } } {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    try {
      oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
      const cog = props.CentreOfMass();
      const centroid = { x: cog.X(), y: cog.Y(), z: cog.Z() };
      cog.delete();
      return { volume: props.Mass(), centroid };
    } finally {
      props.delete();
    }
  }
}
