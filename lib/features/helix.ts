import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { BuildError } from "../common/build-error.js";
import { requireShapes } from "../common/operand-check.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { IHelix } from "../core/interfaces.js";
import {
  buildHelixEdge, HelixSourceKind, resolveHelixEdgeSource, resolveHelixFaceSource,
} from "./helix-geometry.js";

export class Helix extends SceneObject implements IHelix {
  private _pitch?: number;
  private _turns?: number;
  private _startOffset: number = 0;
  private _endOffset: number = 0;
  private _height?: number;
  private _radius?: number;
  private _endRadius?: number;

  constructor(public source: AxisObjectBase | SceneObject) {
    super();
  }

  pitch(value: number): this {
    this._pitch = value;
    return this;
  }

  turns(value: number): this {
    this._turns = value;
    return this;
  }

  startOffset(value: number): this {
    this._startOffset = value;
    return this;
  }

  endOffset(value: number): this {
    this._endOffset = value;
    return this;
  }

  height(value: number): this {
    this._height = value;
    return this;
  }

  radius(value: number): this {
    this._radius = value;
    return this;
  }

  endRadius(value: number): this {
    this._endRadius = value;
    return this;
  }

  override validate() {
    if (this.source instanceof AxisObjectBase) {
      return;
    }
    requireShapes(this.source, "source", "helix");
  }

  override build(_context?: BuildSceneObjectContext) {
    // The curve itself is scene-free (helix-geometry.ts) — the live dialog
    // preview builds it from the same call, so the ghost can't drift from
    // what an apply produces.
    const edge = buildHelixEdge(
      this.resolveSource(),
      {
        pitch: this._pitch,
        turns: this._turns,
        startOffset: this._startOffset,
        endOffset: this._endOffset,
        height: this._height,
        radius: this._radius,
        endRadius: this._endRadius,
      },
      message => console.warn(message),
    );
    this.addShape(edge);

    this.source.removeShapes(this);
  }

  private resolveSource(): HelixSourceKind {
    if (this.source instanceof AxisObjectBase) {
      return { kind: 'axis', axis: this.source.getAxis() };
    }

    const shapes = this.source.getShapes({ excludeGuide: false });
    if (shapes.length !== 1) {
      throw new BuildError(
        `helix: source must contain exactly one shape (got ${shapes.length}).`,
        `Wrap multi-shape sources in select(...) to pick a single face or edge.`,
      );
    }
    const shape = shapes[0];

    if (shape.isFace()) {
      return resolveHelixFaceSource(shape as Face);
    }
    if (shape.isEdge()) {
      return resolveHelixEdgeSource(shape as Edge);
    }

    throw new BuildError(
      `helix: source shape must be a face or edge, got '${shape.getType()}'.`,
    );
  }

  override getType(): string {
    return 'helix';
  }

  override getDependencies(): SceneObject[] {
    return [this.source];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const newSource = (remap.get(this.source) ?? this.source) as AxisObjectBase | SceneObject;
    const copy = new Helix(newSource);
    copy._pitch = this._pitch;
    copy._turns = this._turns;
    copy._startOffset = this._startOffset;
    copy._endOffset = this._endOffset;
    copy._height = this._height;
    copy._radius = this._radius;
    copy._endRadius = this._endRadius;
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof Helix)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (!this.source.compareTo(other.source)) {
      return false;
    }
    return this._pitch === other._pitch
      && this._turns === other._turns
      && this._startOffset === other._startOffset
      && this._endOffset === other._endOffset
      && this._height === other._height
      && this._radius === other._radius
      && this._endRadius === other._endRadius;
  }

  serialize() {
    return {
      source: this.source.serialize(),
      pitch: this._pitch,
      turns: this._turns,
      startOffset: this._startOffset,
      endOffset: this._endOffset,
      height: this._height,
      radius: this._radius,
      endRadius: this._endRadius,
    };
  }
}
