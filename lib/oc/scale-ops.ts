import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Vertex } from "../common/vertex.js";
import { ShapeFactory } from "../common/shape-factory.js";

/**
 * Uniform scaling about the origin — the one transform a unit change is.
 * Shared by file import/export (mm cache ↔ document unit) and by the
 * foreign-part pass that scales a part built in its own unit into the
 * consuming scene's unit.
 */
export class ScaleOps {
  /** Uniformly scales a raw shape about the origin; the input is left untouched. */
  static scaleShapeRaw(shape: TopoDS_Shape, factor: number): TopoDS_Shape {
    const oc = getOC();
    const origin = new oc.gp_Pnt(0, 0, 0);
    const trsf = new oc.gp_Trsf();
    trsf.SetScale(origin, factor);
    // copy = true: a scale is not an isometry, so OCCT would refuse to
    // express it as a location anyway; asking for the copy is explicit.
    const transformer = new oc.BRepBuilderAPI_Transform(shape, trsf, true, false);
    const result = transformer.Shape();
    transformer.delete();
    trsf.delete();
    origin.delete();
    return result;
  }

  /**
   * Uniformly scales `solids` about the origin by `factor`, carrying each
   * per-face colour over to the face the transform produced. Returns the
   * input untouched when the factor is 1 so an mm document loading an mm
   * asset stays bit-identical to an unscaled load.
   */
  static scaleSolids(solids: Solid[], factor: number): Solid[] {
    if (factor === 1) {
      return solids;
    }
    return solids.map(solid => ScaleOps.scaleShape(solid, factor) as Solid);
  }

  /**
   * A scaled copy of a scene shape wrapper: same wrapper class, colours
   * re-mapped through the transform, meta/guide/role flags carried over.
   * `metaData` is copied by reference — callers that know its payload
   * (e.g. a pick point) scale it themselves. The input is left untouched.
   */
  static scaleShape(shape: Shape, factor: number): Shape {
    const oc = getOC();
    const origin = new oc.gp_Pnt(0, 0, 0);
    const trsf = new oc.gp_Trsf();
    trsf.SetScale(origin, factor);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(shape.getShape(), true);

    const scaled = ScaleOps.wrapLike(shape, transformer.Shape());
    for (const entry of shape.colorMap) {
      scaled.setColor(transformer.ModifiedShape(entry.shape), entry.color);
    }
    if (shape.isMetaShape()) {
      scaled.markAsMetaShape(shape.metaType);
    }
    if (shape.isGuideShape()) {
      scaled.markAsGuide();
    }
    if (shape.noSimplify()) {
      scaled.markNoSimplify();
    }
    scaled.copyRoleFrom(shape);
    scaled.metaData = shape.metaData;

    transformer.delete();
    trsf.delete();
    origin.delete();
    return scaled;
  }

  /**
   * Wrap `raw` in the same class as `like` — a scaled solid must stay a
   * Solid (topology index, face cache) rather than whatever the generic
   * factory picks for a compound.
   */
  private static wrapLike(like: Shape, raw: TopoDS_Shape): Shape {
    if (like instanceof Solid) {
      return Solid.fromTopoDSSolid(Explorer.toSolid(raw));
    }
    if (like instanceof Face) {
      return Face.fromTopoDSFace(Explorer.toFace(raw));
    }
    if (like instanceof Wire) {
      return Wire.fromTopoDSWire(Explorer.toWire(raw));
    }
    if (like instanceof Edge) {
      return Edge.fromTopoDSEdge(Explorer.toEdge(raw));
    }
    if (like instanceof Vertex) {
      return Vertex.fromTopoDSVertex(Explorer.toVertex(raw));
    }
    return ShapeFactory.fromShape(raw);
  }
}
