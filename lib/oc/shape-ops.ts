import type {
  Adaptor3d_Surface,
  Bnd_Box,
  BRepBuilderAPI_Transform,
  ShapeUpgrade_UnifySameDomain,
  TopTools_ListOfShape,
  TopAbs_ShapeEnum,
  TopoDS_Shape,
} from "ocjs-fluidcad";
import type { CarriedColor, SourceColors } from "./color-transfer.js";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
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
import { SameDomainMerge } from "./same-domain-merge.js";
import { transformHelixGeometry } from "../math/helix-geometry.js";
import { RenderSeams } from "./render-seams.js";

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
/** The least and greatest signed distance of a shape from a plane; see {@link ShapeOps.extentAlongRaw}. */
export type Extent = { min: number; max: number };

/**
 * What bounds one wrapper, each read once: a wrapper's OC shape never
 * changes while it lives, and selector synthesis asks the same half-space
 * questions of the same candidates many times per pick.
 */
type Bounds = {
  /** The exact world box: its three axes are the shape's spans along x, y and z. */
  world?: BoundingBox;
  /** The shape's exact span along any other direction, from the world origin. */
  spans?: Map<string, Extent>;
  /** See {@link ShapeOps.controlHullRaw}. */
  hull?: BoundingBox | null;
};

const bounds = new WeakMap<Shape, Bounds>();

function boundsOf(shape: Shape): Bounds {
  let kept = bounds.get(shape);
  if (!kept) {
    kept = {};
    bounds.set(shape, kept);
  }
  return kept;
}

export type CleanShapeLineage = {
  shape: Shape;
  remapFace: (face: Face) => Face[] | null;
  remapEdge: (edge: Edge) => Edge[] | null;
  dispose: () => void;
};

export class ShapeOps {
  /** A transformed copy of `shape`: geometry, seams, helix data and flags. Colours are holder records — see {@link transformColored}. */
  static transform(shape: Shape, matrix: Matrix4): Shape {
    return ShapeOps.transformThrough(shape, matrix, () => undefined);
  }

