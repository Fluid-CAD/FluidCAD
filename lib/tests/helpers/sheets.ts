import type { Geom_Surface, TopAbs_ShapeEnum, TopoDS_Face } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { ExtrudeOps } from "../../oc/extrude-ops.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { Sheet } from "../../common/sheet.js";
import { Solid } from "../../common/solid.js";
import { Wire } from "../../common/wire.js";
import { Vector3d } from "../../math/vector3d.js";
import { TestCurves } from "./curves.js";

/**
 * Surfaces built straight from the kernel, for tests that need a sheet
 * before any feature can make one. Each call returns a new `Sheet` the test
 * owns and must dispose; every intermediate kernel object is freed here.
 */
export const TestSheets = {
  /** One planar face, `w` × `h`, on the XY plane from the origin. */
  plate(w: number, h: number): Sheet {
    const oc = getOC();
    const plane = new oc.gp_Pln();
    const maker = new oc.BRepBuilderAPI_MakeFace(plane, 0, w, 0, h);
    const face = maker.Face();
    try {
      return SheetOps.fromRawFace(face);
    } finally {
      face.delete();
      maker.delete();
      plane.delete();
    }
  },

  /**
   * One Bezier face over `[-half, half]²` at height `z`, a parabola across
   * x: `sag` above `z` along its two x ends and level with it down the
   * middle, so the plane nearest to it lies `sag / 2` from it. With a `sag`
   * of 6e-4 it is flat for a filter (within 1e-3 mm) and not flat enough to
   * build on (1e-4 mm).
   */
  shallowPatch(half: number, sag: number, z = 0): Sheet {
    const oc = getOC();
    const poles = new oc.NCollection_Array2_gp_Pnt(1, 3, 1, 2);
    const xs = [-half, 0, half];
    const zs = [z + sag, z - sag, z + sag];
    for (let i = 0; i < 3; i++) {
      for (const [j, y] of [-half, half].entries()) {
        const point = new oc.gp_Pnt(xs[i], y, zs[i]);
        poles.SetValue(i + 1, j + 1, point);
        point.delete();
      }
    }
    const surface = new oc.Geom_BezierSurface(poles);
    const maker = new oc.BRepBuilderAPI_MakeFace(surface as unknown as Geom_Surface, 1e-6);
    const face = maker.Face();
    try {
      return SheetOps.fromRawFace(face);
    } finally {
      face.delete();
      maker.delete();
      surface.delete();
      poles.delete();
    }
  },

  /**
   * An open polyline on the XY plane extruded `height` along +Z: one planar
   * face per segment, neighbours sharing their vertical edge.
   */
  strip(points: [number, number][], height: number): Sheet {
    const oc = getOC();
    const polygon = new oc.BRepBuilderAPI_MakePolygon();
    for (const [x, y] of points) {
      const point = new oc.gp_Pnt(x, y, 0);
      polygon.Add(point);
      point.delete();
    }
    const wire = Wire.fromTopoDSWire(polygon.Wire());
    polygon.delete();
    try {
      const swept = ExtrudeOps.makePrism(wire, new Vector3d(0, 0, 1), height);
      if (!(swept instanceof Sheet)) {
        const type = swept.getType();
        swept.dispose();
        throw new Error(`TestSheets.strip: the prism of a polyline came back as a ${type}`);
      }
      return swept;
    } finally {
      wire.dispose();
    }
  },

  /**
   * A straight run of 10 into a quarter-turn arc of radius 10, extruded
   * `height` along +Z: two faces meeting tangentially along one vertical
   * edge.
   */
  tangentStrip(height: number): Sheet {
    const wire = TestCurves.lineIntoArc();
    try {
      const swept = ExtrudeOps.makePrism(wire, new Vector3d(0, 0, 1), height);
      if (!(swept instanceof Sheet)) {
        const type = swept.getType();
        swept.dispose();
        throw new Error(`TestSheets.tangentStrip: the prism of an open profile came back as a ${type}`);
      }
      return swept;
    } finally {
      wire.dispose();
    }
  },

  /** A box's shell with its top face left out: five faces and one rectangular rim. */
  openBox(x: number, y: number, z: number): Sheet {
    const box = boxSolid(x, y, z);
    try {
      const walls = box.getFaces().filter(face => Math.abs(face.center().z - z) > 1e-9);
      const [sheet, ...rest] = SheetOps.fromFaces(walls);
      for (const extra of rest) extra.dispose();
      return sheet;
    } finally {
      box.dispose();
    }
  },

  /** Half a cylinder wall of radius `r` around Z, `length` tall: one curved face, no seam. */
  halfPipe(r: number, length: number): Sheet {
    return cylinderWall(r, length, Math.PI);
  },

  /** A box's full shell — closed, but a surface, not a solid. */
  closedBox(x: number, y: number, z: number): Sheet {
    const oc = getOC();
    const box = boxSolid(x, y, z);
    try {
      const [shell] = Explorer.findShapes(box.getShape(), oc.TopAbs_ShapeEnum.TopAbs_SHELL as TopAbs_ShapeEnum);
      try {
        return Sheet.fromTopoDSShell(Explorer.toShell(shell));
      } finally {
        shell.delete();
      }
    } finally {
      box.dispose();
    }
  },
};

/**
 * A cylinder wall of radius `r` around Z, `length` tall, through `sweep`
 * radians, as a one-face sheet the caller owns. A full turn carries a seam.
 */
export function cylinderWall(r: number, length: number, sweep: number): Sheet {
  const oc = getOC();
  const axes = new oc.gp_Ax3();
  const cylinder = new oc.gp_Cylinder(axes, r);
  const maker = new oc.BRepBuilderAPI_MakeFace(cylinder, 0, sweep, 0, length);
  const face: TopoDS_Face = maker.Face();
  try {
    return SheetOps.fromRawFace(face);
  } finally {
    face.delete();
    maker.delete();
    cylinder.delete();
    axes.delete();
  }
}

function boxSolid(x: number, y: number, z: number): Solid {
  const oc = getOC();
  const maker = new oc.BRepPrimAPI_MakeBox(x, y, z);
  try {
    return ShapeFactory.adopt(maker.Shape()) as Solid;
  } finally {
    maker.delete();
  }
}
