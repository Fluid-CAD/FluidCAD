import type { TopAbs_ShapeEnum, TopoDS_Face } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { ExtrudeOps } from "../../oc/extrude-ops.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { Sheet } from "../../common/sheet.js";
import { Solid } from "../../common/solid.js";
import { Wire } from "../../common/wire.js";
import { Vector3d } from "../../math/vector3d.js";

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
