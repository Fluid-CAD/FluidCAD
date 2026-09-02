import { SceneObject } from "../common/scene-object.js";
import { FileImport } from "../io/file-import.js";
import { OcIO } from "../oc/io.js";
import { parseLengthUnit, unitFactor } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import type { LoadOptions } from "../core/interfaces.js";

export class LoadFile extends SceneObject {

  private _noColors = false;
  private _include?: Set<number>;
  private _exclude = new Set<number>();
  /** The caller's assertion of the asset's unit; null means "trust the sidecar". */
  private _assetUnit: LengthUnit | null = null;

  constructor(public fileName: string, options?: LoadOptions) {
    super();
    if (options?.unit !== undefined) {
      try {
        this._assetUnit = parseLengthUnit(options.unit);
      } catch (err) {
        throw new Error(`load(): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

  /** The unit the asset's cached geometry is in: the assertion, else the sidecar, else mm. */
  assetUnit(): LengthUnit {
    return this._assetUnit ?? FileImport.readAssetUnit(this.fileName);
  }

  build() {
    const shapes = FileImport.deserializeShapesWithMetadata(this.fileName, {
      noColors: this._noColors,
      include: this._include,
      exclude: this._exclude.size > 0 ? this._exclude : undefined,
    });
    // The imports/ cache is canonical mm and shared by documents of every
    // unit, so the scaling belongs here, into THIS statement's unit. Factor 1
    // (mm into mm) returns the shapes untouched, keeping existing projects
    // bit-identical.
    const factor = unitFactor(this.assetUnit(), this.getUnit());
    this.addShapes(OcIO.scaleSolids(shapes, factor));
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

    if (this._assetUnit !== other._assetUnit) {
      return false;
    }

    // The document's unit decides the scale factor, so a unit() change
    // must rebuild the load.
    if (this.getUnit() !== other.getUnit()) {
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
