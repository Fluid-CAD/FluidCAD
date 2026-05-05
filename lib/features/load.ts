import { SceneObject } from "../common/scene-object.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Shape } from "../common/shape.js";
import { FileImport } from "../io/file-import.js";

export class LoadFile extends SceneObject {

  private _noColors = false;
  private _include?: Set<number>;
  private _exclude = new Set<number>();

  constructor(public fileName: string) {
    super();
  }

  noColors(): this {
    this._noColors = true;
    return this;
  }

  include(...indices: number[]): this {
    if (!this._include) {
      this._include = new Set<number>();
    }
    for (const i of indices) {
      this._include.add(i);
    }
    return this;
  }

  exclude(...indices: number[]): this {
    for (const i of indices) {
      this._exclude.add(i);
    }
    return this;
  }

  build() {
    const shapes = FileImport.deserializeShapesWithMetadata(this.fileName, {
      noColors: this._noColors,
      include: this._include,
      exclude: this._exclude.size > 0 ? this._exclude : undefined,
    });
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

    if (this._noColors !== other._noColors) {
      return false;
    }

    if (!equalSets(this._include, other._include)) {
      return false;
    }

    if (!equalSets(this._exclude, other._exclude)) {
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

function equalSets(a: Set<number> | undefined, b: Set<number> | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false;
    }
  }
  return true;
}
