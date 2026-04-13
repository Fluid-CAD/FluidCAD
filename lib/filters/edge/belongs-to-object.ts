import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { SceneObject } from "../../common/scene-object.js";

export class BelongsToFaceFromSceneObjectFilter extends FilterBase<Edge> {
  constructor(private sceneObject: SceneObject) {
    super();
  }

  match(shape: Edge): boolean {
    const objectFaces = this.sceneObject.getShapes()
      .flatMap(s => s.getSubShapes("face")) as Face[];

    return objectFaces.some(face =>
      face.hasEdge(shape.getShape()) !== null
    );
  }

  compareTo(other: BelongsToFaceFromSceneObjectFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): BelongsToFaceFromSceneObjectFilter {
    return new BelongsToFaceFromSceneObjectFilter(this.sceneObject);
  }
}

export class NotBelongsToFaceFromSceneObjectFilter extends FilterBase<Edge> {
  constructor(private sceneObject: SceneObject) {
    super();
  }

  match(shape: Edge): boolean {
    const objectFaces = this.sceneObject.getShapes()
      .flatMap(s => s.getSubShapes("face")) as Face[];

    return !objectFaces.some(face =>
      face.hasEdge(shape.getShape()) !== null
    );
  }

  compareTo(other: NotBelongsToFaceFromSceneObjectFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): NotBelongsToFaceFromSceneObjectFilter {
    return new NotBelongsToFaceFromSceneObjectFilter(this.sceneObject);
  }
}
