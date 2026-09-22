import type {
  Bnd_Box,
  TopTools_ListOfShape,
  TopAbs_ShapeEnum,
  TopoDS_Shape,
} from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Shape } from "../common/shape.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "./explorer.js";
import { OrientedFaces } from "./oriented-faces.js";
import { VertexOps } from "./vertex-ops.js";
import { BoundingBox } from "../helpers/types.js";
import { mmTol } from "../units/tolerance.js";
import { DirectFaces } from "./direct-faces.js";

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

    transformed.copyRoleFrom(shape);

    transformer.delete();
    disposeTrsf();

    return transformed;
  }

  static getBoundingBox(shape: Shape | TopoDS_Shape): BoundingBox {
    const raw = shape instanceof Shape ? shape.getShape() : shape;
    return ShapeOps.getBoundingBoxRaw(raw);
  }

  // Sizing box: BRepBndLib.Add reads the stored triangulation when the
  // shape has one and pads the box by that mesh's deflection, so the same
  // shape answers a bigger box after it has been rendered than before.
  // Fine for "big enough" callers (tool lengths, camera fits, mesh size
  // buckets). Anything that treats the box as geometry — a clipping slab,
  // a cap that must sit flush with the model's outer wall — must use
  // `getExactBoundingBox`, or its result depends on render state.
  static getBoundingBoxRaw(shape: TopoDS_Shape): BoundingBox {
    const oc = getOC();
    const bbox = new oc.Bnd_Box();
    oc.BRepBndLib.Add(shape, bbox, true);
    const out = ShapeOps.boundingBoxFromBnd(bbox);
    bbox.delete();
    return out;
  }

  // Exact bounds of the shape's geometry: triangulation is ignored and no
  // tolerance gap is added, so a planar face at y = -25 bounds at exactly
  // -25 whether or not the shape has been meshed. Use this wherever the box
  // becomes geometry (see `getBoundingBoxRaw`).
  static getExactBoundingBox(shape: Shape | TopoDS_Shape): BoundingBox {
    const raw = shape instanceof Shape ? shape.getShape() : shape;
    return ShapeOps.getExactBoundingBoxRaw(raw);
  }

  static getExactBoundingBoxRaw(shape: TopoDS_Shape): BoundingBox {
    const oc = getOC();
    const bbox = new oc.Bnd_Box();
    oc.BRepBndLib.AddOptimal(shape, bbox, false, false);
    if (bbox.IsVoid()) {
      bbox.delete();
      throw new Error("Cannot bound a shape with no geometry");
    }
    const out = ShapeOps.boundingBoxFromBnd(bbox);
    bbox.delete();
    return out;
  }

  // The smallest box enclosing every box given. Throws on an empty list —
  // there is no meaningful "empty" bounding box.
  static unionBoundingBoxes(boxes: BoundingBox[]): BoundingBox {
    if (boxes.length === 0) {
      throw new Error("Cannot union an empty list of bounding boxes");
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); minZ = Math.min(minZ, b.minZ);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY); maxZ = Math.max(maxZ, b.maxZ);
    }
    return ShapeOps.boundingBoxFromExtents(minX, minY, minZ, maxX, maxY, maxZ);
  }

  // The eight corners of a bounding box, for extent-along-a-direction tests.
  static boundingBoxCorners(bb: BoundingBox): Point[] {
    return [
      new Point(bb.minX, bb.minY, bb.minZ),
      new Point(bb.maxX, bb.minY, bb.minZ),
      new Point(bb.minX, bb.maxY, bb.minZ),
      new Point(bb.maxX, bb.maxY, bb.minZ),
      new Point(bb.minX, bb.minY, bb.maxZ),
      new Point(bb.maxX, bb.minY, bb.maxZ),
      new Point(bb.minX, bb.maxY, bb.maxZ),
      new Point(bb.maxX, bb.maxY, bb.maxZ),
    ];
  }

  private static boundingBoxFromBnd(bbox: Bnd_Box): BoundingBox {
    const minPnt = bbox.CornerMin();
    const maxPnt = bbox.CornerMax();
    return ShapeOps.boundingBoxFromExtents(
      minPnt.X(), minPnt.Y(), minPnt.Z(),
      maxPnt.X(), maxPnt.Y(), maxPnt.Z(),
    );
  }

  private static boundingBoxFromExtents(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): BoundingBox {
    return {
      minX, minY, minZ, maxX, maxY, maxZ,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      centerZ: (minZ + maxZ) / 2,
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
   *
   * `unifyEdges` additionally merges same-domain edge chains — the residue a
   * face merge leaves behind: when this cleanup (or an earlier one) unifies
   * two faces, the edges that used to separate structure along their shared
   * boundary keep their split vertices even though both sides of every piece
   * now bound the same face pair (e.g. a saddle contact arc split by a fillet
   * foot whose blend face later merged away). UnifySameDomain only merges
   * edges that are same-curve AND share the same face pair, so deliberate
   * splits that still separate real structure (a breakpoint's cap edges next
   * to their side edge) are untouched. Opt-in because callers that match
   * result faces by IsSame instead of through this lineage would see more
   * rebuilt faces.
   */
  static cleanShapeWithLineage(
    shape: Shape,
    opts?: { skipSimplify?: boolean; unifyEdges?: boolean },
  ): CleanShapeLineage {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

    // Two coincident cylinders of opposite handedness corrupt the face merge:
    // rebuild the left-handed ones first, and route every remap through the
    // rebuild so callers' pre-clean faces still resolve — see DirectFaces.
    const inputRaw = shape.getShape();
    const direct = DirectFaces.hasMixedHandedness(inputRaw) ? DirectFaces.applyRaw(inputRaw) : null;
    const through = (raw: TopoDS_Shape): TopoDS_Shape | null => (direct ? direct.modifiedOrNull(raw) : raw);
    if (direct) {
      shape = ShapeFactory.fromShape(direct.shape);
    }

    // skipSimplify: pass unifyFaces=false to avoid the slow face-merging step
    // that hangs on tangent contact along curves (e.g., helix sweep + cylinder).
    // It also disables edge unification — delicate tangent geometry opted out
    // of merging entirely.
    const unify = new oc.ShapeUpgrade_UnifySameDomain(
      shape.getShape(),
      opts?.skipSimplify ? false : (opts?.unifyEdges ?? false),
      opts?.skipSimplify ? false : true,
      false,
    );
    unify.Build();
    const cleanedRaw = unify.Shape();

    // Pre-compute which faces/edges this cleanup saw so the remap can
    // distinguish "didn't know about this shape" (return null) from
    // "saw but didn't modify" (return [original]).
    const knownFaces = new oc.TopTools_MapOfShape();
    const knownEdges = new oc.TopTools_MapOfShape();
    for (const raw of Explorer.findShapes(inputRaw, FACE)) {
      knownFaces.Add(raw);
    }
    for (const raw of Explorer.findShapes(inputRaw, EDGE)) {
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
      const fixedFaces = new OrientedFaces(fixed);
      let disposed = false;
      const dispose = () => {
        if (disposed) {
          return;
        }
        disposed = true;
        fixedFaces.delete();
        knownFaces.delete();
        knownEdges.delete();
        direct?.dispose();
      };
      return {
        shape: wrapped,
        remapFace: (face) => {
          const raw = through(face.getShape());
          return raw && knownFaces.Contains(face.getShape())
            ? [Face.fromTopoDSFace(Explorer.toFace(fixedFaces.orient(raw)))]
            : null;
        },
        remapEdge: (edge) => {
          const raw = through(edge.getShape());
          return raw && knownEdges.Contains(edge.getShape())
            ? [raw.IsSame(edge.getShape()) ? edge : Edge.fromTopoDSEdge(Explorer.toEdge(raw))]
            : null;
        },
        dispose,
      };
    }

    const history = unify.History();
    // Unify's history images carry no in-result orientation — every face it
    // hands back is canonicalized to its instance in the cleaned shape.
    const cleanedFaces = new OrientedFaces(cleanedRaw);

    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      cleanedFaces.delete();
      history.delete();
      unify.delete();
      knownFaces.delete();
      knownEdges.delete();
      direct?.dispose();
    };

    return {
      shape: ShapeFactory.fromShape(cleanedRaw),
      remapFace: (face) => {
        if (!knownFaces.Contains(face.getShape())) {
          return null;
        }
        const raw = through(face.getShape());
        if (!raw) {
          return null;
        }
        if (history.IsRemoved(raw)) {
          return [];
        }
        const list = ShapeOps.shapeListToArray(history.Modified(raw))
          .filter(s => s.ShapeType() === FACE);
        const images = list.length === 0 ? [raw] : list;
        return images.map(r => Face.fromTopoDSFace(Explorer.toFace(cleanedFaces.orient(r))));
      },
      remapEdge: (edge) => {
        if (!knownEdges.Contains(edge.getShape())) {
          return null;
        }
        const raw = through(edge.getShape());
        if (!raw) {
          return null;
        }
        if (history.IsRemoved(raw)) {
          return [];
        }
        const list = ShapeOps.shapeListToArray(history.Modified(raw))
          .filter(s => s.ShapeType() === EDGE);
        if (list.length === 0) {
          return [raw.IsSame(edge.getShape()) ? edge : Edge.fromTopoDSEdge(Explorer.toEdge(raw))];
        }
        return list.map(r => Edge.fromTopoDSEdge(Explorer.toEdge(r)));
      },
      dispose,
    };
  }

  /**
   * Merge the colinear edge pairs a two-half extrude (symmetric / two-distance)
   * leaves along its mid-plane seam after the halves are fused. The fuse's
   * `SimplifyResult` already unifies the lateral faces but runs with edge
   * unification off, so every lateral edge stays split in two at the seam
   * vertex.
   *
   * A global edge-unify would also merge colinear PROFILE edges (breakpoint
   * splits, chained segments) — rebuilding the cap faces and breaking the
   * IsSame identity the start/end-face remapping and edge classification rely
   * on. So merging is physically restricted to the seam: UnifySameDomain runs
   * with edge unification only, and every vertex OFF `plane` is registered via
   * `KeepShape`, which forbids merging its edges. The only merge candidates
   * left are the seam vertices on the sketch plane.
   *
   * Shapes with no on-plane vertex are returned as-is, as is any shape whose
   * unified result fails validation (UnifySameDomain can corrupt periodic
   * surfaces) — this pass never makes a shape worse.
   */
  static unifySeamEdges(shapes: Shape[], plane: Plane | null): Shape[] {
    if (!plane) {
      return shapes;
    }
    return shapes.map(s => ShapeOps.unifySeamEdgesOne(s, plane));
  }

  private static unifySeamEdgesOne(shape: Shape, plane: Plane): Shape {
    const oc = getOC();
    const VERTEX = oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum;
    // Seam vertices are exact copies of the profile vertices on the sketch
    // plane; the tolerance only needs to absorb numeric drift.
    const tolerance = mmTol(1e-6);

    const raw = shape.getShape();
    const keptVertices: TopoDS_Shape[] = [];
    let seamVertexCount = 0;
    for (const v of Explorer.findShapes(raw, VERTEX)) {
      const point = VertexOps.toPointRaw(Explorer.toVertex(v));
      if (Math.abs(plane.signedDistanceToPoint(point)) < tolerance) {
        seamVertexCount++;
      } else {
        keptVertices.push(v);
      }
    }

    if (seamVertexCount === 0) {
      return shape;
    }

    try {
      const unify = new oc.ShapeUpgrade_UnifySameDomain(raw, true, false, false);
      // Safe input mode (the default) copies rebuilt regions so the input
      // stays untouched — but that replaces the TShapes of faces the merge
      // never touched, breaking the caller's IsSame cap re-find. The input
      // here is a just-fused intermediate owned by the caller, so in-place
      // is fine and keeps untouched faces identical.
      unify.SetSafeInputMode(false);
      for (const v of keptVertices) {
        unify.KeepShape(v);
      }
      unify.Build();
      const unified = unify.Shape();
      unify.delete();

      const checker = new oc.BRepCheck_Analyzer(unified, true, true);
      const valid = checker.IsValid();
      checker.delete();
      if (!valid) {
        return shape;
      }
      return ShapeFactory.fromShape(unified);
    } catch {
      return shape;
    }
  }

  static cleanShapeRaw(shape: TopoDS_Shape) {
    const oc = getOC();

    // Two coincident cylinders of opposite handedness corrupt the face merge:
    // rebuild the left-handed ones first — see DirectFaces.
    if (DirectFaces.hasMixedHandedness(shape)) {
      shape = DirectFaces.normalizeRaw(shape);
    }

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

  /**
   * The face `face` became after a boolean `op`, oriented as it sits in
   * `result` (a maker's images carry no in-result orientation). A face the
   * op left untouched is returned as is.
   */
  static trackFace(op: { Modified(shape: TopoDS_Shape): TopTools_ListOfShape }, face: TopoDS_Shape, result: TopoDS_Shape): TopoDS_Shape {
    const modified = ShapeOps.shapeListToArray(op.Modified(face));
    if (modified.length === 0) {
      return face;
    }
    const oriented = new OrientedFaces(result);
    try {
      return oriented.orient(modified[0]);
    } finally {
      oriented.delete();
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
