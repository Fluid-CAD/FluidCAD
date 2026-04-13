import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { SceneObject } from "../../common/scene-object.js";

export class HasEdgeFromSceneObjectFilter extends FilterBase<Face> {
  constructor(private sceneObject: SceneObject) {
    super();
  }

  match(shape: Face): boolean {
    const objectEdges = this.sceneObject.getShapes()
      .flatMap(s => s.getSubShapes("edge")) as Edge[];

    return objectEdges.some(objEdge =>
      shape.hasEdge(objEdge.getShape()) !== null
    );
  }

  compareTo(other: HasEdgeFromSceneObjectFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): HasEdgeFromSceneObjectFilter {
    return new HasEdgeFromSceneObjectFilter(this.sceneObject);
  }
}

export class NotHasEdgeFromSceneObjectFilter extends FilterBase<Face> {
  constructor(private sceneObject: SceneObject) {
    super();
  }

  match(shape: Face): boolean {
    const objectEdges = this.sceneObject.getShapes()
      .flatMap(s => s.getSubShapes("edge")) as Edge[];

    return !objectEdges.some(objEdge =>
      shape.hasEdge(objEdge.getShape()) !== null
    );
  }

  compareTo(other: NotHasEdgeFromSceneObjectFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): NotHasEdgeFromSceneObjectFilter {
    return new NotHasEdgeFromSceneObjectFilter(this.sceneObject);
  }
}
