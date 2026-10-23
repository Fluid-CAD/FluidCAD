import type { BRep_Builder, Geom2d_Curve, Geom_ConicalSurface, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, gp_Trsf2d } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { ShapeHasher } from "./shape-hash.js";

/**
 * Result of {@link StepConform.conformSolid}: the (possibly rebuilt) solid
 * plus a map from every replaced face to its replacement, keyed by
 * {@link ShapeHasher} key of the ORIGINAL face so callers can carry per-face
 * attributes (colors) across the rebuild.
 *
 * A rebuilt solid is private topology (see `conformSolid`): `delete()` frees
 * it along with every wrapper made on the way, so call it only once the
 * writer no longer needs `shape`.
 */
export class ConformedSolid {
  constructor(
    readonly shape: TopoDS_Shape,
    private readonly replacedFaces: Map<number, TopoDS_Face>,
    private readonly hasher: ShapeHasher,
    private readonly owned: { delete(): void }[] = [],
  ) {}

  /** `subShape` itself, or its rebuilt stand-in if the conform replaced it. */
  replacement(subShape: TopoDS_Shape): TopoDS_Shape {
    return this.replacedFaces.get(this.hasher.key(subShape)) ?? subShape;
  }

  delete(): void {
    this.hasher.delete();
    for (const item of this.owned) {
      item.delete();
    }
    this.owned.length = 0;
  }
}

/**
 * Makes a solid's geometry STEP-conformant before it is handed to OCCT's
 * writer.
 *
 * STEP's `CONICAL_SURFACE` only allows a semi-angle in (0, π/2), but OCCT's
 * `Geom_ConicalSurface` also accepts negative angles, and `BRepPrimAPI_MakeRevol`
 * produces exactly those whenever a revolved profile segment leans toward the
 * axis. `GeomToStep_MakeConicalSurface` throws `"Conicalsurface not STEP
 * conformant"` on such a face and `TopoDSToStep` silently drops it, so the
 * written `MANIFOLD_SOLID_BREP` has holes (Fluid-CAD/FluidCAD#61).
 *
 * A cone with semi-angle −α about axis Z is the same surface as a cone with
 * semi-angle +α about −Z, under the reparametrization (u, v) → (2π − u, −v).
 * Each offending face is rebuilt on the flipped cone with the very same wires
 * and edges (so the shell stays manifold by construction) and each edge gets
 * a rigidly transformed copy of its pcurve on the new surface — the 3D curves,
 * parameter ranges and face orientation are untouched, so no healing is needed.
 *
 * The rebuild works on a topological copy of the solid (geometry shared):
 * the edges a flipped face shares with its neighbours must carry a pcurve
 * on the new surface, and adding one to the caller's edges would leave a
 * representation (and the flipped cone it points at) on the scene's own
 * geometry for every export. On private edges they go away with the result.
 */
export class StepConform {
  static conformSolid(shape: TopoDS_Shape): ConformedSolid {
    const oc = getOC();
    const hasher = new ShapeHasher();
    const replacedFaces = new Map<number, TopoDS_Face>();

    if (shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SOLID) {
      return new ConformedSolid(shape, replacedFaces, hasher);
    }

    let offending = false;
    const faceEx = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; faceEx.More() && !offending; faceEx.Next()) {
      const face = oc.TopoDS.Face(faceEx.Current());
      offending = StepConform.isNonConformantCone(face);
      face.delete();
    }
    faceEx.delete();

    if (!offending) {
      return new ConformedSolid(shape, replacedFaces, hasher);
    }

    const owned: { delete(): void }[] = [];
    const own = <T extends { delete(): void }>(item: T): T => { owned.push(item); return item; };
    try {
      // Topology only: surfaces, curves and triangulation stay shared with the
      // caller's solid, so the copy costs little and writes the same STEP.
      const copier = new oc.BRepBuilderAPI_Copy(shape, false, false);
      const copy = own(copier.Shape());
      // Every original face maps to its copy, so colour records keyed on the
      // caller's faces land on the faces the writer sees.
      const origEx = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; origEx.More(); origEx.Next()) {
        const original = origEx.Current();
        const image = copier.ModifiedShape(original);
        replacedFaces.set(hasher.key(original), own(oc.TopoDS.Face(image)));
        image.delete();
        original.delete();
      }
      origEx.delete();
      copier.delete();

