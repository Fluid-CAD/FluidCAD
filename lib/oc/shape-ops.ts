import type {
  TopTools_ListOfShape,
  TopAbs_ShapeEnum,
  TopoDS_Shape,
} from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shape.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "./explorer.js";
import { BoundingBox } from "../helpers/types.js";

/**
 * A cleanShape result that preserves UnifySameDomain lineage so callers can
 * chain pre-clean → post-clean face/edge remapping. `remapFace(pf)` returns
 * the post-clean face(s) corresponding to a pre-clean face, or `null` if the
 * cleanup didn't process it. Caller must invoke `dispose()` exactly once.
 *
 * When the post-clean shape fails validation and ShapeFix_Shape has to run,
 * the UnifySameDomain history is discarded (ShapeFix_Shape creates more new
 * TShapes without recording lineage). In that case remap returns `[face]`
 * for any face the cleanup saw, which is best-effort.
 */
export type CleanShapeLineage = {
  shape: Shape;
  remapFace: (face: Face) => Face[] | null;
  remapEdge: (edge: Edge) => Edge[] | null;
  dispose: () => void;
};

export class ShapeOps {
  static transform(shape: Shape, matrix: Matrix4): Shape {
    const oc = getOC();
    const [trsf, disposeTrsf] = Convert.toGpTrsf(matrix);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(shape.getShape(), true);
    const raw = transformer.Shape();
    const transformed = ShapeFactory.fromShape(raw);

    if (shape.hasColors()) {
      const sourceFaces = shape.getSubShapes("face");

      for (const sourceFace of sourceFaces) {
        const faceColor = shape.getColor(sourceFace.getShape());
        if (faceColor) {
          const modifiedFace = transformer.ModifiedShape(sourceFace.getShape());
          transformed.setColor(modifiedFace, faceColor);
        }
      }
    }

    if (shape.isMetaShape()) {
      transformed.markAsMetaShape(shape.metaType);
    }

    if (shape.isGuideShape()) {
      transformed.markAsGuide();
    }

    transformer.delete();
    disposeTrsf();

    return transformed;
  }

  static getBoundingBox(shape: Shape | TopoDS_Shape): BoundingBox {
    const raw = shape instanceof Shape ? shape.getShape() : shape;
    return ShapeOps.getBoundingBoxRaw(raw);
  }

  static getBoundingBoxRaw(shape: TopoDS_Shape): BoundingBox {
    const oc = getOC();
    const bbox = new oc.Bnd_Box();
    oc.BRepBndLib.Add(shape, bbox, true);

    const minPnt = bbox.CornerMin();
    const maxPnt = bbox.CornerMax();

    bbox.delete();

    return {
      minX: minPnt.X(),
      minY: minPnt.Y(),
      minZ: minPnt.Z(),
      maxX: maxPnt.X(),
      maxY: maxPnt.Y(),
      maxZ: maxPnt.Z(),
      centerX: (minPnt.X() + maxPnt.X()) / 2,
      centerY: (minPnt.Y() + maxPnt.Y()) / 2,
      centerZ: (minPnt.Z() + maxPnt.Z()) / 2,
    };
  }

  static makeCompound(shapes: Shape[]): Shape {
    const raw = ShapeOps.makeCompoundRaw(shapes.map(s => s.getShape()));
    return ShapeFactory.fromShape(raw);
  }

  static makeCompoundRaw(shapes: TopoDS_Shape[]) {
    const oc = getOC();
    const compoundBuilder = new oc.BRep_Builder();
    const compound = new oc.TopoDS_Compound();
    compoundBuilder.MakeCompound(compound);

    for (const shape of shapes) {
      compoundBuilder.Add(compound, shape);
    }

    return compound;
  }

  static cleanShape(shape: Shape): Shape {
    return ShapeFactory.fromShape(ShapeOps.cleanShapeRaw(shape.getShape()));
  }

