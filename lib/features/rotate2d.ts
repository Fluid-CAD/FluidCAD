import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { BuildError } from "../common/build-error.js";
import { LazyVertex } from "./lazy-vertex.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { collectSourceEntities, sourceEntitiesPayload } from "./2d/solved/source-entities.js";

export class Rotate2D extends GeometrySceneObject {
  private _targetObjects: SceneObject[] | null = null;
  private _excludedObjects: SceneObject[] = [];

  constructor(
    public angle: number,
    public center: LazyVertex | null = null,
    private copy: boolean = false,
    ...targets: SceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
  }

  get targetObjects(): SceneObject[] | null {
    return this._targetObjects;
  }

  exclude(...objects: SceneObject[]): this {
    this._excludedObjects.push(...objects);
    return this;
  }

  build(context: BuildSceneObjectContext) {
    let objects: SceneObject[];
    let targetObjects = this.targetObjects;
    let axis: Axis;

    objects = this.sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      targetObjects = objects;
    }

    if (this._excludedObjects.length > 0) {
      targetObjects = targetObjects.filter(obj => !this._excludedObjects.includes(obj));
    }

    // Record before the transform loop — move mode strips source shapes,
    // and the collection guard skips shape-less objects. Rotated geometry
    // follows its sources and the center ref, so the viewport tints it
    // constrained only when all of those are.
    this.setState('source-entities', collectSourceEntities(targetObjects, { center: this.center }));

    const plane = this.sketch.getPlane();
    if (!this.center) {
      throw new BuildError("rotate() needs an explicit center — rotate(angle, [x, y], ...)");
    }
    const centerWorld = plane.localToWorld(this.center.asPoint2D());
    axis = new Axis(centerWorld, plane.zAxis.direction);

    const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, rad(this.angle));

    for (const obj of targetObjects) {
      const shapes = obj.getShapes();
      for (const shape of shapes) {
        const transformed = ShapeOps.transform(shape, matrix);
        this.addShape(transformed);
        if (!this.copy) {
          obj.removeShape(shape, this);
        }
      }
    }

  }

  compareTo(other: Rotate2D): boolean {
    if (!(other instanceof Rotate2D)) {
      return false;
    }

    if (this.copy !== other.copy) {
      return false;
    }

    if (this.angle !== other.angle) {
      return false;
    }

    if ((this.center === null) !== (other.center === null)) {
      return false;
    }
    if (this.center && other.center && !this.center.compareTo(other.center)) {
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

    if (!super.compareTo(other)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "rotate";
  }

  getUniqueType(): string {
    return 'rotate-shape-2d'
  }

  serialize() {
    const center = this.center?.asPoint2D();
    return {
      angle: this.angle,
      center: center ? [center.x, center.y] : null,
      ...sourceEntitiesPayload(this.getState('source-entities')),
    }
  }
}