      const builder = new oc.BRep_Builder();
      const solid = own(new oc.TopoDS_Solid());
      builder.MakeSolid(solid);

      // Intrinsic orientations (re-added under parents that keep theirs) with
      // cumulative locations, so every face is placed as the solid places it and
      // stays IsSame with the copies the colour map names.
      const shellIt = new oc.TopoDS_Iterator(copy, false, true);
      for (; shellIt.More(); shellIt.Next()) {
        const oldShell = own(shellIt.Value());
        const shell = own(new oc.TopoDS_Shell());
        builder.MakeShell(shell);

        const faceIt = new oc.TopoDS_Iterator(oldShell, false, true);
        for (; faceIt.More(); faceIt.Next()) {
          const face = own(oc.TopoDS.Face(faceIt.Value()));
          if (StepConform.isNonConformantCone(face)) {
            const replacement = own(StepConform.flipConeFace(face, builder, owned));
            // Re-key the originals that mapped to this copy onto the flipped face.
            for (const [key, mapped] of replacedFaces) {
              if (mapped.IsSame(face)) replacedFaces.set(key, replacement);
            }
            builder.Add(shell, replacement);
          } else {
            builder.Add(shell, face);
          }
        }
        faceIt.delete();

        shell.Closed(oldShell.Closed());
        const orientedShell = own(shell.Oriented(oldShell.Orientation()));
        builder.Add(solid, orientedShell);
      }
      shellIt.delete();
      builder.delete();

