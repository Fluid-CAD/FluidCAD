import type { BRepPrimAPI_MakeRevol, gp_Pln, gp_Vec, TopAbs_ShapeEnum, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Vector3d } from "../math/vector3d.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { Axis } from "../math/axis.js";
import { Explorer } from "./explorer.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { ShapeOps } from "./shape-ops.js";

/**
 * History-based result of a `BRepPrimAPI_MakeRevol` operation. `firstFace` /
 * `lastFace` come from the maker's `FirstShape` / `LastShape` (null on full
 * revolution where the source face is absorbed). `edgeFaces` maps each edge
 * of the input face to the swept face it generated, so callers can classify
 * by input-edge category instead of geometric heuristics.
 */
export interface MakeRevolResult {
  solid: Shape;
  firstFace: Face | null;
  lastFace: Face | null;
  edgeFaces: { edge: TopoDS_Shape; face: Face | null }[];
}

export class ExtrudeOps {
  static makePrism(shape: Shape, direction: Vector3d, distance: number): Shape {
    const oc = getOC();
    const [vec, disposeVec] = Convert.toGpVec(direction.multiply(distance));
    const prism = new oc.BRepPrimAPI_MakePrism(shape.getShape(), vec, false, true);
    const result = prism.Shape();
    prism.delete();
    disposeVec();
    return ShapeFactory.fromShape(result);
  }

  /**
   * Build a prism by sweeping `shape` along `vec`. `firstFace` is the cap at the
   * profile location, `lastFace` the cap at `profile + vec`.
   *
   * When `canonicalizeSweep` is set, the sweep is reoriented to a canonical
   * direction (see below). The swept lateral surfaces (cylinders, cones from a
   * non-drafted profile) take their axis/parametrization from the sweep
   * direction, and OCCT 8's `ShapeUpgrade_UnifySameDomain` refuses to merge two
   * such faces swept in opposite directions. So a symmetric extrude (one half
   * up, one half down) otherwise fuses into a solid whose lateral surface stays
   * split at the mid-plane. Canonicalizing makes anti-parallel extrudes share
   * parametrization so the fused result merges cleanly.
   *
   * This must stay OFF for drafted extrudes: `BRepOffsetAPI_DraftAngle` tilts
   * each side face relative to its own parametrization, so flipping the sweep
   * would invert the draft. Drafted halves are cones of differing half-angle
   * anyway and are not expected to merge across the mid-plane.
   */
  static makePrismFromVec(
    shape: Shape,
    vec: Vector3d,
    canonicalizeSweep = false,
  ): { solid: Shape; firstFace: Shape; lastFace: Shape } {
    const oc = getOC();

    // Sweep toward the hemisphere whose dominant component is positive; for a
    // `v` / `-v` pair this resolves to the same direction. When we flip, sweep
    // a copy of the profile translated to the far end, then swap the caps back.
    const flip = canonicalizeSweep && !ExtrudeOps.isCanonicalSweep(vec);
    const sweep = flip ? vec.multiply(-1) : vec;
    const profile = flip
      ? ShapeOps.transform(shape, Matrix4.fromTranslationVector(vec))
      : shape;

    const [gpVec, disposeVec] = Convert.toGpVec(sweep);
    const prism = new oc.BRepPrimAPI_MakePrism(profile.getShape(), gpVec, true, true);
    if (!prism.IsDone()) {
      prism.delete();
      disposeVec();
      throw new Error("Extrusion failed");
    }
    const solid = prism.Shape();
    // When flipped, the swept profile is the far cap: FirstShape is the far end
    // and LastShape sits at the original profile location — swap them back to
    // preserve the (firstFace = profile, lastFace = far end) contract.
    const first = prism.FirstShape();
    const last = prism.LastShape();
    prism.delete();
    disposeVec();
    return {
      solid: ShapeFactory.fromShape(solid),
      firstFace: ShapeFactory.fromShape(flip ? last : first),
      lastFace: ShapeFactory.fromShape(flip ? first : last),
    };
  }

  /**
   * Whether a sweep vector points into the canonical hemisphere (dominant
   * component positive). Anti-parallel vectors map to opposite results, so a
   * `v` / `-v` pair always agree on a single canonical sweep direction — which
   * is what keeps their swept surfaces mergeable. `>=` ties pick the same axis
   * for `v` and `-v`.
   */
  private static isCanonicalSweep(vec: Vector3d): boolean {
    const ax = Math.abs(vec.x);
    const ay = Math.abs(vec.y);
    const az = Math.abs(vec.z);
    if (az >= ax && az >= ay) {
      return vec.z > 0;
    }
    if (ay >= ax) {
      return vec.y > 0;
    }
    return vec.x > 0;
  }

