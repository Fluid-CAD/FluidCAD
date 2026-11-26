import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import type { CarriedColor } from "../oc/color-transfer.js";
import { requireShapes } from "../common/operand-check.js";
import { transformTargets } from "../helpers/transform-targets.js";

export class MirrorShape extends SceneObject {
  private _excludedObjects: SceneObject[] = [];

  constructor(
    public plane: PlaneObjectBase,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  exclude(...objects: SceneObject[]): this {
    this._excludedObjects.push(...objects);
    return this;
  }

  override validate() {
    if (!this.targetObjects || this.targetObjects.length === 0) {
      return;
    }
    for (let i = 0; i < this.targetObjects.length; i++) {
      requireShapes(this.targetObjects[i], `target ${i + 1}`, "mirror");
    }
  }

  build(context: BuildSceneObjectContext) {
    let objects: SceneObject[];
    let plane: Plane;

    const allSceneObjects = context.getSceneObjects();
    const lastObj = context.getLastObject();

    if (this.parentId) {
      objects = this.getParent().getPreviousSiblings(this);
    }
    else {
      objects = allSceneObjects;
    }

    const named = this.targetObjects && this.targetObjects.length > 0
      ? objects.filter(obj => this.targetObjects.includes(obj))
      : null;
    const exclude = (list: SceneObject[]) => list.filter(obj => !this._excludedObjects.includes(obj));
    // Without targets a mirror reflects the last statement's bodies, not the whole scope.
    const scope = lastObj ? [lastObj] : objects;

    if (this.plane) {
      this.plane.removeShapes(this)
    }

    plane = this.plane.getPlane();
    const matrix = Matrix4.mirrorPlane(plane.normal, plane.origin);

    const transformedShapes: Shape[] = [];
    const mirroredColors: CarriedColor[] = [];
    // A surface or a curve has no material to join: its image is a body of
    // its own whatever the operation mode.
    const standalone: Shape[] = [];
    const standaloneColors: CarriedColor[] = [];

    // A named target's body is read wherever the features since left it;
    // the mirror never takes it, so no holder to update.
    for (const { holder, shape } of transformTargets("mirror", named && exclude(named), exclude(scope), allSceneObjects)) {
      const colors = holder.getFaceColors(shape);
      try {
        const { shape: transformed, colors: carried } = ShapeOps.transformColored({ shape, colors }, matrix);
        transformed.setMeshSource(shape, matrix);
        if (shape.isSolid()) {
          transformedShapes.push(transformed);
          mirroredColors.push(...carried);
        } else {
          standalone.push(transformed);
          standaloneColors.push(...carried);
        }
      } finally {
        colors.delete();
      }
    }

    this.addShapes(standalone);
    this.recordCarriedColors(standaloneColors);

    if (transformedShapes.length === 0) {
      return;
    }

    const stock = this.resolveFusionStock(allSceneObjects);

    if (this._operationMode === 'new') {
      // Only a kept image is a body of this statement's; as a boolean tool
      // its colours are the stock's business (the fuse/cut colour rules).
      this.addShapes(transformedShapes);
      this.recordCarriedColors(mirroredColors);
    } else if (this._operationMode === 'remove') {
      cutWithSceneObjects(stock, transformedShapes, plane, 0, this, {
        recordHistoryFor: this,
      });
    } else {
      const fusionResult = fuseWithSceneObjects(stock, transformedShapes);

      for (const modifiedShape of fusionResult.modifiedShapes) {
        if (modifiedShape.object) {
          modifiedShape.object.removeShape(modifiedShape.shape, this, modifiedShape.successors)
        }
      }

      for (const shape of fusionResult.newShapes) {
        this.addShape(shape);
      }
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
    return 'mirror-shape'
  }

  serialize() {
    return {
      // plane: this.plane,
    }
  }
}
