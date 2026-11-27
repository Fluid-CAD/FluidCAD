import type { TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { BuildSceneObjectContext } from "../../common/scene-object.js";
import { Sheet } from "../../common/sheet.js";
import { SurfaceObject } from "../../features/surface-object.js";
import { addToScene } from "../setup.js";

/**
 * A surface tool whose build returns the sheets the test makes: it records
 * the `faces` and `boundaryEdges` buckets as every surface tool does, so the
 * topology filters can be tried in `select()` and in bucket accessors alike.
 */
class TestSurface extends SurfaceObject {
  constructor(private readonly make: () => Sheet[]) {
    super();
  }

  protected buildSheets(_context: BuildSceneObjectContext): Sheet[] {
    return this.make();
  }

  override getType(): string {
    return 'test-surface';
  }

  serialize() {
    return {};
  }
}

/** Adds a surface tool holding `make()`'s sheets to the current scene. */
export function surface(make: () => Sheet[]): SurfaceObject {
  const result = new TestSurface(make);
  addToScene(result);
  return result;
}

/** Sheets with more than one rim loop, built straight from the kernel; each call returns a sheet the caller owns. */
export const TopologySheets = {
  /**
   * A `size` × `size` planar face on XY centred on the origin, pierced by a
   * centred square hole of side `hole`: one face, two rim loops of four
   * edges each.
   */
  plateWithSquareHole(size: number, hole: number): Sheet {
    const oc = getOC();
    const outer = polygon([[-size / 2, -size / 2], [size / 2, -size / 2], [size / 2, size / 2], [-size / 2, size / 2]]);
    // Clockwise, as a hole runs against its face's outer loop.
    const inner = polygon([[-hole / 2, -hole / 2], [-hole / 2, hole / 2], [hole / 2, hole / 2], [hole / 2, -hole / 2]]);
    const maker = new oc.BRepBuilderAPI_MakeFace(outer, true);
    try {
      maker.Add(inner);
      const face = maker.Face();
      try {
        return SheetOps.fromRawFace(face);
      } finally {
        face.delete();
      }
    } finally {
      maker.delete();
      outer.delete();
      inner.delete();
    }
  },
};

/** A closed polygon on XY through `points`. */
function polygon(points: [number, number][]): TopoDS_Wire {
  const oc = getOC();
  const maker = new oc.BRepBuilderAPI_MakePolygon();
  try {
    for (const [x, y] of points) {
      const point = new oc.gp_Pnt(x, y, 0);
      maker.Add(point);
      point.delete();
    }
    maker.Close();
    return maker.Wire();
  } finally {
    maker.delete();
  }
}
