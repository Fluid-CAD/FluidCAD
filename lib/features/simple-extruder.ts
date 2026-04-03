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
  private _internalFaces: Face[];

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

  getInternalFaces() {
    return this._internalFaces;
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
    let internalFaces: Face[] = [];

    const fusedFaces = BooleanOps.fuseFaces(this.faces)
    for (const face of fusedFaces.result) {
      let { solid, firstFace, lastFace } = ExtrudeOps.makePrismFromVec(face, vec);

      if (this.draft) {
        const draftResult = this.applyDraft(solid, firstFace, lastFace, this.plane);
        solid = draftResult.solid;
        firstFace = draftResult.firstFace;
        lastFace = draftResult.lastFace;
      }

      const solidFaces = Explorer.findFacesWrapped(solid);
      const remainingFaces: Face[] = [];
      for (const f of solidFaces) {
        if (f.getShape().IsSame(firstFace.getShape())) {
          firstFace = f;
        } else if (f.getShape().IsSame(lastFace.getShape())) {
          lastFace = f;
        } else {
          remainingFaces.push(f as Face);
        }
      }

      // Use the firstFace from the solid to detect inner wires
      // Inner wires (CCW) indicate holes — side faces sharing edges with them are internal
      const resolvedFirst = firstFace as Face;
      const innerWireEdgeShapes: Shape[] = [];
      const wires = resolvedFirst.getWires();
      for (const wire of wires) {
        if (!wire.isCW(this.plane.normal)) {
          for (const edge of wire.getEdges()) {
            innerWireEdgeShapes.push(edge);
          }
        }
      }

      for (const f of remainingFaces) {
        if (innerWireEdgeShapes.length > 0 && this.isInternalFace(f, innerWireEdgeShapes)) {
          internalFaces.push(f);
        } else {
          sideFaces.push(f);
        }
      }

      extrusions.push(solid);
      firstFaces.push(firstFace as Face);
      lastFaces.push(lastFace as Face);
    }

    this.firstFaces = firstFaces;
    this.lastFaces = lastFaces;
    this.sideFaces = sideFaces;
    this._internalFaces = internalFaces;

    // if (extrusions.length > 1) {
    //   const { result } = BooleanOps.fuse(extrusions);
    //   console.log('Self fused extrusions count:', result.length);
    //   return result;
    // }

    return extrusions;
  }

  private isInternalFace(face: Face, innerWireEdgeShapes: Shape[]): boolean {
    const faceEdges = face.getEdges();
    return faceEdges.some(fe =>
      innerWireEdgeShapes.some(iwe => fe.getShape().IsPartner(iwe.getShape()))
    );
  }

  private applyDraft(solid: Shape, firstFace: Shape, lastFace: Shape, plane: Plane): { solid: Shape; firstFace: Shape; lastFace: Shape } {
    let angle: number = this.draft[0];

    if (this.distance > 0) {
      angle = -angle;
    }

    return ExtrudeOps.applyDraftOnSideFaces(solid, firstFace, lastFace, plane, rad(angle));
  }
}