  static makePrismInfinite(shape: Shape, direction: Vector3d): Shape {
    const oc = getOC();
    const [vec, disposeVec] = Convert.toGpVec(direction);
    const prism = new oc.BRepPrimAPI_MakePrism(shape.getShape(), vec, true, true);
    const result = prism.Shape();
    prism.delete();
    disposeVec();
    return ShapeFactory.fromShape(result);
  }

  static makePrismSymmetric(shape: Shape, direction: Vector3d): Shape {
    const oc = getOC();
    const [dir, disposeDir] = Convert.toGpDir(direction);
    const prism = new oc.BRepPrimAPI_MakePrism(shape.getShape(), dir, true, false, true);
    if (!prism.IsDone()) {
      prism.delete();
      disposeDir();
      throw new Error("Symmetric extrusion failed");
    }
    const result = prism.Shape();
    prism.delete();
    disposeDir();
    return ShapeFactory.fromShape(result);
  }

  static makeRevol(shape: Shape, axis: Axis, angle: number): MakeRevolResult {
    const oc = getOC();
    const [ax1, disposeAx1] = Convert.toGpAx1(axis);
    let revol: BRepPrimAPI_MakeRevol;
    try {
      revol = new oc.BRepPrimAPI_MakeRevol(shape.getShape(), ax1, angle, true);
    } catch {
      disposeAx1();
      throw new Error("Revolution failed");
    }
    if (!revol.IsDone()) {
      revol.delete();
      disposeAx1();
      throw new Error("Revolution failed");
    }
    const rawResult = revol.Shape();

    // Capture history while the maker is alive. For full revolution the
    // source face is absorbed (IsDeleted), so first/last are meaningless.
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const sourceDeleted = revol.IsDeleted(shape.getShape());
    const firstShapeRaw = sourceDeleted ? null : revol.FirstShape();
    const lastShapeRaw = sourceDeleted ? null : revol.LastShape();

    const inputEdgesRaw = Explorer.findShapes(shape.getShape(), EDGE);
    const edgeFacesRaw: { edge: TopoDS_Shape; face: TopoDS_Shape | null }[] = [];
    for (const edge of inputEdgesRaw) {
      const generated = ShapeOps.shapeListToArray(revol.Generated(edge))
        .filter(s => s.ShapeType() === FACE);
      edgeFacesRaw.push({ edge, face: generated[0] ?? null });
    }

    revol.delete();
    disposeAx1();

    // A profile face whose normal points "backwards" relative to the axis
    // produces a closed solid with inverted shell orientation. Volume can
    // still be positive but downstream boolean ops fail. OrientClosedSolid
    // flips the shell to outward-facing when needed.
    let oriented = rawResult;
    if (Explorer.isSolid(rawResult)) {
      const solid = Explorer.toSolid(rawResult);
      oc.BRepLib.OrientClosedSolid(solid);
      oriented = solid;
    }

    const clean = ShapeOps.cleanShapeRaw(oriented);
    const cleanedFaceRaws = Explorer.findShapes(clean, FACE);
    const wrappedFaces = cleanedFaceRaws.map(f => Face.fromTopoDSFace(Explorer.toFace(f)));

    const findFace = (raw: TopoDS_Shape | null): Face | null => {
      if (!raw) {
        return null;
      }
      for (let i = 0; i < cleanedFaceRaws.length; i++) {
        if (cleanedFaceRaws[i].IsSame(raw)) {
          return wrappedFaces[i];
        }
      }
      return null;
    };

    return {
      solid: ShapeFactory.fromShape(clean),
      firstFace: findFace(firstShapeRaw),
      lastFace: findFace(lastShapeRaw),
      edgeFaces: edgeFacesRaw.map(({ edge, face }) => ({ edge, face: findFace(face) })),
    };
  }

