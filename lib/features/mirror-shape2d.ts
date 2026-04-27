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
import { Vertex } from "../common/vertex.js";

export class MirrorShape2D extends GeometrySceneObject {
  private _excludedObjects: SceneObject[] = [];

  constructor(
    private axis: AxisObjectBase,
    private targetObjects: SceneObject[] = null) {
    super();
  }

  exclude(...objects: SceneObject[]): this {
    this._excludedObjects.push(...objects);
    return this;
  }

  build(context: BuildSceneObjectContext) {
    let targetObjects = this.targetObjects;
    let sketch: Sketch  = this.sketch;
    let axis: Axis;
    const objects = sketch.getPreviousSiblings(this);
    const lastObj = context.getLastObject() as GeometrySceneObject;

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      targetObjects = objects;
    }

    if (this._excludedObjects.length > 0) {
      targetObjects = targetObjects.filter(obj => !this._excludedObjects.includes(obj));
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
        this.setState('start', Vertex.fromPoint2D(localStart));
      }
    }

    if (lastShape) {
      const end = lastShape.getLastVertex();
      if (end) {
        const localEnd = plane.worldToLocal(end.toPoint());
        this.setState('end', Vertex.fromPoint2D(localEnd));
      }
    }

    if (lastObj) {
      const lastTangent = lastObj.getTangent();
      if (lastTangent) {
        const transformedTangent = lastTangent.transform(matrix)
        this.setTangent(transformedTangent);
      }
    }

    const currentPos = this.getCurrentPosition();
    if (currentPos) {
      const worldPos = plane.localToWorld(currentPos);
      const mirroredWorldPos = matrix.transformPoint(worldPos);
      const mirroredLocalPos = plane.worldToLocal(mirroredWorldPos);
      this.setCurrentPosition(mirroredLocalPos);
    }

    this.addShapes(transformedShapes);
  }

  start(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('start-vertex'), () => [this.getState('start')]);
  }

  end(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('end-vertex'), () => [this.getState('end')]);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const axis = (remap.get(this.axis) as AxisObjectBase) || this.axis;
    const targetObjects = this.targetObjects
      ? this.targetObjects.map(obj => remap.get(obj) || obj)
      : null;
    const copy = new MirrorShape2D(axis, targetObjects);
    if (this._excludedObjects.length > 0) {
      const remappedExcluded = this._excludedObjects.map(obj => remap.get(obj) || obj);
      copy.exclude(...remappedExcluded);
    }
    return copy;
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

    if (this._excludedObjects.length !== other._excludedObjects.length) {
      return false;
    }

    for (let i = 0; i < this._excludedObjects.length; i++) {
      if (!this._excludedObjects[i].compareTo(other._excludedObjects[i])) {
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
