import { SceneObject } from "../common/scene-object.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Shape } from "../common/shape.js";
import { FileImport } from "../io/file-import.js";

export class LoadFile extends SceneObject {

  constructor(public fileName: string) {
    super();
  }

  build() {
    const shapes = FileImport.deserializeShapesWithMetadata(this.fileName);
    this.addShapes(shapes);
  }

  compareTo(other: LoadFile): boolean {
    if (!(other instanceof LoadFile)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.fileName !== other.fileName) {
      return false;
    }

    return true;
  }

  getType(): string {
    return 'load';
  }

  serialize() {
    return {
    }
  }
}
