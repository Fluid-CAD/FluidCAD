import type { BRepBuilderAPI_Transform, gp_Trsf, TopoDS_Shape } from "ocjs-fluidcad";
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
   * One-shot: a caller that also has to remap sub-shapes of the result
   * keeps a {@link ShapeScaler} open instead.
   */
  static scaleShape(shape: Shape, factor: number): Shape {
    const scaler = new ShapeScaler(factor);
    try {
      return scaler.scale(shape);
    } finally {
      scaler.delete();
    }
  }

  /**
   * Wrap `raw` in the same class as `like` — a scaled solid must stay a
   * Solid (topology index, face cache) rather than whatever the generic
   * factory picks for a compound.
   */
  static wrapLike(like: Shape, raw: TopoDS_Shape): Shape {
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

/**
 * Uniform scaling of scene wrappers that keeps each shape's transform open,
 * so a sub-shape of a source (a face a record names) can be mapped to the
 * sub-shape of the scaled result: a face scaled on its own is a new face,
 * not `IsSame` with any face of the scaled solid, so records that pair a
 * solid with one of its faces (`faceColors`) must go through the solid's
 * own transformer. Memoised per wrapper — asking for a shape twice, or for
 * its sub-shapes after it, reuses the one transform. Owns native memory:
 * `delete()` when the pass is done.
 */
export class ShapeScaler {
  private readonly trsf: gp_Trsf;
  private readonly transformers = new Map<Shape, { scaled: Shape; transformer: BRepBuilderAPI_Transform }>();

  constructor(factor: number) {
    const oc = getOC();
    const origin = new oc.gp_Pnt(0, 0, 0);
    this.trsf = new oc.gp_Trsf();
    this.trsf.SetScale(origin, factor);
    origin.delete();
  }

  /** The scaled copy of `shape` — the same wrapper for the same input, as long as the scaler lives. */
  scale(shape: Shape): Shape {
    return this.entryFor(shape).scaled;
  }

  /**
   * The sub-shape of `scale(source)` that `raw` (a sub-shape of `source`)
   * became. Scales `source` first when it has not been asked for yet.
   */
  remapSub(source: Shape, raw: TopoDS_Shape): TopoDS_Shape {
    return this.entryFor(source).transformer.ModifiedShape(raw);
  }

  private entryFor(shape: Shape): { scaled: Shape; transformer: BRepBuilderAPI_Transform } {
    const existing = this.transformers.get(shape);
    if (existing) {
      return existing;
    }
    const oc = getOC();
    const transformer = new oc.BRepBuilderAPI_Transform(this.trsf);
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

    const entry = { scaled, transformer };
    this.transformers.set(shape, entry);
    return entry;
  }

  delete(): void {
    for (const { transformer } of this.transformers.values()) {
      transformer.delete();
    }
    this.transformers.clear();
    this.trsf.delete();
  }
}
