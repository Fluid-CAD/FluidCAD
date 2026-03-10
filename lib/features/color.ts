import { Face } from "../common/face.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { SelectSceneObject } from "./select.js";

export class Color extends SceneObject {

  constructor(private selection: SceneObject, private color: string) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    const sceneObjects = context.getSceneObjects();

    const objShapeMap = new Map<Solid, SceneObject>();
    for (const obj of sceneObjects) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      for (const shape of shapes) {
        objShapeMap.set(shape as Solid, obj);
      }
    }

    const allShapes = Array.from(objShapeMap.keys());

    const targetFaces: Face[] = this.selection.getShapes() as Face[];
    console.log('Color: Target faces from selection:', targetFaces.length);

    // Group faces by their owner solid
    const facesByOwner = new Map<Solid, Face[]>();
    for (const face of targetFaces) {
      const ownerShape = allShapes.find(s => s.hasFace(face.getShape()));
      if (ownerShape) {
        let faces = facesByOwner.get(ownerShape);
        if (!faces) {
          faces = [];
          facesByOwner.set(ownerShape, faces);
        }
        faces.push(face);
      }
      else {
        console.log('Color: Could not find owner shape for face, skipping. Face:', face);
      }
    }

    // Apply all face colors per solid in a single copy
    for (const [ownerShape, faces] of facesByOwner) {
      const newSolid = ownerShape.copy();
      for (const face of faces) {
        newSolid.setColor(face.getShape(), this.color);
      }

      if (this.selection instanceof SelectSceneObject) {
        for (const face of faces) {
          this.selection.removeShape(face, this);
        }
      }

      const ownerObj = objShapeMap.get(ownerShape);
      if (ownerObj) {
        ownerObj.removeShape(ownerShape, this);
      }

      this.addShape(newSolid);
    }
  }

  compareTo(other: Color): boolean {
    if (!(other instanceof Color)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.color !== other.color) {
      return false;
    }

    if (!this.selection.compareTo(other.selection)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return 'color';
  }

  serialize() {
    return {
    }
  }
}
