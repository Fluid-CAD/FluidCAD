import { SceneObject } from "../../common/scene-object.js";
import { Vertex } from "../../common/vertex.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";

export class PlaneCenter extends GeometrySceneObject {

  constructor() {
    super();
  }

  getType() {
    return 'plane-center';
  }

  build() {
    const plane = this.sketch.getPlane();
    const centerPoint = this.sketch.planeObj.getPlaneCenter();
    const local = plane.worldToLocal(centerPoint);
    this.setCurrentPosition(local);
  }

  center(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('center'), () => {
      const vertex = this.getState('center-vertex');
      if (vertex) {
        return [vertex];
      }
      return [];
    });
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new PlaneCenter();
  }

  compareTo(other: this): boolean {
    if (!(other instanceof PlaneCenter)) {
      return false;
    }

    return super.compareTo(other);
  }

  serialize() {
    return {};
  }
}
