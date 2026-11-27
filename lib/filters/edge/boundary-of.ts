import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import type { BodyShape } from "../../common/body-shape.js";
import { SceneObject } from "../../common/scene-object.js";
import { ShapeGroup } from "../shape-group.js";
import { BelongsToFaceFilterBase } from "./belongs-to-face.js";

/**
 * `edge().boundaryOf(...faces)` / `notBoundaryOf(...)`: the perimeter of a
 * group of faces — an edge that bounds exactly one face of the group. For
 * one face that is all of its loops; for connected faces, their outline;
 * for groups apart from each other, each one's outline. The faces an edge
 * bounds come from the bodies in scope (scope-aware, as `belongsToFace`
 * is); the group is a {@link ShapeGroup} of face builders and face
 * references, resolved once per evaluation. A seam, which runs through its
 * one face twice, is never on a perimeter.
 */
export class BoundaryOfFilter extends BelongsToFaceFilterBase {
  constructor(
    private readonly group: ShapeGroup<Face>,
    private readonly negate: boolean = false,
  ) {
    super([]);
  }

  override setScopeIndex(bodies: BodyShape[], extraFaces: Face[]): void {
    super.setScopeIndex(bodies, extraFaces);
    this.group.setScope(bodies, extraFaces);
  }

  /** The group is resolved once over the whole stage, and its lookups freed after. */
  override apply(shapes: Edge[]): Edge[] {
    this.group.reset();
    try {
      return super.apply(shapes);
    } finally {
      this.group.reset();
    }
  }

  match(shape: Edge): boolean {
    return this.isOnPerimeter(shape) !== this.negate;
  }

  private isOnPerimeter(edge: Edge): boolean {
    const faces = this.findContainingFaces(edge);
    let bounded = 0;
    for (const face of faces) {
      if (this.group.has(face) && ++bounded > 1) {
        return false;
      }
    }
    // Only an edge with one face can be a seam (its face bounds it once).
    return bounded === 1 && (faces.length > 1 || !this.isHiddenInScope(edge));
  }

  override getSceneObjectRefs(): SceneObject[] {
    return this.group.getSceneObjectRefs();
  }

  compareTo(other: BoundaryOfFilter): boolean {
    return this.negate === other.negate && this.group.compareTo(other.group);
  }

  transform(matrix: Matrix4): BoundaryOfFilter {
    return new BoundaryOfFilter(this.group.transform(matrix), this.negate);
  }

  override remap(remap: Map<SceneObject, SceneObject>): BoundaryOfFilter {
    return new BoundaryOfFilter(this.group.remap(remap), this.negate);
  }
}
