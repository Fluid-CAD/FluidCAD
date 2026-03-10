import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Sketch } from "./2d/sketch.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { LazyVertex } from "./lazy-vertex.js";

export class MirrorShape2D extends GeometrySceneObject {

  constructor(
    private axis: AxisObjectBase,
    private targetObjects: SceneObject[] = null) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let targetObjects = this.targetObjects;
    let sketch: Sketch  = this.sketch;
    let axis: Axis;
    const objects = sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      targetObjects = objects;
    }

    this.axis.removeShapes(this)

    axis = this.axis.getAxis();

    const transformedShapes: Shape[] = [];

    const plane = sketch.getPlane();
    const mirrorPlaneNormal = axis.direction.cross(plane.normal);
    const matrix = Matrix4.mirrorPlane(mirrorPlaneNormal, axis.origin);

    for (const obj of targetObjects) {
      const shapes = obj.getShapes({ excludeMeta: false, excludeGuide: false });
      for (const shape of shapes) {
        const transformed = ShapeOps.transform(shape, matrix);
        transformedShapes.push(transformed);
      }
    }

    const firstShape = transformedShapes[0] as Edge | Wire;
    const lastShape = transformedShapes[transformedShapes.length - 1] as Edge | Wire;
    if (firstShape) {
      const start = firstShape.getFirstVertex();
      if (start) {
        const localStart = plane.worldToLocal(start.toPoint());
        this.setState('start', localStart);
        this.setCurrentPosition(localStart);
      }
    }

    if (lastShape) {
      const end = lastShape.getLastVertex();
      if (end) {
        const localEnd = plane.worldToLocal(end.toPoint());
        this.setState('end', localEnd);
        this.setCurrentPosition(localEnd);
      }
    }

    const lastObj = targetObjects[targetObjects.length - 1] as GeometrySceneObject;
    if (lastObj) {
      const lastTangent = lastObj.getTangent();
      if (lastTangent) {
        const transformedTangent = lastTangent.transform(matrix)
        this.setTangent(transformedTangent);
      }
    }

    this.addShapes(transformedShapes);
  }

  start(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('start-vertex'), () => [this.getState('start')]);
  }

  end(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('end-vertex'), () => [this.getState('end')]);
  }

  compareTo(other: MirrorShape2D): boolean {
    if (!(other instanceof MirrorShape2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.axis.compareTo(other.axis)) {
      return false;
    }

    const thisTargetObjects = this.targetObjects || [];
    const otherTargetObjects = other.targetObjects || [];

    if (thisTargetObjects.length !== otherTargetObjects.length) {
      return false;
    }

    for (let i = 0; i < thisTargetObjects.length; i++) {
      if (!thisTargetObjects[i].compareTo(otherTargetObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "mirror";
  }

  getUniqueType(): string {
    return 'mirror-shape-2d'
  }

  serialize() {
    return {
      axis: this.axis.serialize(),
    }
  }
}
