import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ShellOps } from "../oc/shell-ops.js";
import { SelectSceneObject } from "./select.js";
import { Face, Shape, Solid } from "../common/shapes.js";

export class Shell extends SceneObject {

  dependencies: SceneObject[] = [];

  constructor(public faceSelection: SelectSceneObject, private thickness: number) {
    super();
  }

  build(context: BuildSceneObjectContext): void {
    const shapeObjMap = new Map<Shape, SceneObject>();
    for (const obj of context.getSceneObjects()) {
      if (obj.id === this.parentId) {
        continue;
      }

      const shapes = obj.getShapes(false, 'solid');
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

  override clone(): SceneObject[] {
    const selectionClone = this.faceSelection.clone();
    const selection = selectionClone[selectionClone.length - 1] as SelectSceneObject;
    const shell = new Shell(selection, this.thickness);
    return [...selectionClone, shell];
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
