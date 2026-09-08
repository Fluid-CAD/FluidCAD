import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Sketch } from "./2d/sketch.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { collectSourceEntities, sourceEntitiesPayload } from "./2d/solved/source-entities.js";

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

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      // The target-less walk takes every previous sibling — in a solved
      // sketch that includes constraint statements, which own no shapes and
      // only add noise to the transform loop.
      targetObjects = objects.filter(obj => obj.getShapes({ excludeMeta: false, excludeGuide: false }).length > 0);
    }

    if (this._excludedObjects.length > 0) {
      targetObjects = targetObjects.filter(obj => !this._excludedObjects.includes(obj));
    }

    // Duplicates follow their sources AND the mirror line — the viewport
    // tints them constrained only when all of those are.
    this.setState('source-entities', collectSourceEntities(targetObjects, { axes: [this.axis] }));

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

    // Copies keep the source role (via ShapeOps.transform) but are derived.
    for (const shape of transformedShapes) {
      if (!shape.isMetaShape() && !shape.isGuideShape()) {
        shape.setProvenance('mirror-copy');
      }
    }

    this.addShapes(transformedShapes);
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
      ...sourceEntitiesPayload(this.getState('source-entities')),
    }
  }
}
