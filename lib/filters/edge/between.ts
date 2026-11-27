import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import type { BodyShape } from "../../common/body-shape.js";
import { SceneObject } from "../../common/scene-object.js";
import { ShapeGroup } from "../shape-group.js";
import { BelongsToFaceFilterBase } from "./belongs-to-face.js";

/**
 * `edge().between(a, b)` / `notBetween(a, b)`: the edge is shared by a face
 * of group `a` and a different face of group `b`, in either order. The
 * faces an edge bounds come from the bodies in scope (scope-aware, as
 * `belongsToFace` is); each group is a {@link ShapeGroup} of face builders
 * and face references, resolved once per evaluation. The two faces must be
 * distinct, so `between(face(), face())` is every interior edge and never a
 * seam. An edge that bounds fewer than two faces in scope — a surface's
 * open rim — is between nothing: it never matches the positive form and
 * always survives the negated one.
 */
export class BetweenFilter extends BelongsToFaceFilterBase {
  constructor(
    private readonly a: ShapeGroup<Face>,
    private readonly b: ShapeGroup<Face>,
    private readonly negate: boolean = false,
  ) {
    super([]);
  }

  override setScopeIndex(bodies: BodyShape[], extraFaces: Face[]): void {
    super.setScopeIndex(bodies, extraFaces);
    this.a.setScope(bodies, extraFaces);
    this.b.setScope(bodies, extraFaces);
  }

  /** Each group is resolved once over the whole stage, and its lookups freed after. */
  override apply(shapes: Edge[]): Edge[] {
    this.a.reset();
    this.b.reset();
    try {
      return super.apply(shapes);
    } finally {
      this.a.reset();
      this.b.reset();
    }
  }

  match(shape: Edge): boolean {
    return this.isBetween(shape) !== this.negate;
  }

  private isBetween(edge: Edge): boolean {
    // A seam bounds its one face once, so it never has two to lie between.
    const faces = this.findContainingFaces(edge);
    if (faces.length < 2) {
      return false;
    }
    const inA = faces.map(face => this.a.has(face));
    const inB = faces.map(face => this.b.has(face));
    for (let i = 0; i < faces.length; i++) {
      for (let j = 0; j < faces.length; j++) {
        if (i !== j && inA[i] && inB[j]) {
          return true;
        }
      }
    }
    return false;
  }

  override getSceneObjectRefs(): SceneObject[] {
    return [...this.a.getSceneObjectRefs(), ...this.b.getSceneObjectRefs()];
  }

  compareTo(other: BetweenFilter): boolean {
    return this.negate === other.negate && this.a.compareTo(other.a) && this.b.compareTo(other.b);
  }

  transform(matrix: Matrix4): BetweenFilter {
    return new BetweenFilter(this.a.transform(matrix), this.b.transform(matrix), this.negate);
  }

  override remap(remap: Map<SceneObject, SceneObject>): BetweenFilter {
    return new BetweenFilter(this.a.remap(remap), this.b.remap(remap), this.negate);
  }
}
