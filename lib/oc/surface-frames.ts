import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";

/**
 * The defining geometry of a face's elementary surface, read through the
 * face's location — enough to tell whether two faces lie on the same surface
 * whatever their frames' parametrization or handedness.
 */
export type SurfaceFrame = {
  type: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus';
  direct: boolean;
  /** A point of the plane or axis (the centre for a sphere). */
  loc: [number, number, number];
  /** The plane normal / axis direction (undefined for a sphere). */
  dir?: [number, number, number];
  /** The frame's X direction — where the surface's u parameter starts. */
  xdir: [number, number, number];
  /** 0 for a plane. */
  radius: number;
  /** Cone semi-angle / torus minor radius; 0 otherwise. */
  extra: number;
};

/** Linear and angular (radians) bounds for comparing two frames. */
export type SurfaceTolerance = { lin: number; ang: number };

export class SurfaceFrames {

  /**
   * The frame of `face`'s surface, or null when it is not an elementary
   * surface — or is a plane the caller asked to skip.
   */
  static of(face: TopoDS_Shape, skipPlanes = false): SurfaceFrame | null {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), false);
    try {
      const type = adaptor.GetType();
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        return skipPlanes ? null : SurfaceFrames.frameOf('plane', adaptor.Plane().Position(), 0, 0);
      }
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
        const cyl = adaptor.Cylinder();
        return SurfaceFrames.frameOf('cylinder', cyl.Position(), cyl.Radius(), 0);
      }
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
        const cone = adaptor.Cone();
        return SurfaceFrames.frameOf('cone', cone.Position(), cone.RefRadius(), cone.SemiAngle());
      }
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
        const sphere = adaptor.Sphere();
        return SurfaceFrames.frameOf('sphere', sphere.Position(), sphere.Radius(), 0);
      }
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
        const torus = adaptor.Torus();
        return SurfaceFrames.frameOf('torus', torus.Position(), torus.MajorRadius(), torus.MinorRadius());
      }
      return null;
    } finally {
      adaptor.delete();
    }
  }

  /** OCCT's own confusion tolerances — the bounds UnifySameDomain merges within. */
  static kernelTolerance(): SurfaceTolerance {
    const oc = getOC();
    return { lin: oc.Precision.Confusion(), ang: oc.Precision.Angular() };
  }

  /**
   * Same surface geometry within `tol`, handedness aside. The default is
   * looser than the kernel's: DirectFaces rebuilds any pair near enough for
   * the merge to reach for.
   */
  static same(a: SurfaceFrame, b: SurfaceFrame, tol: SurfaceTolerance = { lin: 1e-6, ang: 4.5e-5 }): boolean {
    const { lin, ang } = tol;
    if (a.type !== b.type) {
      return false;
    }
    if (Math.abs(a.radius - b.radius) > lin * (1 + Math.abs(a.radius))) {
      return false;
    }
    if (Math.abs(Math.abs(a.extra) - Math.abs(b.extra)) > lin * (1 + Math.abs(a.extra))) {
      return false;
    }
    const d = [b.loc[0] - a.loc[0], b.loc[1] - a.loc[1], b.loc[2] - a.loc[2]];
    if (!a.dir || !b.dir) {
      return Math.hypot(d[0], d[1], d[2]) <= lin;
    }
    // Parallel within `ang`, read off the cross product: a cosine test
    // rounds the small angles a solved sketch leaves away to nothing.
    const sin = Math.hypot(
      a.dir[1] * b.dir[2] - a.dir[2] * b.dir[1],
      a.dir[2] * b.dir[0] - a.dir[0] * b.dir[2],
      a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0],
    );
    if (sin > ang) {
      return false;
    }
    const along = d[0] * a.dir[0] + d[1] * a.dir[1] + d[2] * a.dir[2];
    if (a.type === 'plane') {
      // b's point must lie on a's plane.
      return Math.abs(along) <= lin;
    }
    // b's axis point must lie on a's axis: strip the along-axis component.
    const off = Math.hypot(d[0] - along * a.dir[0], d[1] - along * a.dir[1], d[2] - along * a.dir[2]);
    return off <= lin;
  }

  private static frameOf(type: SurfaceFrame['type'], position: any, radius: number, extra: number): SurfaceFrame {
    const loc = position.Location();
    const dir = position.Direction();
    const xdir = position.XDirection();
    return {
      type,
      direct: position.Direct(),
      loc: [loc.X(), loc.Y(), loc.Z()],
      dir: type === 'sphere' ? undefined : [dir.X(), dir.Y(), dir.Z()],
      xdir: [xdir.X(), xdir.Y(), xdir.Z()],
      radius,
      extra,
    };
  }
}
