import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";

export class MirrorShape extends SceneObject {
  private _targetObjects: SceneObject[] | null = null;

  constructor(private plane: PlaneObjectBase) {
    super();
  }

  target(...objects: SceneObject[]): this {
    this._targetObjects = objects;
    return this;
  }

  get targetObjects(): SceneObject[] | null {
    return this._targetObjects;
  }

  build(context: BuildSceneObjectContext) {
    let objects: SceneObject[];
    let targetObjects = this.targetObjects;
    let parent: SceneObject | null = null;
    let plane: Plane;

    const allSceneObjects = context.getSceneObjects();
    if (this.parentId) {
      parent = this.getParent();
      objects = parent.getPreviousSiblings(this);
    }
    else {
      objects = allSceneObjects;
    }

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      targetObjects = objects;
    }

    if (this.plane) {
      this.plane.removeShapes(this)
    }

    plane = this.plane.getPlane();

    const shapesMap: Map<Shape, SceneObject> = new Map();
    for (const obj of allSceneObjects) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      for (const shape of shapes) {
        shapesMap.set(shape, obj);
      }
    }

    const transformedShapes: Shape[] = [];

    for (const obj of targetObjects) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      for (const shape of shapes) {
        const matrix = Matrix4.mirrorPlane(plane.normal, plane.origin);
        const transformed = ShapeOps.transform(shape, matrix);
        transformedShapes.push(transformed);
      }
    }

    const fusionResult = fuseWithSceneObjects(allSceneObjects, transformedShapes)

    for (const modifiedShape of fusionResult.modifiedShapes) {
      modifiedShape.object.removeShape(modifiedShape.shape, this)
    }

    for (const shape of fusionResult.newShapes) {
      this.addShape(shape);
    }
  }

  compareTo(other: MirrorShape): boolean {
    if (!(other instanceof MirrorShape)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.plane.compareTo(other.plane)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "mirror";
  }

  getUniqueType(): string {
    return 'mirror-shape'
  }

  serialize() {
    return {
      plane: this.plane,
    }
  }
}
