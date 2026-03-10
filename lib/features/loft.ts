import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { LoftOps } from "../oc/loft-ops.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { Extrudable } from "../helpers/types.js";

export class Loft extends SceneObject {

  constructor(public faces: SceneObject[]) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    if (this.faces.length < 2) {
      throw new Error("Loft requires at least two profiles.");
    }

    const allWires: Wire[] = [];

    for (const face of this.faces) {
      const wires = this.getWiresFromSceneObject(face);

      if (wires.length === 0) {
        throw new Error("Could not extract wire from profile.");
      }

      for (const wire of wires) {
        allWires.push(wire);
      }
    }

    const newShapes = LoftOps.makeLoft(allWires);

    for (const face of this.faces) {
      face.removeShapes(this);
    }

    this.addShapes(newShapes);
  }

  private getWiresFromSceneObject(obj: SceneObject): Wire[] {
    const shapes = obj.getShapes({ excludeMeta: false });

    // If shapes are faces, extract their outer wires
    const faceShapes = shapes.filter(s => s.isFace()) as Face[];
    if (faceShapes.length > 0) {
      const wires: Wire[] = [];
      for (const face of faceShapes) {
        const faceWires = face.getWires();
        if (faceWires.length > 0) {
          wires.push(faceWires[0]); // outer wire
        }
      }
      return wires;
    }

    // If shapes are wires directly
    const wireShapes = shapes.filter(s => s.isWire()) as Wire[];
    if (wireShapes.length > 0) {
      return wireShapes;
    }

    // If it's an extrudable (sketch), get geometries and make faces to get wires
    if ('getGeometries' in obj && 'getPlane' in obj) {
      const extrudable = obj as unknown as Extrudable;
      const geometries = extrudable.getGeometries();
      const plane = extrudable.getPlane();
      const faces = FaceMaker.getFaces(geometries, plane);
      const wires: Wire[] = [];
      for (const face of faces) {
        const faceWires = face.getWires();
        if (faceWires.length > 0) {
          wires.push(faceWires[0]);
        }
      }
      return wires;
    }

    // Try to extract wires from solid shapes
    const solidShapes = shapes.filter(s => s.isSolid());
    if (solidShapes.length > 0) {
      const wires: Wire[] = [];
      for (const solid of solidShapes) {
        const solidWires = Explorer.findWiresWrapped(solid);
        if (solidWires.length > 0) {
          wires.push(solidWires[0]);
        }
      }
      return wires;
    }

    return [];
  }

  compareTo(other: Loft): boolean {
    if (!(other instanceof Loft)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.faces.length !== other.faces.length) {
      return false;
    }

    for (let i = 0; i < this.faces.length; i++) {
      if (!this.faces[i].compareTo(other.faces[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "loft";
  }

  serialize() {
    return {
      faces: this.faces.map(f => f.serialize()),
    }
  }
}
