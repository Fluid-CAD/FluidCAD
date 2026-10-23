import type { BRepTools_Modifier, TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { SurfaceFrame, SurfaceFrames } from "./surface-frames.js";

/**
 * Rebuilds every face of a shape that lies on an indirect (left-handed)
 * elementary surface onto its direct twin, via OCCT's
 * `ShapeCustom::DirectFaces` (the healing step OCCT itself runs before a STEP
 * write). Negative-semi-angle cones are straightened by the same pass.
 *
 * Why FluidCAD needs it: OCCT derives a swept surface's frame from the
 * profile curve. A circle whose axis points against the sweep becomes a
 * cylinder with a reversed Z axis (`GeomAdaptor_SurfaceOfLinearExtrusion::
 * Cylinder` calls `ZReverse`), i.e. a left-handed `gp_Ax3`; a mirroring
 * transform flips every frame the same way. So a clockwise sketch arc, a
 * negative extrude, a reversed plane or a `mirror()` each hand the kernel a
 * left-handed surface, while the same geometry drawn the other way round is
 * right-handed. Booleans survive that, but `ShapeUpgrade_UnifySameDomain`
 * (the face merge run after every fuse and cut) corrupts the body when it
 * merges two coincident equal-radius cylinders of opposite handedness — a
 * boss extruded onto an ear whose rounded top it shares came out with a
 * phantom 30 mm edge and a BRepCheck-invalid solid.
 *
 * Where it is applied: at the boolean seam only. `hasMixedHandedness` tells
 * whether a boolean result holds such a pair, and the UnifySameDomain entry
 * points (`ShapeOps.cleanShapeRaw` / `cleanShapeWithLineage`, with the
 * builders' own `SimplifyResult` skipped in that case) normalize the result
 * before merging. Bodies that never meet a mixed pair are left exactly as
 * the kernel built them, so their face and edge enumeration — and every
 * index-based pick on them — is unchanged.
 *
 * Untouched sub-shapes keep their TShape (IsSame holds); rebuilt faces, and
 * the shells / solids containing them, are new. Callers tracking sub-shapes
 * follow them with `modified`.
 *
 * The rebuild mirrors a face's pcurves about u = 0 (u → -u), which leaves a
 * rebuilt face on a periodic surface in a negative parameter range, one
 * period away from where the boolean projected its coincident neighbour
 * (`ElSLib` parameters start in [0, period)). UnifySameDomain then refuses
 * to merge the two and the body keeps a spurious edge where the boss meets
 * the ear. So every rebuilt face is shifted back by whole periods until its
 * parameter range starts inside [0, period) — the same period shift
 * `ShapeFix_Wire::FixShifted` applies within a wire.
 */
export type DirectFacesResult = {
  /**
   * The normalized shape — the same shape as the input (IsSame) when
   * nothing was indirect. A handle of the result's own: `dispose` frees it,
   * so a caller that keeps the shape takes a copy first.
   */
  shape: TopoDS_Shape;
  /** Whether any face was rebuilt (the result is then a new shape). */
  changed: boolean;
  /**
   * The result's stand-in for `sub`, a sub-shape of the input: a fresh copy
   * of the rebuilt sub-shape when its geometry changed (the caller frees
   * it), `sub` itself when it was untouched.
   */
  modified(sub: TopoDS_Shape): TopoDS_Shape;
  /** As `modified`, but null for a sub-shape the rebuild never saw. */
  modifiedOrNull(sub: TopoDS_Shape): TopoDS_Shape | null;
  /** Frees the modifier and `shape`. Every `modified` result stays valid. */
  dispose(): void;
};

export class DirectFaces {

  /**
   * Normalizes `shape` and hands back the rebuild history. A compound is
   * normalized child by child, each with its own modifier, so `modified`
   * resolves sub-shapes of any child.
   */
  static applyRaw(shape: TopoDS_Shape): DirectFacesResult {
    const oc = getOC();
    const COMPOUND = oc.TopAbs_ShapeEnum.TopAbs_COMPOUND;

    if (shape.ShapeType() === COMPOUND) {
      return DirectFaces.applyToCompound(shape);
    }

    const modifier: BRepTools_Modifier = new oc.BRepTools_Modifier(false);
    const result: TopoDS_Shape = oc.ShapeCustomExt.DirectFaces(shape, modifier);
    const changed = !result.IsSame(shape);
    if (changed) {
      const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
      // The explorer copies, the rebuilt images and the typed casts only
      // serve the canonicalization: the modifier keeps the rebuilt faces.
      Explorer.withShapes(shape, FACE, faces => {
        for (const face of faces) {
          const rebuilt = modifier.ModifiedShape(face);
          try {
            if (!rebuilt.IsSame(face)) {
              const typed = oc.TopoDS.Face(rebuilt);
              try {
                DirectFaces.canonicalizePeriodicPCurves(typed);
              } finally {
                typed.delete();
              }
            }
          } finally {
            rebuilt.delete();
          }
        }
      });
    }
    const modified = (sub: TopoDS_Shape) => changed ? modifier.ModifiedShape(sub) : sub;
    return {
      shape: result,
      changed,
      modified,
      modifiedOrNull: (sub) => {
        try {
          return modified(sub);
        } catch {
          return null;
        }
      },
      dispose: () => {
        modifier.delete();
        result.delete();
      },
    };
  }

  /**
   * Whether `shape` holds two faces on the same periodic elementary surface
   * (same axis, radius, ...) with opposite handedness — the pair
   * UnifySameDomain cannot merge safely. Planar coincidences are excluded:
   * they carry no period and merge cleanly whatever their frames.
   */
  static hasMixedHandedness(shape: TopoDS_Shape): boolean {
    const frames = DirectFaces.periodicFrames(shape);
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        if (frames[i].direct !== frames[j].direct && SurfaceFrames.same(frames[i], frames[j])) {
          return true;
        }
      }
    }
    return false;
  }

  /** The frames of `shape`'s faces on the periodic elementary surfaces. */
  private static periodicFrames(shape: TopoDS_Shape): SurfaceFrame[] {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const frames: SurfaceFrame[] = [];
    Explorer.withShapes(shape, FACE, raws => {
      for (const raw of raws) {
        const frame = SurfaceFrames.of(raw);
        if (frame && frame.type !== 'plane') {
          frames.push(frame);
        }
      }
    });
    return frames;
  }

  /**
   * Shifts the pcurves of `face` by whole periods of its surface so the
   * face's parameter range starts inside [0, period) in every periodic
   * direction. Pcurves are translated in place (they are this face's own,
   * freshly made by the rebuild) and re-set through BRep_Builder so the
   * edge's cached UV points follow.
   */
  private static canonicalizePeriodicPCurves(rebuilt: TopoDS_Face): void {
    const oc = getOC();
    const FORWARD = oc.TopAbs_Orientation.TopAbs_FORWARD;
    const REVERSED = oc.TopAbs_Orientation.TopAbs_REVERSED;
    // BRep_Tool's face-based pcurve read flips the edge when the FACE is
    // reversed, while BRep_Builder's write does not: address the face
    // FORWARD so the pair read is the pair written.
    // Every handle read here — the oriented copies, the typed casts, the
    // explorer copies — is this pass's own and goes with it; the kernel
    // keeps the pcurves the builder writes.
    const scratch: { delete(): void }[] = [];
    try {
      const forwardFace = rebuilt.Oriented(FORWARD);
      const face: TopoDS_Face = oc.TopoDS.Face(forwardFace);
      scratch.push(forwardFace, face);
      const adaptor = new oc.BRepAdaptor_Surface(face, false);
      const uPeriod = adaptor.IsUPeriodic() ? adaptor.UPeriod() : 0;
      const vPeriod = adaptor.IsVPeriodic() ? adaptor.VPeriod() : 0;
      adaptor.delete();
      if (uPeriod === 0 && vPeriod === 0) {
        return;
      }

      const bounds = oc.BRepTools.UVBounds(face);
      const du = DirectFaces.periodShift(bounds.UMin, uPeriod);
      const dv = DirectFaces.periodShift(bounds.VMin, vPeriod);
      if (du === 0 && dv === 0) {
        return;
      }

      const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
      const shift = new oc.gp_Vec2d(du, dv);
      const builder = new oc.BRep_Builder();
      scratch.push(shift, builder);
      const seen: TopoDS_Shape[] = [];
      const raws = Explorer.findShapes(face, EDGE);
      scratch.push(...raws);
      for (const raw of raws) {
        // A seam edge is explored once per orientation; its two pcurves are
        // moved together below, so the second visit is skipped.
        if (seen.some(e => e.IsSame(raw))) {
          continue;
        }
        seen.push(raw);
        // A seam's two pcurves are the FORWARD and REVERSED sides of the edge;
        // address it FORWARD so C1 / C2 keep their sides through the write.
        const forwardEdge = raw.Oriented(FORWARD);
        const edge: TopoDS_Edge = oc.TopoDS.Edge(forwardEdge);
        scratch.push(forwardEdge, edge);
        const tolerance = oc.BRep_Tool.Tolerance(edge);
        if (oc.BRepTools.IsReallyClosed(edge, face)) {
          const reversedEdge = edge.Oriented(REVERSED);
          const reversedTyped = oc.TopoDS.Edge(reversedEdge);
          scratch.push(reversedEdge, reversedTyped);
          const forward = oc.BRep_ToolExt.CurveOnFace(edge, face);
          const reversed = oc.BRep_ToolExt.CurveOnFace(reversedTyped, face);
          forward.returnValue.Translate(shift);
          reversed.returnValue.Translate(shift);
          builder.UpdateEdge(edge, forward.returnValue, reversed.returnValue, face, tolerance);
          forward[Symbol.dispose]();
          reversed[Symbol.dispose]();
        } else {
          const rep = oc.BRep_ToolExt.CurveOnFace(edge, face);
          if (rep.returnValue) {
            rep.returnValue.Translate(shift);
            builder.UpdateEdge(edge, rep.returnValue, face, tolerance);
          }
          rep[Symbol.dispose]();
        }
      }
    } finally {
      for (const handle of scratch) handle.delete();
    }
  }

  /** The whole-period translation that moves `min` into [0, period); 0 when not periodic. */
  private static periodShift(min: number, period: number): number {
    if (period === 0) {
      return 0;
    }
    // A range starting a rounding error below 0 is already canonical.
    const EPS = 1e-9;
    return -Math.floor((min + EPS) / period) * period;
  }

  /** Normalizes `shape` and returns only the result (no history) — a handle the caller frees. */
  static normalizeRaw(shape: TopoDS_Shape): TopoDS_Shape {
    const direct = DirectFaces.applyRaw(shape);
    try {
      // The caller's own copy of the result: `dispose` frees the result's.
      return direct.shape.Oriented(direct.shape.Orientation());
    } finally {
      direct.dispose();
    }
  }

  private static applyToCompound(compound: TopoDS_Shape): DirectFacesResult {
    const oc = getOC();
    const children: DirectFacesResult[] = [];
    const iterator = new oc.TopoDS_Iterator(compound, true, true);
    for (; iterator.More(); iterator.Next()) {
      // `Value()` is a copy of its own; each child's result holds its own.
      const child = iterator.Value();
      try {
        children.push(DirectFaces.applyRaw(child));
      } finally {
        child.delete();
      }
    }
    iterator.delete();

    const changed = children.some(c => c.changed);
    // A handle of this result's own either way (see `DirectFacesResult.shape`).
    let shape = compound.Oriented(compound.Orientation());
    if (changed) {
      shape.delete();
      const builder = new oc.BRep_Builder();
      const rebuilt = new oc.TopoDS_Compound();
      builder.MakeCompound(rebuilt);
      for (const child of children) {
        builder.Add(rebuilt, child.shape);
      }
      builder.delete();
      shape = rebuilt;
    }

    return {
      shape,
      changed,
      modified: (sub) => {
        for (const child of children) {
          if (!child.changed) {
            continue;
          }
          // A sub-shape of another child raises Standard_NoSuchObject: try on.
          const mapped = child.modifiedOrNull(sub);
          if (mapped) {
            return mapped;
          }
        }
        return sub;
      },
      modifiedOrNull: (sub) => {
        // An unchanged child answers "unchanged" for anything, so only the
        // rebuilt children can say whether they know `sub`.
        for (const child of children) {
          if (!child.changed) {
            continue;
          }
          const mapped = child.modifiedOrNull(sub);
          if (mapped) {
            return mapped;
          }
        }
        return null;
      },
      dispose: () => {
        for (const child of children) {
          child.dispose();
        }
        shape.delete();
      },
    };
  }
}
