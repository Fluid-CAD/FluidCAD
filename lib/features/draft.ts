import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Face, Shape } from "../common/shapes.js";
import { IDraft } from "../core/interfaces.js";
import { DraftOps } from "../oc/draft-ops.js";
import { requireShapes } from "../common/operand-check.js";

export class Draft extends SceneObject implements IDraft {

  private _selections: SceneObject[] = [];

  constructor(private angle: number, selections: SceneObject[]) {
    super();
    this._selections = selections;
  }

  override validate() {
    for (let i = 0; i < this._selections.length; i++) {
      requireShapes(this._selections[i], `selection ${i + 1}`, "draft");
    }
  }

  build(context: BuildSceneObjectContext): void {
    const shapeObjMap = new Map<Shape, SceneObject>();
    for (const obj of context.getSceneObjects()) {
      if (obj.id === this.parentId) {
        continue;
      }
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      for (const shape of shapes) {
        shapeObjMap.set(shape, obj);
      }
    }

    if (!shapeObjMap.size) {
      return;
    }

    const allFaceShapes: Shape[] = [];
    for (const sel of this._selections) {
      allFaceShapes.push(...sel.getShapes());
    }
    const selectionFaces = allFaceShapes as Face[];
    const selectionFaceRaws = selectionFaces.map(f => f.getShape());

    const newShapes: Shape[] = [];
    const allTargetShapes = Array.from(shapeObjMap.keys());

    for (const shape of allTargetShapes) {
      try {
        const result = DraftOps.applyDraft(shape, selectionFaceRaws, this.angle);

        if (!result) {
          continue;
        }

        newShapes.push(result);
        const originalObj = shapeObjMap.get(shape);
        originalObj.removeShape(shape, this);
      } catch (e) {
        newShapes.push(shape);
        console.warn("Draft: Failed to apply draft angle.", e);
      }
    }

    for (const sel of this._selections) {
      sel.removeShapes(this);
    }

    this.addShapes(newShapes);
  }

  compareTo(other: SceneObject): boolean {
    if (!(other instanceof Draft)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.angle !== other.angle) {
      return false;
    }

    if (this._selections.length !== other._selections.length) {
      return false;
    }
    for (let i = 0; i < this._selections.length; i++) {
      if (!this._selections[i].compareTo(other._selections[i])) {
        return false;
      }
    }

    return true;
  }

  override getDependencies(): SceneObject[] {
    return [...this._selections];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const selections = this._selections.map(
      sel => remap.get(sel) || sel
    );
    return new Draft(this.angle, selections);
  }

  getType(): string {
    return 'draft';
  }

  serialize() {
    return {
      angle: this.angle
    };
  }
}
