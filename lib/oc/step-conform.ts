import type { BRep_Builder, Geom2d_Curve, Geom_ConicalSurface, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, gp_Trsf2d } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { ShapeHasher } from "./shape-hash.js";

/**
 * Result of {@link StepConform.conformSolid}: the (possibly rebuilt) solid
 * plus a map from every replaced face to its replacement, keyed by
 * {@link ShapeHasher} key of the ORIGINAL face so callers can carry per-face
 * attributes (colors) across the rebuild.
 */
export class ConformedSolid {
  constructor(
    readonly shape: TopoDS_Shape,
    private readonly replacedFaces: Map<number, TopoDS_Face>,
    private readonly hasher: ShapeHasher,
  ) {}

  /** `subShape` itself, or its rebuilt stand-in if the conform replaced it. */
  replacement(subShape: TopoDS_Shape): TopoDS_Shape {
    return this.replacedFaces.get(this.hasher.key(subShape)) ?? subShape;
  }

  delete(): void {
    this.hasher.delete();
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
      offending = StepConform.isNonConformantCone(oc.TopoDS.Face(faceEx.Current()));
    }
    faceEx.delete();

    if (!offending) {
      return new ConformedSolid(shape, replacedFaces, hasher);
    }

    const builder = new oc.BRep_Builder();
    const solid = new oc.TopoDS_Solid();
    builder.MakeSolid(solid);

    // Intrinsic orientations (re-added under parents that keep theirs) with
    // cumulative locations, so every face is placed as the solid places it and
    // stays IsSame with the faces a caller's colorMap was built from.
    const shellIt = new oc.TopoDS_Iterator(shape, false, true);
    for (; shellIt.More(); shellIt.Next()) {
      const oldShell = shellIt.Value();
      const shell = new oc.TopoDS_Shell();
      builder.MakeShell(shell);

      const faceIt = new oc.TopoDS_Iterator(oldShell, false, true);
      for (; faceIt.More(); faceIt.Next()) {
        const face = oc.TopoDS.Face(faceIt.Value());
        if (StepConform.isNonConformantCone(face)) {
          const replacement = StepConform.flipConeFace(face, builder);
          replacedFaces.set(hasher.key(face), replacement);
          builder.Add(shell, replacement);
        } else {
          builder.Add(shell, face);
        }
      }
      faceIt.delete();

      shell.Closed(oldShell.Closed());
      builder.Add(solid, shell.Oriented(oldShell.Orientation()));
    }
    shellIt.delete();

    return new ConformedSolid(solid.Oriented(shape.Orientation()), replacedFaces, hasher);
  }

  private static isNonConformantCone(face: TopoDS_Face): boolean {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(face, false);
    const isCone = adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Cone;
    const bad = isCone && adaptor.Cone().SemiAngle() < 0;
    adaptor.delete();
    return bad;
  }

  /**
   * Rebuilds `face` on the mirrored cone. The returned face carries `face`'s
   * orientation and wires; the wires' edges gain a pcurve on the new surface.
   */
  private static flipConeFace(face: TopoDS_Face, builder: BRep_Builder): TopoDS_Face {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(face, false);
    const cone = adaptor.Cone();
    const pos = cone.Position();
    const flipped = new oc.gp_Ax3(pos.Location(), pos.Direction().Reversed(), pos.XDirection());
    const surface = new oc.Geom_ConicalSurface(flipped, -cone.SemiAngle(), cone.RefRadius());
    adaptor.delete();

    const tolerance = oc.BRep_Tool.Tolerance(face);
    const rebuilt = new oc.TopoDS_Face();
    builder.MakeFace(rebuilt, surface, tolerance);

    // (u, v) → (2π − u, −v) is a half-turn about (π, 0) in parameter space.
    const toFlipped = new oc.gp_Trsf2d();
    toFlipped.SetRotation(new oc.gp_Pnt2d(Math.PI, 0), Math.PI);

    // The stored (un-located) surface: the one the edges' pcurves are keyed on.
    const storedLocation = new oc.TopLoc_Location();
    const stored = oc.BRep_Tool.Surface(face, storedLocation) as Geom_ConicalSurface;
    storedLocation.delete();
    const forward = oc.TopAbs_Orientation.TopAbs_FORWARD;
    const wireIt = new oc.TopoDS_Iterator(face.Oriented(forward), true, true);
    for (; wireIt.More(); wireIt.Next()) {
      const wire = wireIt.Value();
      builder.Add(rebuilt, wire);

      const edgeIt = new oc.TopoDS_Iterator(wire.Oriented(forward), true, true);
      for (; edgeIt.More(); edgeIt.Next()) {
        const edge = oc.TopoDS.Edge(edgeIt.Value());
        const pcurves = StepConform.pcurvesOn(edge, stored);
        if (pcurves.length === 0) {
          continue;
        }
        const [first, second] = pcurves.map(c => StepConform.transformedCopy(c, toFlipped));
        if (second !== undefined) {
          builder.UpdateEdge(edge, first, second, rebuilt, tolerance);
        } else {
          builder.UpdateEdge(edge, first, rebuilt, tolerance);
        }
      }
      edgeIt.delete();
    }
    wireIt.delete();
    toFlipped.delete();

    return oc.TopoDS.Face(rebuilt.Oriented(face.Orientation()));
  }

  /**
   * `edge`'s stored pcurves that live on `cone`, in representation order: one
   * for an ordinary edge, two (forward then reversed side) for a seam.
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
        break;
      }
      if (rep.S instanceof oc.Geom_ConicalSurface && StepConform.sameCone(rep.S, cone)) {
        matches.push(rep.C);
      }
    }
    location.delete();
    return matches;
  }

  private static sameCone(a: Geom_ConicalSurface, b: Geom_ConicalSurface): boolean {
    const pa = a.Position();
    const pb = b.Position();
    return a.SemiAngle() === b.SemiAngle()
      && a.RefRadius() === b.RefRadius()
      && pa.Location().Distance(pb.Location()) === 0
      && pa.Direction().IsEqual(pb.Direction(), 0)
      && pa.XDirection().IsEqual(pb.XDirection(), 0);
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
