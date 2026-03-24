import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ShellOps } from "../oc/shell-ops.js";
import { SelectSceneObject } from "./select.js";
import { Face, Shape, Solid } from "../common/shapes.js";

export class Shell extends SceneObject {

  private _faceSelection: SelectSceneObject | null = null;

  constructor(private thickness: number, faceSelection?: SelectSceneObject) {
    super();
    this._faceSelection = faceSelection ?? null;
  }

  get faceSelection(): SelectSceneObject {
    return this._faceSelection;
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

    const allFaceShapes = this.faceSelection.getShapes();
    const faces = allFaceShapes as Face[];

    const newShapes: Shape[] = [];
    const allTargetShapes = Array.from(shapeObjMap.keys());

    for (const shape of allTargetShapes) {
      const solid = shape as Solid;
      const targetFaces = faces.filter(f => solid.hasFace(f.getShape()));
      if (!targetFaces.length) {
        continue;
      }

      try {
        const newShape = ShellOps.makeThickSolid(shape, targetFaces, this.thickness);
        newShapes.push(newShape);

        const originalObj = shapeObjMap.get(shape);
        originalObj.removeShape(shape, this);
      } catch {
        newShapes.push(shape);
        console.warn("Shell: Failed to create thick solid.");
      }
    }

    this.faceSelection.removeShapes(this);

    this.addShapes(newShapes);
  }

  compareTo(other: SceneObject): boolean {
    if (!(other instanceof Shell)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.thickness !== other.thickness) {
      return false;
    }

    if (!this.faceSelection.compareTo(other.faceSelection)) {
      return false;
    }

    return true;
  }

  override getDependencies(): SceneObject[] {
    return this.faceSelection ? [this.faceSelection] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const faceSelection = this.faceSelection
      ? (remap.get(this.faceSelection) || this.faceSelection) as SelectSceneObject
      : undefined;
    return new Shell(this.thickness, faceSelection);
  }

  getType(): string {
    return 'shell';
  }

  serialize() {
    return {
      thickness: this.thickness
    }
  }
}
