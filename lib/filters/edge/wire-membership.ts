import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { WireRole } from "../../common/face.js";
import { SceneObject } from "../../common/scene-object.js";
import { FaceQuery } from "../../oc/face-query.js";
import { applyFilterStages } from "../filter-base.js";
import { FilterBuilderBase } from "../filter-builder-base.js";
import { resolveRefShapes } from "../plane-ref.js";
import { BelongsToFaceFilterBase } from "./belongs-to-face.js";

/**
 * Loop membership: is the edge on the outer wire of a qualifying face, or on
 * one of its hole wires. Which faces qualify is what the subclasses decide;
 * the loop itself is read off the face *as it is now* in the scope, so the
 * answer holds after fillets and booleans reshaped the rim. An edge no
 * scope face bounds never matches the positive form and always survives
 * the negated one.
 */
abstract class WireMembershipFilterBase extends BelongsToFaceFilterBase {
  constructor(
    faceFilterBuilders: FilterBuilderBase<Face>[],
    protected readonly role: WireRole,
    protected readonly negate: boolean,
  ) {
    super(faceFilterBuilders);
  }

  match(shape: Edge): boolean {
    const hit = this.sitsOnRole(shape, this.findContainingFaces(shape));
    return this.negate ? !hit : hit;
  }

  /** True when the edge lies on the `role` wire of a qualifying containing face. */
  protected abstract sitsOnRole(edge: Edge, containingFaces: Face[]): boolean;

  protected sameRole(other: WireMembershipFilterBase): boolean {
    return this.role === other.role && this.negate === other.negate;
  }
}

/**
 * `outerOf(face()...)` / `holeOf(face()...)`: the loop is taken from a
 * containing face that matches the face filters. With several builders,
 * every builder must find such a face — the same rule `belongsToFace` uses.
 */
export class WireMembershipFilter extends WireMembershipFilterBase {
  protected sitsOnRole(edge: Edge, containingFaces: Face[]): boolean {
    const edgeShape = edge.getShape();
    return this.faceFilterBuilders.every(builder =>
      applyFilterStages(containingFaces, builder.getFilters())
        .some(face => face.wireRoleOf(edgeShape) === this.role)
    );
  }

  compareTo(other: WireMembershipFilter): boolean {
    if (!this.sameRole(other) || this.faceFilterBuilders.length !== other.faceFilterBuilders.length) {
      return false;
    }
    for (let i = 0; i < this.faceFilterBuilders.length; i++) {
      if (!this.faceFilterBuilders[i].equals(other.faceFilterBuilders[i])) {
        return false;
      }
    }
    return true;
  }

  transform(matrix: Matrix4): WireMembershipFilter {
    const transformed = this.faceFilterBuilders.map(builder => builder.transform(matrix));
    return new WireMembershipFilter(transformed, this.role, this.negate);
  }
}

/**
 * `outerOf(lf.endFaces())` / `holeOf(lf.endFaces())`: the reference names
 * the face by its surface. A bucket accessor resolves the face as built,
 * and a later fillet or boolean replaces its rim edges, so identity would
 * name nothing on exactly the models that need a loop predicate; instead
 * the containing face lying on the same surface (plane, cylinder, cone —
 * `FaceQuery.isSameSurface`) is the one whose loop is read. The reference
 * resolves lazily, is only read, and counts as a dependency of the
 * consuming select().
 */
export class WireMembershipFromSceneObjectFilter extends WireMembershipFilterBase {
  constructor(
    protected readonly sceneObject: SceneObject,
    role: WireRole,
    negate: boolean,
  ) {
    super([], role, negate);
  }

  protected sitsOnRole(edge: Edge, containingFaces: Face[]): boolean {
    const edgeShape = edge.getShape();
    const referenced = resolveRefShapes(this.sceneObject)
      .flatMap(s => s.getSubShapes("face")) as Face[];
    return containingFaces.some(face =>
      referenced.some(ref => ref.compareTo(face) || FaceQuery.isSameSurface(face, ref))
      && face.wireRoleOf(edgeShape) === this.role
    );
  }

  override getSceneObjectRefs(): SceneObject[] {
    return [this.sceneObject];
  }

  compareTo(other: WireMembershipFromSceneObjectFilter): boolean {
    return this.sameRole(other) && this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): WireMembershipFromSceneObjectFilter {
    return new WireMembershipFromSceneObjectFilter(this.sceneObject, this.role, this.negate);
  }

  override remap(remap: Map<SceneObject, SceneObject>): WireMembershipFromSceneObjectFilter {
    const remapped = remap.get(this.sceneObject);
    return remapped ? new WireMembershipFromSceneObjectFilter(remapped, this.role, this.negate) : this;
  }
}