      return new ConformedSolid(own(solid.Oriented(shape.Orientation())), replacedFaces, hasher, owned);
    } catch (error) {
      for (const item of owned) item.delete();
      hasher.delete();
      throw error;
    }
  }

  private static isNonConformantCone(face: TopoDS_Face): boolean {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(face, false);
    let bad = false;
    if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
      const cone = adaptor.Cone();
      bad = cone.SemiAngle() < 0;
      cone.delete();
    }
    adaptor.delete();
    return bad;
  }

  /**
   * Rebuilds `face` on the mirrored cone. The returned face carries `face`'s
   * orientation and wires; the wires' edges gain a pcurve on the new surface.
   * Scratch wrappers go to `owned`; the caller frees them with the result.
   */
  private static flipConeFace(face: TopoDS_Face, builder: BRep_Builder, owned: { delete(): void }[]): TopoDS_Face {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(face, false);
    const cone = adaptor.Cone();
    const pos = cone.Position();
    const location = pos.Location();
    const direction = pos.Direction();
    const reversed = direction.Reversed();
    const xDirection = pos.XDirection();
    const flipped = new oc.gp_Ax3(location, reversed, xDirection);
    const surface = new oc.Geom_ConicalSurface(flipped, -cone.SemiAngle(), cone.RefRadius());
    adaptor.delete();
    for (const item of [cone, pos, location, direction, reversed, xDirection, flipped]) item.delete();

    const tolerance = oc.BRep_Tool.Tolerance(face);
    const rebuilt = new oc.TopoDS_Face();
    owned.push(rebuilt);
    builder.MakeFace(rebuilt, surface, tolerance);
    // The face holds the surface now; the handle wrapper is just a reference.
    surface.delete();

    // (u, v) → (2π − u, −v) is a half-turn about (π, 0) in parameter space.
    const toFlipped = new oc.gp_Trsf2d();
    const centre = new oc.gp_Pnt2d(Math.PI, 0);
    toFlipped.SetRotation(centre, Math.PI);
    centre.delete();

    // The stored (un-located) surface: the one the edges' pcurves are keyed on.
    const storedLocation = new oc.TopLoc_Location();
    const stored = oc.BRep_Tool.Surface(face, storedLocation) as Geom_ConicalSurface;
    storedLocation.delete();
    const forward = oc.TopAbs_Orientation.TopAbs_FORWARD;
    const forwardFace = face.Oriented(forward);
    const wireIt = new oc.TopoDS_Iterator(forwardFace, true, true);
    for (; wireIt.More(); wireIt.Next()) {
      const wire = wireIt.Value();
      builder.Add(rebuilt, wire);

      const forwardWire = wire.Oriented(forward);
      const edgeIt = new oc.TopoDS_Iterator(forwardWire, true, true);
      for (; edgeIt.More(); edgeIt.Next()) {
        const edge = oc.TopoDS.Edge(edgeIt.Value());
        const pcurves = StepConform.pcurvesOn(edge, stored);
        if (pcurves.length > 0) {
          const [first, second] = pcurves.map(c => StepConform.transformedCopy(c, toFlipped));
          if (second !== undefined) {
            builder.UpdateEdge(edge, first, second, rebuilt, tolerance);
          } else {
            builder.UpdateEdge(edge, first, rebuilt, tolerance);
          }
          // The edge holds the copies now; the originals were only read.
          first.delete(); second?.delete();
          pcurves.forEach(c => c.delete());
        }
        edge.delete();
      }
      edgeIt.delete();
      forwardWire.delete();
      wire.delete();
    }
    wireIt.delete();
    forwardFace.delete();
    stored.delete();
    toFlipped.delete();

    const oriented = rebuilt.Oriented(face.Orientation());
    const result = oc.TopoDS.Face(oriented);
    oriented.delete();
    return result;
  }

  /**
   * `edge`'s stored pcurves that live on `cone`, in representation order: one
   * for an ordinary edge, two (forward then reversed side) for a seam. The
   * returned handles are the caller's to delete.
   *
   * The binding only exposes the index-based `BRep_Tool::CurveOnSurface`, so
   * the owning surface is matched by value against the face's stored surface
   * rather than by handle — same object, so the numbers are bit-identical,
   * and a geometrically identical cone would carry the same pcurve anyway.
   */
  private static pcurvesOn(edge: TopoDS_Edge, cone: Geom_ConicalSurface): Geom2d_Curve[] {
    const oc = getOC();
    const location = new oc.TopLoc_Location();
    const matches: Geom2d_Curve[] = [];
    for (let index = 1; ; index++) {
      const rep = oc.BRep_Tool.CurveOnSurface(edge, location, 0, 0, index);
      if (rep.C === null || rep.C.isNull()) {
        rep.C?.delete(); rep.S?.delete();
        break;
      }
      if (rep.S instanceof oc.Geom_ConicalSurface && StepConform.sameCone(rep.S, cone)) {
        matches.push(rep.C);
      } else {
        rep.C.delete();
      }
      rep.S?.delete();
    }
    location.delete();
    return matches;
  }

  private static sameCone(a: Geom_ConicalSurface, b: Geom_ConicalSurface): boolean {
    const pa = a.Position();
    const pb = b.Position();
    const la = pa.Location(), lb = pb.Location();
    const da = pa.Direction(), db = pb.Direction();
    const xa = pa.XDirection(), xb = pb.XDirection();
    const same = a.SemiAngle() === b.SemiAngle()
      && a.RefRadius() === b.RefRadius()
      && la.Distance(lb) === 0
      && da.IsEqual(db, 0)
      && xa.IsEqual(xb, 0);
    for (const item of [la, lb, da, db, xa, xb, pa, pb]) item.delete();
    return same;
  }

  /** A private, moved copy; the original face's pcurve is never touched. */
  private static transformedCopy(pcurve: Geom2d_Curve, transform: gp_Trsf2d): Geom2d_Curve {
    // The binding downcasts handles to their concrete class, so the copy is
    // usable wherever a Geom2d_Curve is expected.
    const copy = pcurve.Copy() as Geom2d_Curve;
    copy.Transform(transform);
    return copy;
  }
}
