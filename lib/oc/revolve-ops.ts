import type { BRepPrimAPI_MakeRevol, TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Axis } from "../math/axis.js";
import { Explorer } from "./explorer.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { ShapeOps } from "./shape-ops.js";

export interface RevolResult {
  solid: Shape;
  /** The face the source profile became at the start of the sweep; null for a full turn or without history. */
  firstFace: Face | null;
  lastFace: Face | null;
  /** Each input edge of the profile (a raw copy this result owns) with the face it swept. */
  edgeFaces: { edge: TopoDS_Shape; face: Face | null }[];
  /**
   * Every face of the solid, wrapped — `firstFace`, `lastFace` and the
   * `edgeFaces` faces are among them. They are the caller's: hand them to
   * the scene or dispose them.
   */
  faces: Face[];
  /** Frees the raw edge copies in `edgeFaces`. The solid and faces are not touched. */
  dispose(): void;
}

export class RevolveOps {
  /**
   * Revolves `shape` about `axis` by `angle` radians, orients the result
   * outward and merges its same-domain faces. With history (the default)
   * the start/end caps and each profile edge's swept face are identified
   * on the cleaned solid; without it only the solid is built.
   */
  static makeRevol(
    shape: Shape,
    axis: Axis,
    angle: number,
    options: { history?: boolean } = {},
  ): RevolResult {
    const oc = getOC();
    const history = options.history !== false;
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const [ax1, disposeAx1] = Convert.toGpAx1(axis);

    let revol: BRepPrimAPI_MakeRevol;
    try {
      revol = new oc.BRepPrimAPI_MakeRevol(shape.getShape(), ax1, angle, true);
    } catch {
      disposeAx1();
      throw new Error("Revolution failed");
    }

    let rawResult: TopoDS_Shape | null = null;
    let firstShapeRaw: TopoDS_Shape | null = null;
    let lastShapeRaw: TopoDS_Shape | null = null;
    const inputEdgesRaw: TopoDS_Shape[] = [];
    const edgeFacesRaw: { edge: TopoDS_Shape; face: TopoDS_Shape | null }[] = [];
    try {
      if (!revol.IsDone()) {
        throw new Error("Revolution failed");
      }
      rawResult = revol.Shape();

      // Capture history while the maker is alive. For a full revolution the
      // source face is absorbed (IsDeleted), so first/last are meaningless.
      const sourceDeleted = history ? revol.IsDeleted(shape.getShape()) : true;
      firstShapeRaw = sourceDeleted ? null : revol.FirstShape();
      lastShapeRaw = sourceDeleted ? null : revol.LastShape();

      if (history) {
        inputEdgesRaw.push(...Explorer.findShapes(shape.getShape(), EDGE));
        for (const edge of inputEdgesRaw) {
          const generated = ShapeOps.shapeListToArray(revol.Generated(edge));
          let face: TopoDS_Shape | null = null;
          for (const candidate of generated) {
            if (face === null && candidate.ShapeType() === FACE) {
              face = candidate;
            } else {
              candidate.delete();
            }
          }
          edgeFacesRaw.push({ edge, face });
        }
      }
    } finally {
      revol.delete();
      disposeAx1();
    }

    // A profile face whose normal points "backwards" relative to the axis
    // produces a closed solid with inverted shell orientation. Volume can
    // still be positive but downstream boolean ops fail. OrientClosedSolid
    // flips the shell to outward-facing when needed.
    let working: TopoDS_Shape = rawResult;
    if (Explorer.isSolid(rawResult)) {
      const solid = Explorer.toSolid(rawResult);
      rawResult.delete();
      oc.BRepLib.OrientClosedSolid(solid);
      working = solid;
    }

    const clean = ShapeOps.cleanShapeRaw(working);
    if (clean !== working) {
      working.delete();
    }

    // Only the history consumers need every result face wrapped; without it
    // `findFace` has nothing to look up anyway.
    const cleanedFaceRaws = history ? Explorer.findShapes(clean, FACE) : [];
    const faces = cleanedFaceRaws.map(f => Face.fromTopoDSFace(Explorer.toFace(f)));
    const findFace = (raw: TopoDS_Shape | null): Face | null => {
      if (!raw) {
        return null;
      }
      for (let i = 0; i < cleanedFaceRaws.length; i++) {
        if (cleanedFaceRaws[i].IsSame(raw)) {
          return faces[i];
        }
      }
      return null;
    };

    try {
      const edgeFaces = edgeFacesRaw.map(({ edge, face }) => ({ edge, face: findFace(face) }));
      return {
        solid: ShapeFactory.adopt(clean),
        firstFace: findFace(firstShapeRaw),
        lastFace: findFace(lastShapeRaw),
        edgeFaces,
        faces,
        dispose: () => {
          Explorer.deleteAll(inputEdgesRaw);
          inputEdgesRaw.length = 0;
        },
      };
    } finally {
      Explorer.deleteAll(cleanedFaceRaws);
      for (const { face } of edgeFacesRaw) face?.delete();
      firstShapeRaw?.delete();
      lastShapeRaw?.delete();
    }
  }
}
