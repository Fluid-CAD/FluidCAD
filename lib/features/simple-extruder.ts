import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { ExtrudeOptions } from "./extrude-options.js";
import { Plane } from "../math/plane.js";
import { Explorer } from "../oc/explorer.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { rad } from "../helpers/math-helpers.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";

export class Extruder {
  private firstFaces: Face[];
  private lastFaces: Face[];
  private sideFaces: Face[];

  constructor(
    private faces: Face[],
    private plane: Plane,
    public distance: number,
    public draft?: [number, number],
    public endOffset?: number) {
  }

  getStartFaces() {
    return this.firstFaces;
  }

  getEndFaces() {
    return this.lastFaces;
  }

  getSideFaces() {
    return this.sideFaces;
  }

  extrude() {
    let extrusions: Shape[] = [];

    let distance = this.distance;

    if (this.endOffset) {
      distance -= Math.sign(distance) * this.endOffset;
    }

    const vec = this.plane.normal.multiply(distance);

    let firstFaces: Face[] = [];
    let lastFaces: Face[] = [];
    let sideFaces: Face[] = [];

    for (const face of this.faces) {
      let { solid, firstFace, lastFace } = ExtrudeOps.makePrismFromVec(face, vec);

      if (this.draft) {
        solid = this.applyDraft(solid, firstFace, lastFace, this.plane)
      }

      const solidFaces = Explorer.findFacesWrapped(solid);
      for (const f of solidFaces) {
        if (f.getShape().IsSame(firstFace.getShape())) {
          firstFace = f;
        } else if (f.getShape().IsSame(lastFace.getShape())) {
          lastFace = f;
        } else {
          sideFaces.push(f as Face);
        }
      }

      extrusions.push(solid);
      firstFaces.push(firstFace as Face);
      lastFaces.push(lastFace as Face);
    }

    this.firstFaces = firstFaces;
    this.lastFaces = lastFaces;
    this.sideFaces = sideFaces;

    if (extrusions.length > 1) {
      const { result } = BooleanOps.fuse(extrusions, []);
      return result;
    }

    return extrusions;
  }

  private applyDraft(solid: Shape, firstFace: Shape, lastFace: Shape, plane: Plane): Shape {
    let angle: number = this.draft[0];

    if (this.distance > 0) {
      angle = -angle;
    }

    return ExtrudeOps.applyDraftOnSideFaces(solid, firstFace, lastFace, plane, rad(angle));
  }

  private doExtrude(shape: Shape, vector: any) {
    return ExtrudeOps.makePrismFromVec(shape, vector);
  }
}
