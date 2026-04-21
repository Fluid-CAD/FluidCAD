import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { EdgeQuery } from "../../oc/edge-query.js";

export class IntersectsWithFilter extends FilterBase<Edge> {
  constructor(private sceneObject: SceneObject) {
    super();
  }

  match(shape: Edge): boolean {
    const objectEdges = this.sceneObject.getShapes({ excludeGuide: false })
      .flatMap(s => s.getSubShapes("edge")) as Edge[];

    return objectEdges.some(objEdge =>
      EdgeQuery.doEdgesIntersect(shape, objEdge)
    );
  }

  compareTo(other: IntersectsWithFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): IntersectsWithFilter {
    return new IntersectsWithFilter(this.sceneObject);
  }
}

export class NotIntersectsWithFilter extends FilterBase<Edge> {
  constructor(private sceneObject: SceneObject) {
    super();
  }

  match(shape: Edge): boolean {
    const objectEdges = this.sceneObject.getShapes({ excludeGuide: false })
      .flatMap(s => s.getSubShapes("edge")) as Edge[];

    return !objectEdges.some(objEdge =>
      EdgeQuery.doEdgesIntersect(shape, objEdge)
    );
  }

  compareTo(other: NotIntersectsWithFilter): boolean {
    return this.sceneObject.compareTo(other.sceneObject);
  }

  transform(_matrix: Matrix4): NotIntersectsWithFilter {
    return new NotIntersectsWithFilter(this.sceneObject);
  }
}
