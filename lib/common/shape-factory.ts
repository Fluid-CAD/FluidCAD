import type { TopoDS_Shape } from "ocjs-fluidcad";
import { Explorer } from "../oc/explorer.js";
import { Solid } from "./solid.js";
import { Wire } from "./wire.js";
import { Face } from "./face.js";
import { Edge } from "./edge.js";
import { Vertex } from "./vertex.js";

export class ShapeFactory {
  /**
   * Wrap a raw handle the caller owns and will not touch again (a maker's
   * `Shape()`, an explorer copy): the wrapper takes its own typed copy, so
   * the input is freed here instead of pinning the TShape a second time.
   */
  static adopt(shape: TopoDS_Shape) {
    try {
      return ShapeFactory.fromShape(shape);
    } finally {
      shape.delete();
    }
  }

  static fromShape(shape: TopoDS_Shape) {
    if (Explorer.isSolid(shape)) {
      return Solid.fromTopoDSSolid(Explorer.toSolid(shape));
    }

    if (Explorer.isWire(shape)) {
      return Wire.fromTopoDSWire(Explorer.toWire(shape));
    }

    if (Explorer.isFace(shape)) {
      return Face.fromTopoDSFace(Explorer.toFace(shape));
    }

    if (Explorer.isEdge(shape)) {
      return Edge.fromTopoDSEdge(Explorer.toEdge(shape));
    }

    if (Explorer.isVertex(shape)) {
      return Vertex.fromTopoDSVertex(Explorer.toVertex(shape));
    }

    if (Explorer.isCompound(shape) || Explorer.isCompoundSolid(shape)) {
      const solids = Explorer.findShapes(shape, Explorer.getOcShapeType("solid"));
      try {
        if (solids.length >= 1) {
          return Solid.fromTopoDSSolid(Explorer.toSolid(solids[0]));
        }
      } finally {
        for (const s of solids) s.delete();
      }
    }

    throw new Error("Unknown shape type");
  }
}
