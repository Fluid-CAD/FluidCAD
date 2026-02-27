import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ShellOps } from "../oc/shell-ops.js";
import { SelectSceneObject } from "./select.js";
import { Face, Shape, Solid } from "../common/shapes.js";

export class Shell extends SceneObject  {

  dependencies: SceneObject[] = [];

  constructor(public faceSelections: SelectSceneObject[], private thickness: number) {
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

    const allFaceShapes = this.faceSelections.flatMap(f => f.getShapes());
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

    for (const selection of this.faceSelections) {
      selection.removeShapes(this);
    }

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

    if (this.faceSelections.length !== other.faceSelections.length) {
      return false;
    }

    for (let i = 0; i < this.faceSelections.length; i++) {
      if (!this.faceSelections[i].compareTo(other.faceSelections[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'shell';
  }

  serialize() {
    return {
      faces: this.faceSelections.map(f => f.serialize()),
      thickness: this.thickness
    }
  }
}