  static applyDraftOnSideFaces(
    solid: Shape,
    firstFace: Shape,
    lastFace: Shape,
    plane: Plane,
    angle: number,
    excludeFaces: Shape[] = [],
  ): { solid: Shape; firstFace: Shape; lastFace: Shape; remapFace: (face: Shape) => Shape[] } {
    const oc = getOC();
    const [dir, disposeDir] = Convert.toGpDir(plane.normal);
    const [pln, disposePln] = Convert.toGpPln(plane);

    const solidRaw = solid.getShape();
    const firstFaceRaw = firstFace.getShape();
    const lastFaceRaw = lastFace.getShape();
    const excludeRaw = excludeFaces.map(s => s.getShape());

    const draftMaker = new oc.BRepOffsetAPI_DraftAngle(solidRaw);
    const sideFaces = Explorer.findShapes(solidRaw, Explorer.getOcShapeType("face")).filter(
      f =>
        !f.IsSame(firstFaceRaw)
        && !f.IsSame(lastFaceRaw)
        && !excludeRaw.some(e => f.IsSame(e))
    );

    for (const face of sideFaces) {
      // Skip faces whose surface normal is parallel to the draft pull
      // direction — drafting them is geometrically degenerate (you can't
      // tilt a face around an axis parallel to the face's own normal) and
      // OCC fails the whole Build() if any such face is added. Non-planar
      // faces get drafted unconditionally.
      const adaptor = new oc.BRepAdaptor_Surface(Explorer.toFace(face), true);
      if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        const facePlane = adaptor.Plane();
        const ax = facePlane.Axis().Direction();
        const dot = Math.abs(ax.Dot(dir));
        adaptor.delete();
        if (dot > 0.999) {
          continue;
        }
      } else {
        adaptor.delete();
      }
      draftMaker.Add(Explorer.toFace(face), dir, angle, pln, true);
    }

    const progress = new oc.Message_ProgressRange();
    draftMaker.Build(progress);
    progress.delete();

    if (!draftMaker.IsDone()) {
      draftMaker.delete();
      disposeDir();
      disposePln();
      throw new Error("Draft application failed");
    }

    const modifiedFirst = ShapeOps.shapeListToArray(draftMaker.Modified(firstFaceRaw));
    const modifiedLast = ShapeOps.shapeListToArray(draftMaker.Modified(lastFaceRaw));

    const newFirstFace = modifiedFirst.length > 0
      ? ShapeFactory.fromShape(modifiedFirst[0])
      : firstFace;
    const newLastFace = modifiedLast.length > 0
      ? ShapeFactory.fromShape(modifiedLast[0])
      : lastFace;

    // Capture the post-draft images of every input face we care about
    // BEFORE deleting the maker. This lets the caller remap pre-draft
    // face buckets onto the drafted result.
    const remapMap = new Map<TopoDS_Shape, Shape[]>();
    const captureRemap = (raw: TopoDS_Shape) => {
      const list = ShapeOps.shapeListToArray(draftMaker.Modified(raw));
      remapMap.set(raw, list.length > 0
        ? list.map(r => ShapeFactory.fromShape(r))
        : [ShapeFactory.fromShape(raw)]);
    };
    captureRemap(firstFaceRaw);
    captureRemap(lastFaceRaw);
    for (const ex of excludeRaw) {
      captureRemap(ex);
    }
    for (const sf of sideFaces) {
      captureRemap(sf);
    }

    const result = draftMaker.Shape();
    draftMaker.delete();
    disposeDir();
    disposePln();

    const remapFace = (face: Shape): Shape[] => {
      const raw = face.getShape();
      for (const [k, v] of remapMap) {
        if (k.IsSame(raw)) {
          return v;
        }
      }
      return [face];
    };

    return {
      solid: ShapeFactory.fromShape(result),
      firstFace: newFirstFace,
      lastFace: newLastFace,
      remapFace,
    };
  }

  static applyDraft(shape: TopoDS_Shape, direction: Vector3d, angle: number): TopoDS_Shape {
    const oc = getOC();
    const [dir, disposeDir] = Convert.toGpDir(direction);

    const draftMaker = new oc.BRepOffsetAPI_DraftAngle(shape);
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);

    while (explorer.More()) {
      const face = oc.TopoDS.Face(explorer.Current());
      const adaptor = new oc.BRepAdaptor_Surface(face, true);

      if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        adaptor.delete();
        explorer.Next();
        continue;
      }

      const facePlane = adaptor.Plane();
      const faceNormal = facePlane.Axis().Direction();
      const dot = Math.abs(faceNormal.Dot(dir));
      faceNormal.delete();
      adaptor.delete();

      if (dot > 0.999) {
        facePlane.delete();
        explorer.Next();
        continue;
      }

      draftMaker.Add(face, dir, angle, facePlane, true);
      facePlane.delete();
      explorer.Next();
    }

    explorer.delete();
    const progress = new oc.Message_ProgressRange();
    draftMaker.Build(progress);
    progress.delete();

    if (!draftMaker.IsDone()) {
      draftMaker.delete();
      disposeDir();
      throw new Error("Draft operation failed");
    }

    const result = draftMaker.Shape();
    draftMaker.delete();
    disposeDir();
    return result;
  }
}