  /**
   * Variant of `cleanShape` that preserves UnifySameDomain lineage via
   * `BRepTools_History`. Caller must call `dispose()` exactly once to free
   * the OC wrappers.
   */
  static cleanShapeWithLineage(shape: Shape): CleanShapeLineage {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

    const unify = new oc.ShapeUpgrade_UnifySameDomain(shape.getShape(), false, true, false);
    unify.Build();
    const cleanedRaw = unify.Shape();

    // Pre-compute which faces/edges this cleanup saw so the remap can
    // distinguish "didn't know about this shape" (return null) from
    // "saw but didn't modify" (return [original]).
    const knownFaces = new oc.TopTools_MapOfShape();
    const knownEdges = new oc.TopTools_MapOfShape();
    for (const raw of Explorer.findShapes(shape.getShape(), FACE)) {
      knownFaces.Add(raw);
    }
    for (const raw of Explorer.findShapes(shape.getShape(), EDGE)) {
      knownEdges.Add(raw);
    }

    const checker = new oc.BRepCheck_Analyzer(cleanedRaw, true, true);
    const valid = checker.IsValid();
    checker.delete();

    if (!valid) {
      // ShapeFix_Shape creates new TShapes without recording history.
      // Lineage is lost here — remap returns [face] best-effort for
      // faces the cleanup saw, null otherwise.
      unify.delete();
      const fixer = new oc.ShapeFix_Shape(cleanedRaw);
      const progress = new oc.Message_ProgressRange();
      fixer.Perform(progress);
      const fixed = fixer.Shape();
      fixer.delete();
      progress.delete();

      const wrapped = ShapeFactory.fromShape(fixed);
      let disposed = false;
      const dispose = () => {
        if (disposed) {
          return;
        }
        disposed = true;
        knownFaces.delete();
        knownEdges.delete();
      };
      return {
        shape: wrapped,
        remapFace: (face) => (knownFaces.Contains(face.getShape()) ? [face] : null),
        remapEdge: (edge) => (knownEdges.Contains(edge.getShape()) ? [edge] : null),
        dispose,
      };
    }

    const historyHandle = unify.History();
    const history = historyHandle.get();

    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      historyHandle.delete();
      unify.delete();
      knownFaces.delete();
      knownEdges.delete();
    };

    return {
      shape: ShapeFactory.fromShape(cleanedRaw),
      remapFace: (face) => {
        const raw = face.getShape();
        if (!knownFaces.Contains(raw)) {
          return null;
        }
        if (history.IsRemoved(raw)) {
          return [];
        }
        const list = ShapeOps.shapeListToArray(history.Modified(raw))
          .filter(s => s.ShapeType() === FACE);
        if (list.length === 0) {
          return [face];
        }
        return list.map(r => Face.fromTopoDSFace(Explorer.toFace(r)));
      },
      remapEdge: (edge) => {
        const raw = edge.getShape();
        if (!knownEdges.Contains(raw)) {
          return null;
        }
        if (history.IsRemoved(raw)) {
          return [];
        }
        const list = ShapeOps.shapeListToArray(history.Modified(raw))
          .filter(s => s.ShapeType() === EDGE);
        if (list.length === 0) {
          return [edge];
        }
        return list.map(r => Edge.fromTopoDSEdge(Explorer.toEdge(r)));
      },
      dispose,
    };
  }

  static cleanShapeRaw(shape: TopoDS_Shape) {
    const oc = getOC();

    // Full unification: merge redundant edges AND co-surface faces.
    // UnifySameDomain can throw on shapes with subtle topology issues
    // (e.g. boolean output from a profile with reversed face normal).
    // Fall back to the input shape on failure rather than aborting.
    let cleaned: TopoDS_Shape;
    try {
      const unify = new oc.ShapeUpgrade_UnifySameDomain(shape, false, true, false);
      unify.Build();
      cleaned = unify.Shape();
      unify.delete();
    } catch {
      return shape;
    }

    // Validate — UnifySameDomain can corrupt periodic surfaces (e.g. cylinders)
    const checker = new oc.BRepCheck_Analyzer(cleaned, true, true);
    if (checker.IsValid()) {
      checker.delete();
      return cleaned;
    }
    checker.delete();

    // Repair with ShapeFix_Shape (fixes seam edges, wire orientation, SameParameter)
    try {
      const fixer = new oc.ShapeFix_Shape(cleaned);
      const progress = new oc.Message_ProgressRange();
      fixer.Perform(progress);
      const fixed = fixer.Shape();
      fixer.delete();
      progress.delete();
      return fixed;
    } catch {
      return cleaned;
    }
  }

  static shapeListToArray(list: TopTools_ListOfShape) {
    let res: TopoDS_Shape[] = [];
    while (list.Size() > 0) {
      res.push(list.First());
      list.RemoveFirst();
    }
    list.delete();
    return res;
  }
}
