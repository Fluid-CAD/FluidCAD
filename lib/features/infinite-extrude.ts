import { Solid } from "../common/shapes.js";
import { Face } from "../common/face.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Explorer } from "../oc/explorer.js";

/** A large finite magnitude that stands in for "infinity" in through-all ops.
 *  True infinite prisms (via OC's `Inf=true` flag) silently fail inside
 *  `BRepAlgoAPI_Cut` — use a large finite extrusion instead. */
const THROUGH_ALL_LENGTH = 100000;

export class ExtrudeThroughAll {

  private shapes: Solid[] = null;

  constructor(public extrudable: Extrudable,
    public symmetric: boolean,
    public reversed: boolean,
    public pickedFaces?: Face[]) {
  }

  build(): Solid[] {
    if (this.shapes) {
      return this.shapes;
    }

    const solids: Solid[] = [];

    const plane = this.extrudable.getPlane();

    const faces = this.pickedFaces ?? FaceMaker2.getRegions(
      this.extrudable.getGeometries(), plane);

    console.log("Extruding faces:", faces);

    let dir = plane.normal;

    if (this.reversed) {
      dir = dir.multiply(-1);
    }

    const shouldDispose = !this.pickedFaces;
    const bigDir = dir.multiply(THROUGH_ALL_LENGTH);

    if (this.symmetric) {
      for (const face of faces) {
        // Fuse two finite large prisms — one in each direction — to approximate
        // a symmetric through-all tool. Cannot use makePrismSymmetric here
        // because `BRepAlgoAPI_Cut` silently drops infinite shapes.
        const positive = ExtrudeOps.makePrism(face, bigDir, 1);
        const negative = ExtrudeOps.makePrism(face, bigDir, -1);
        const { result } = BooleanOps.fuse([positive, negative]);
        const fusedSolid = result.find(s => s.getType() === 'solid')
          ?? this.firstSolidOf(result);
        if (fusedSolid) {
          solids.push(fusedSolid as Solid);
        }
        if (shouldDispose) { face.dispose(); }
      }
    } else {
      for (const face of faces) {
        const solid = ExtrudeOps.makePrism(face, bigDir, 1);
        solids.push(solid as Solid);
        if (shouldDispose) { face.dispose(); }
      }
    }

    this.shapes = solids;
    return solids;
  }

  private firstSolidOf(shapes: { getShape(): any; getType(): string }[]): Solid | null {
    for (const shape of shapes) {
      if (shape.getType() === 'solid') {
        return shape as unknown as Solid;
      }
      const subSolids = Explorer.findShapes(shape.getShape(), Explorer.getOcShapeType('solid'));
      if (subSolids.length > 0) {
        return Solid.fromTopoDSSolid(Explorer.toSolid(subSolids[0]));
      }
    }
    return null;
  }
}
