import type { TopoDS_Shape } from "occjs-wrapper";
import { Explorer } from "../oc/explorer.js";
import { Solid } from "./solid.js";
import { Wire } from "./wire.js";
import { Face } from "./face.js";
import { Edge } from "./edge.js";

export class ShapeFactory {
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

    if (Explorer.isCompound(shape) || Explorer.isCompoundSolid(shape)) {
      const solids = Explorer.findShapes(shape, Explorer.getOcShapeType("solid"));
      if (solids.length === 1) {
        return Solid.fromTopoDSSolid(Explorer.toSolid(solids[0]));
      }
      if (solids.length > 1) {
        return Solid.fromTopoDSSolid(Explorer.toSolid(solids[0]));
      }
    }

    throw new Error("Unknown shape type");
  }
}