  /**
   * {@link transform}, also answering where each of `subShapes` (faces and
   * edges of `shape`) went: its image in the moved shape, parallel to
   * `subShapes`, or null for one `shape` does not hold.
   */
  static transformTracking<T extends Shape>(shape: Shape, matrix: Matrix4, subShapes: readonly T[]): { shape: Shape; images: (T | null)[] } {
    let images: (T | null)[] = [];
    const moved = ShapeOps.transformThrough(shape, matrix, transformer => {
      if (subShapes.length === 0) {
        return;
      }
      const oc = getOC();
      const held = new oc.TopTools_IndexedMapOfShape();
      try {
        oc.TopExp.MapShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum, held);
        oc.TopExp.MapShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, held);
        images = subShapes.map(sub => held.FindIndex(sub.getShape()) === 0
          ? null
          : ShapeFactory.fromShape(transformer.ModifiedShape(sub.getShape())) as Shape as T);
      } finally {
        held.delete();
      }
    });
    return { shape: moved, images };
  }

  /**
   * A transformed copy of a held solid with its colours carried onto the
   * moved faces, authors kept — what a move, a mirror or a copy records on
   * itself as the new holder.
   */
  static transformColored(source: SourceColors, matrix: Matrix4): { shape: Shape; colors: CarriedColor[] } {
    const colors: CarriedColor[] = [];
    const shape = ShapeOps.transformThrough(source.shape, matrix, (transformer, transformed) => {
      for (const entry of source.colors.entries()) {
        const moved = transformer.ModifiedShape(entry.face.getShape());
        colors.push({
          shape: transformed,
          face: Face.fromTopoDSFace(Explorer.toFace(moved)),
          color: entry.color,
          setBy: entry.setBy,
        });
        moved.delete();
      }
    });
    return { shape, colors };
  }

  private static transformThrough(
    shape: Shape,
    matrix: Matrix4,
    carry: (transformer: BRepBuilderAPI_Transform, transformed: Shape) => void,
  ): Shape {
    const oc = getOC();
    const [trsf, disposeTrsf] = Convert.toGpTrsf(matrix);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(shape.getShape(), true);
    const transformed = ShapeFactory.adopt(transformer.Shape());
    RenderSeams.map(transformed, [shape], edge => [transformer.ModifiedShape(edge)]);

    for (const entry of shape.getHelixEdges()) {
      const geometry = transformHelixGeometry(entry.geometry, matrix);
      if (!geometry) continue;
      const edge = transformer.ModifiedShape(entry.edge);
      try {
        if (!edge.IsNull()) transformed.recordHelixGeometry(edge, geometry);
      } finally {
        edge.delete();
      }
    }

    carry(transformer, transformed);

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

  /**
   * {@link extentAlongRaw}, from what is kept per wrapper and direction:
   * the shape's span along the plane's normal is measured once from the
   * world origin, and any plane with that normal reads its extent off it by
   * subtracting where the plane sits. The three world axes share one box.
   */
  static extentAlong(shape: Shape, plane: Plane): Extent {
    const span = ShapeOps.spanAlong(shape, plane.normal);
    const shift = plane.origin.toVector3d().dot(plane.normal);
    return { min: span.min - shift, max: span.max - shift };
  }

  /**
   * An interval that holds the shape's true extent along `plane`'s normal,
   * read off its control hull (kept per wrapper) at no cost per plane; null
   * for a shape with no such hull (see {@link controlHullRaw}). The exact
   * extent of a face on a B-spline surface costs tens of milliseconds, and
   * a caller that only asks which side of a plane a shape lies on has its
   * answer whenever this interval clears the plane. {@link extentAlong}
   * can read past it by the kernel's padding.
   */
  static outerExtentAlong(shape: Shape, plane: Plane): Extent | null {
    const kept = boundsOf(shape);
    if (kept.hull === undefined) {
      kept.hull = ShapeOps.controlHullRaw(shape.getShape());
    }
    const hull = kept.hull;
    if (!hull) {
      return null;
    }
    // A box's reach along a direction: each axis gives its nearer or farther end.
    const { normal: n, origin } = plane;
    const reach = (pick: (a: number, b: number) => number) =>
      pick(n.x * hull.minX, n.x * hull.maxX) + pick(n.y * hull.minY, n.y * hull.maxY) + pick(n.z * hull.minZ, n.z * hull.maxZ);
    const near = reach(Math.min);
    const far = reach(Math.max);
    const shift = origin.toVector3d().dot(n);
    // These sums and the exact extent's round differently; a few ulps of
    // the largest term keep the interval an outer one.
    const rounding = 8 * Number.EPSILON * Math.max(Math.abs(near), Math.abs(far), Math.abs(shift));
    return { min: near - shift - rounding, max: far - shift + rounding };
  }

  /** The shape's exact span along `direction`: its extent from a plane through the world origin. */
  private static spanAlong(shape: Shape, direction: Vector3d): Extent {
    const kept = boundsOf(shape);
    const { x, y, z } = direction;
    const axis = (y === 0 && z === 0 && Math.abs(x) === 1) ? 'X'
      : (x === 0 && z === 0 && Math.abs(y) === 1) ? 'Y'
      : (x === 0 && y === 0 && Math.abs(z) === 1) ? 'Z'
      : null;
    if (axis) {
      kept.world ??= ShapeOps.getExactBoundingBoxRaw(shape.getShape());
      const min = kept.world[`min${axis}`];
      const max = kept.world[`max${axis}`];
      return x + y + z > 0 ? { min, max } : { min: -max, max: -min };
    }
    kept.spans ??= new Map();
    const key = `${x},${y},${z}`;
    let span = kept.spans.get(key);
    if (!span) {
      span = ShapeOps.extentAlongRaw(shape.getShape(), Plane.fromPointAndNormal(new Point(0, 0, 0), direction));
      kept.spans.set(key, span);
    }
    return span;
  }

  /**
   * How far the shape reaches on either side of `plane`: the least and the
   * greatest signed distance of its geometry from the plane, along the
   * plane's normal. Exact, like {@link getExactBoundingBoxRaw}: the shape is
   * bounded in the plane's own frame, so the box's z extent is the extent
   * along the normal whatever the plane's tilt.
   */
  static extentAlongRaw(shape: TopoDS_Shape, plane: Plane): Extent {
    const oc = getOC();
    const [origin, disposeOrigin] = Convert.toGpPnt(plane.origin);
    const [normal, disposeNormal] = Convert.toGpDir(plane.normal);
    const frame = new oc.gp_Ax3(origin, normal);
    const trsf = new oc.gp_Trsf();
    trsf.SetTransformation(frame);
    const location = new oc.TopLoc_Location(trsf);
    const local = shape.Moved(location, false);
    const bbox = new oc.Bnd_Box();
    try {
      oc.BRepBndLib.AddOptimal(local, bbox, false, false);
      if (bbox.IsVoid()) {
        throw new Error("Cannot bound a shape with no geometry");
      }
      return { min: bbox.GetZMin(), max: bbox.GetZMax() };
    } finally {
      bbox.delete();
      local.delete();
      location.delete();
      trsf.delete();
      frame.delete();
      disposeNormal();
      disposeOrigin();
    }
  }

  /**
   * A box sure to enclose the face, for microseconds: the hull of its
   * surface's control points. Null for any other shape.
   *
   * It is the kernel's quick box (`BRepBndLib.Add` on the geometry), taken
   * only where that box is a proof. For a face on a B-spline surface whose
   * parameters lie within the surface's own, the kernel boxes the control
   * points of the spans the face covers, and a B-spline lies within their
   * hull; for an offset of such a surface it widens that box by the offset,
   * which is how far an offset point sits from its base point. Everywhere
   * else the quick box is sampled — a bare grid for a trimmed Bezier patch
   * or a B-spline read past its bounds, a sampled box widened by a guess
   * for a spline curve, and so for every face boxed through its edges. It
   * held on every shape tried, but nothing says it must; those shapes go
   * to the exact box, which is costly only for the faces covered here.
   *
   * One thing here is still read the sampled way: the face's UV bounds,
   * off its boundary's 2D curves, which say which spans the face covers.
   * Should they fall short, what the box leaves out is a sliver past a
   * knot line, as thin as the shortfall.
   */
  static controlHullRaw(shape: TopoDS_Shape): BoundingBox | null {
    const oc = getOC();
    if (shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) {
      return null;
    }
    const face = oc.TopoDS.Face(shape);
    const adaptor = new oc.BRepAdaptor_Surface(face, true);
    const bbox = new oc.Bnd_Box();
    try {
      const range = {
        uMin: adaptor.FirstUParameter(), uMax: adaptor.LastUParameter(),
        vMin: adaptor.FirstVParameter(), vMax: adaptor.LastVParameter(),
      };
      if (!ShapeOps.isBoxedByControlPoints(adaptor, range)) {
        return null;
      }
      oc.BRepBndLib.Add(face, bbox, false);
      if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface) {
        // The kernel's gap here is the face's tolerance, which the hull of
        // the surface does not need. An offset's gap is the offset: kept.
        bbox.SetGap(0);
      }
      return bbox.IsVoid() ? null : ShapeOps.boundingBoxFromBnd(bbox);
    } finally {
      bbox.delete();
      adaptor.delete();
      face.delete();
    }
  }

  /** Whether the kernel's quick box of `surface` over `range` is its control points' hull; see {@link controlHullRaw}. */
  private static isBoxedByControlPoints(
    surface: Adaptor3d_Surface,
    range: { uMin: number; uMax: number; vMin: number; vMax: number },
  ): boolean {
    const oc = getOC();
    const type = surface.GetType();
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_OffsetSurface) {
      const basis = surface.BasisSurface();
      try {
        return ShapeOps.isBoxedByControlPoints(basis, range);
      } finally {
        basis.delete();
      }
    }
    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface) {
      return false;
    }
    const spline = surface.BSpline();
    try {
      const own = spline.Bounds(0, 0, 0, 0);
      return range.uMin >= own.U1 && range.uMax <= own.U2 && range.vMin >= own.V1 && range.vMax <= own.V2;
    } finally {
      spline.delete();
    }
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
    try {
      return ShapeOps.boundingBoxFromExtents(
        minPnt.X(), minPnt.Y(), minPnt.Z(),
        maxPnt.X(), maxPnt.Y(), maxPnt.Z(),
      );
    } finally {
      minPnt.delete();
      maxPnt.delete();
    }
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
    return ShapeFactory.adopt(ShapeOps.makeCompoundRaw(shapes.map(s => s.getShape())));
  }

  static makeCompoundRaw(shapes: TopoDS_Shape[]) {
    const oc = getOC();
    const compoundBuilder = new oc.BRep_Builder();
    const compound = new oc.TopoDS_Compound();
    try {
      compoundBuilder.MakeCompound(compound);
      for (const shape of shapes) {
        compoundBuilder.Add(compound, shape);
      }
    } finally {
      compoundBuilder.delete();
    }

    return compound;
  }

  static cleanShape(shape: Shape): Shape {
    const raw = shape.getShape();
    const cleaned = ShapeOps.cleanShapeRaw(raw);
    // The cleanup hands back a copy of its own (or the input itself when it
    // gave up); the wrapper takes its own, so a copy is freed here.
    return cleaned === raw ? ShapeFactory.fromShape(cleaned) : ShapeFactory.adopt(cleaned);
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
    opts?: { skipSimplify?: boolean; unifyEdges?: boolean; requireLineage?: boolean },
  ): CleanShapeLineage {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

    // Two coincident cylinders of opposite handedness corrupt the face merge:
    // rebuild the left-handed ones first, and route every remap through the
    // rebuild so callers' pre-clean faces still resolve — see DirectFaces.
    const inputRaw = shape.getShape();
    const sourceShape = shape;
    const direct = DirectFaces.hasMixedHandedness(inputRaw) ? DirectFaces.applyRaw(inputRaw) : null;
    const through = (raw: TopoDS_Shape): TopoDS_Shape | null => (direct ? direct.modifiedOrNull(raw) : raw);
    if (direct) {
      shape = ShapeFactory.fromShape(direct.shape);
    }

    // skipSimplify: pass unifyFaces=false to avoid the slow face-merging step
    // that hangs on tangent contact along curves (e.g., helix sweep + cylinder).
    // It also disables edge unification — delicate tangent geometry opted out
    // of merging entirely.
    // Strict callers may reuse validation only for an identical returned
    // shape (including orientation). Make copying of changed input explicit.
    const merge = SameDomainMerge.run(shape.getShape(), {
      unifyEdges: opts?.skipSimplify ? false : (opts?.unifyEdges ?? false),
      unifyFaces: !opts?.skipSimplify,
      safeInput: opts?.requireLineage ? true : undefined,
    });
    const cleanedRaw = merge.shape;

    // Pre-compute which faces/edges this cleanup saw so the remap can
    // distinguish "didn't know about this shape" (return null) from
    // "saw but didn't modify" (return [original]).
    const knownFaces = new oc.TopTools_MapOfShape();
    const knownEdges = new oc.TopTools_MapOfShape();
    Explorer.withShapes(inputRaw, FACE, raws => {
      for (const raw of raws) knownFaces.Add(raw);
    });
    Explorer.withShapes(inputRaw, EDGE, raws => {
      for (const raw of raws) knownEdges.Add(raw);
    });
    // The rebuilt input, when there was one, is only the merge's input.
    const rebuilt = direct ? shape : null;

    if (!merge.valid) {
      if (opts?.requireLineage) {
        merge.dispose(); knownFaces.delete(); knownEdges.delete(); direct?.dispose(); cleanedRaw.delete(); rebuilt?.dispose();
        throw new Error("Sweep cleanup validation failed: invalid topology would require ShapeFix without trustworthy history.");
      }
      // ShapeFix_Shape creates new TShapes without recording history.
      // Lineage is lost here — remap returns [face] best-effort for
      // faces the cleanup saw, null otherwise.
      merge.dispose();
      const fixer = new oc.ShapeFix_Shape(cleanedRaw);
      const progress = new oc.Message_ProgressRange();
      fixer.Perform(progress);
      const fixed = fixer.Shape();
      fixer.delete();
      progress.delete();

      const wrapped = ShapeFactory.fromShape(fixed);
      // ShapeFix supplies no history: only exact surviving identities can
      // retain display provenance, and their normals are checked again.
      RenderSeams.map(wrapped, [sourceShape]);
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
        rebuilt?.dispose();
        fixed.delete();
        cleanedRaw.delete();
      };
      return {
        shape: wrapped,
        remapFace: (face) => {
          const raw = through(face.getShape());
          return raw && knownFaces.Contains(face.getShape())
            ? [fixedFaces.wrapFace(raw)]
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

    const history = merge.history;
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
      merge.dispose();
      knownFaces.delete();
      knownEdges.delete();
      direct?.dispose();
      rebuilt?.dispose();
      // The merge's result copy: `wrapped` holds its own.
      cleanedRaw.delete();
    };

    const wrapped = ShapeFactory.fromShape(cleanedRaw);
    RenderSeams.map(wrapped, [sourceShape], edge => {
      const raw = through(edge);
      if (!raw || history.IsRemoved(raw)) return [];
      const images = ShapeOps.shapeListToArray(history.Modified(raw));
      return images.length ? images : [raw.Oriented(raw.Orientation())];
    });
    return {
      shape: wrapped,
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
        const list = ShapeOps.shapeListToArray(history.Modified(raw));
        try {
          const images = list.filter(s => s.ShapeType() === FACE);
          return (images.length === 0 ? [raw] : images).map(r => cleanedFaces.wrapFace(r));
        } finally {
          Explorer.deleteAll(list);
        }
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
        const list = ShapeOps.shapeListToArray(history.Modified(raw));
        try {
          const images = list.filter(s => s.ShapeType() === EDGE);
          if (images.length === 0) {
            return [raw.IsSame(edge.getShape()) ? edge : Edge.fromTopoDSEdge(Explorer.toEdge(raw))];
          }
          return images.map(r => Edge.fromTopoDSEdge(Explorer.toEdge(r)));
        } finally {
          Explorer.deleteAll(list);
        }
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
    // Every vertex here is an explorer copy (and the typed copy a point
    // read takes): freed once the merge has registered the kept ones.
    const vertices = Explorer.findShapes(raw, VERTEX);
    try {
      const keptVertices: TopoDS_Shape[] = [];
      let seamVertexCount = 0;
      for (const v of vertices) {
        const vertex = Explorer.toVertex(v);
        try {
          const point = VertexOps.toPointRaw(vertex);
          if (Math.abs(plane.signedDistanceToPoint(point)) < tolerance) {
            seamVertexCount++;
          } else {
            keptVertices.push(v);
          }
        } finally {
          vertex.delete();
        }
      }

      if (seamVertexCount === 0) {
        return shape;
      }

      let unify: ShapeUpgrade_UnifySameDomain | null = null;
      let unified: TopoDS_Shape | null = null;
      try {
        unify = new oc.ShapeUpgrade_UnifySameDomain(raw, true, false, false);
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
        unified = unify.Shape();

        const checker = new oc.BRepCheck_Analyzer(unified, true, true);
        const valid = checker.IsValid();
        checker.delete();
        if (!valid) {
          return shape;
        }
        return ShapeFactory.fromShape(unified);
      } catch {
        return shape;
      } finally {
        unify?.delete();
        // The wrapper took its own typed copy of the result.
        unified?.delete();
      }
    } finally {
      Explorer.deleteAll(vertices);
    }
  }

  static cleanShapeRaw(shape: TopoDS_Shape) {
    // Two coincident cylinders of opposite handedness corrupt the face merge:
    // rebuild the left-handed ones first — see DirectFaces. The rebuilt
    // copy is a step on the way: it goes unless it is what comes back.
    let normalized: TopoDS_Shape | null = null;
    if (DirectFaces.hasMixedHandedness(shape)) {
      normalized = DirectFaces.normalizeRaw(shape);
      shape = normalized;
    }
    const result = ShapeOps.mergeSameDomain(shape);
    if (normalized && result !== normalized) {
      normalized.delete();
    }
    return result;
  }

  private static mergeSameDomain(shape: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();

    // Full unification: merge redundant edges AND co-surface faces.
    // UnifySameDomain can throw on shapes with subtle topology issues
    // (e.g. boolean output from a profile with reversed face normal).
    // Fall back to the input shape on failure rather than aborting.
    let cleaned: TopoDS_Shape;
    let valid: boolean;
    try {
      const merge = SameDomainMerge.run(shape, { unifyEdges: false, unifyFaces: true });
      cleaned = merge.shape;
      valid = merge.valid;
      merge.dispose();
    } catch {
      return shape;
    }

    // Validate — UnifySameDomain can corrupt periodic surfaces (e.g. cylinders)
    if (valid) {
      return cleaned;
    }

    // Repair with ShapeFix_Shape (fixes seam edges, wire orientation, SameParameter)
    try {
      const fixer = new oc.ShapeFix_Shape(cleaned);
      const progress = new oc.Message_ProgressRange();
      fixer.Perform(progress);
      const fixed = fixer.Shape();
      fixer.delete();
      progress.delete();
      cleaned.delete();
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
      // The list's copies go, except the one handed back — the first image
      // itself, or the index's copy of it, which is the caller's to free.
      const image = oriented.orient(modified[0]);
      Explorer.deleteAll(modified.filter(m => m !== image));
      return image;
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
