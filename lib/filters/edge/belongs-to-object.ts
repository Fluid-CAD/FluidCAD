import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolveRefShapes } from "../plane-ref.js";

/**
 * Edges bounding a face of the referenced scene object — a bucket accessor
 * like `boss.sideFaces()`, or a select(). The reference resolves lazily
 * (an accessor passed straight in is built on demand) and is only read, so
 * it stays valid after later features reshaped the geometry, and it counts
 * as a dependency of the consuming select().
 */
abstract class BelongsToObjectFilterBase extends FilterBase<Edge> {
  constructor(protected sceneObject: SceneObject) {
    super();
  }

  protected boundsEdge(shape: Edge): boolean {
    const objectFaces = resolveRefShapes(this.sceneObject)
      .flatMap(s => s.getSubShapes("face")) as Face[];
    return objectFaces.some(face => face.hasEdge(shape.getShape()) !== null);
  }

  override getSceneObjectRefs(): SceneObject[] {
    return [this.sceneObject];
  }
}

export class BelongsToFaceFromSceneObjectFilter extends BelongsToObjectFilterBase {
  match(shape: Edge): boolean {
    return this.boundsEdge(shape);
  }

  compareTo(other: BelongsToFaceFromSceneObjectFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): BelongsToFaceFromSceneObjectFilter {
    return new BelongsToFaceFromSceneObjectFilter(this.sceneObject);
  }

  override remap(remap: Map<SceneObject, SceneObject>): BelongsToFaceFromSceneObjectFilter {
    const remapped = remap.get(this.sceneObject);
    return remapped ? new BelongsToFaceFromSceneObjectFilter(remapped) : this;
  }
}

export class NotBelongsToFaceFromSceneObjectFilter extends BelongsToObjectFilterBase {
  match(shape: Edge): boolean {
    return !this.boundsEdge(shape);
  }

  compareTo(other: NotBelongsToFaceFromSceneObjectFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): NotBelongsToFaceFromSceneObjectFilter {
    return new NotBelongsToFaceFromSceneObjectFilter(this.sceneObject);
  }

  override remap(remap: Map<SceneObject, SceneObject>): NotBelongsToFaceFromSceneObjectFilter {
    const remapped = remap.get(this.sceneObject);
    return remapped ? new NotBelongsToFaceFromSceneObjectFilter(remapped) : this;
  }
}
