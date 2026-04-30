import type { TopTools_MapOfShape } from "occjs-wrapper";
import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shapes.js";
import { ShapeType } from "../common/shape-type.js";
import { SceneObject } from "../common/scene-object.js";
import { FilterBase } from "./filter-base.js";

export class FromSceneObjectFilter<TShape extends Shape> extends FilterBase<TShape> {
  private membershipSet: TopTools_MapOfShape | null = null;

  constructor(
    private sceneObjects: SceneObject[],
    private shapeType: ShapeType,
  ) {
    super();
  }

  getSceneObjects(): SceneObject[] {
    return this.sceneObjects;
  }

  getShapeType(): ShapeType {
    return this.shapeType;
  }

  setMembershipSet(set: TopTools_MapOfShape | null) {
    this.membershipSet = set;
  }

  match(shape: TShape): boolean {
    if (this.membershipSet) {
      return this.membershipSet.Contains(shape.getShape());
    }
    for (const obj of this.sceneObjects) {
      const subShapes = obj.getShapes().flatMap(s => s.getSubShapes(this.shapeType));
      if (subShapes.some(sub => sub.isSame(shape))) {
        return true;
      }
    }
    return false;
  }

  compareTo(other: FromSceneObjectFilter<TShape>): boolean {
    if (this.shapeType !== other.shapeType) {
      return false;
    }
    if (this.sceneObjects.length !== other.sceneObjects.length) {
      return false;
    }
    for (let i = 0; i < this.sceneObjects.length; i++) {
      if (!this.sceneObjects[i].compareTo(other.sceneObjects[i])) {
        return false;
      }
    }
    return true;
  }

  transform(_matrix: Matrix4): FromSceneObjectFilter<TShape> {
    return new FromSceneObjectFilter<TShape>(this.sceneObjects, this.shapeType);
  }

  override remap(remap: Map<SceneObject, SceneObject>): FromSceneObjectFilter<TShape> {
    const remapped = this.sceneObjects.map(obj => remap.get(obj) ?? obj);
    return new FromSceneObjectFilter<TShape>(remapped, this.shapeType);
  }
}
