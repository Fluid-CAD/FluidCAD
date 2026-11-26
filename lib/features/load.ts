import { SceneObject } from "../common/scene-object.js";
import { FileImport } from "../io/file-import.js";
import { AssetRoots, type AssetRoot } from "../io/asset-roots.js";
import { ScaleOps } from "../oc/scale-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import type { Matrix4 } from "../math/matrix4.js";
import type { Shape } from "../common/shape.js";
import type { ColoredBody } from "../common/colored-body.js";
import { parseLengthUnit, unitFactor } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import type { LoadOptions } from "../core/interfaces.js";

export class LoadFile extends SceneObject {

  private _noColors = false;
  private _include?: Set<number>;
  private _exclude = new Set<number>();
  /** The caller's assertion of the asset's unit; null means "trust the sidecar". */
  private _assetUnit: LengthUnit | null = null;
  /**
   * The installed package whose `imports/` this load reads, or null for the
   * workspace's — resolved once, when the statement is made, from the file
   * that wrote the call and its `{ from }` (see AssetRoots).
   */
  private _assetRoot: AssetRoot | null;
  /** The asset files' on-disk identity as of this render — see FileImport.assetStamp. */
  private _assetStamp: string | null;

  constructor(public fileName: string, options?: LoadOptions) {
    super();
    this._assetRoot = AssetRoots.forCall(AssetRoots.parseFrom('load()', options?.from));
    this._assetStamp = FileImport.assetStamp(fileName, this._assetRoot);
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
    return this._assetUnit ?? FileImport.readAssetUnit(this.fileName, this._assetRoot);
  }

  build() {
    const imported = FileImport.deserializeShapesWithMetadata(this.fileName, {
      noColors: this._noColors,
      include: this._include,
      exclude: this._exclude.size > 0 ? this._exclude : undefined,
      root: this._assetRoot,
    });
    // The imports/ cache is canonical mm and shared by documents of every
    // unit, so the scaling belongs here, into THIS statement's unit. Factor 1
    // (mm into mm) returns the shapes untouched, keeping existing projects
    // bit-identical.
    const factor = unitFactor(this.assetUnit(), this.getUnit());
    // The sidecar's colours are this statement's paint: it holds the bodies
    // and is the author of their colours.
    const counts = { solids: 0, surfaces: 0, curves: 0 };
    const clone = this.getTransform();
    for (const scaled of ScaleOps.scaleColoredBodies(imported, factor)) {
      const { body, colors } = clone ? LoadFile.placed(scaled, clone) : scaled;
      this.addShape(body);
      for (const { face, color } of colors) {
        this.recordFaceColor(body, face, color, this);
      }
      if (body.isSolid()) {
        counts.solids++;
      } else if (body.isBody()) {
        counts.surfaces++;
      } else {
        counts.curves++;
      }
    }
    this.setState('contents', counts);
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

    // The same name under another root is another asset: the project's
    // imports/motor.brep and a package's never stand in for each other.
    if ((this._assetRoot?.dir ?? null) !== (other._assetRoot?.dir ?? null)) {
      return false;
    }

    if (this._noColors !== other._noColors) {
      return false;
    }

    if (this._assetUnit !== other._assetUnit) {
      return false;
    }

    // The asset was re-imported (or edited) since the other render read it.
    if (this._assetStamp !== other._assetStamp) {
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

  /** A body a repeat or mirror instance places elsewhere, its painted faces carried onto the moved ones. */
  private static placed(source: ColoredBody<Shape>, matrix: Matrix4): ColoredBody<Shape> {
    const { shape, images } = ShapeOps.transformTracking(source.body, matrix, source.colors.map(({ face }) => face));
    return {
      body: shape,
      colors: source.colors.flatMap(({ color }, i) => images[i] ? [{ face: images[i]!, color }] : []),
    };
  }

  /**
   * A repeat or a mirror re-runs the load: the clone reads the same asset
   * from the same root as the statement that was written, not from wherever
   * the clone happens to be made.
   */
  override createCopy(): SceneObject {
    const copy = new LoadFile(this.fileName);
    copy._assetRoot = this._assetRoot;
    copy._assetStamp = this._assetStamp;
    copy._assetUnit = this._assetUnit;
    copy._noColors = this._noColors;
    copy._include = this._include ? new Set(this._include) : undefined;
    copy._exclude = new Set(this._exclude);
    return copy;
  }

  getType(): string {
    return 'load';
  }

  /** `contents`: how many solids, surfaces and curves the last build added, for whoever reads the scene. */
  serialize() {
    const contents = this.getState('contents');
    return contents ? { contents } : {};
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
