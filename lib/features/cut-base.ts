import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ExtrudeThroughAll } from "./infinite-extrude.js";
import { Shape, Solid } from "../common/shapes.js";
import { ExtrudeOptions, FusionScope } from "./extrude-options.js";
import { Sketch } from "./2d/sketch.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { Extruder } from "./simple-extruder.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Extrudable } from "../helpers/types.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Edge } from "../common/edge.js";

export interface CutOptions extends ExtrudeOptions { }

export abstract class CutBase extends SceneObject {
  protected _extrudable: Extrudable | null = null;
  protected _draft?: number | [number, number];
  protected _endOffset?: number;
  protected _fusionScope?: FusionScope;

  constructor() {
    super();
  }

  target(extrudable: Extrudable): this {
    this._extrudable = extrudable;
    return this;
  }

  get extrudable(): Extrudable {
    return this._extrudable;
  }

  draft(value: number | [number, number]): this {
    this._draft = value;
    return this;
  }

  endOffset(value: number): this {
    this._endOffset = value;
    return this;
  }

  fuse(value: FusionScope): this {
    this._fusionScope = value;
    return this;
  }

  getDraft(): [number, number] {
    const draft = this._draft;
    if (!draft) {
      return null;
    }

    return draft instanceof Array ? draft : [draft, draft];
  }

  getEndOffset(): number | undefined {
    return this._endOffset;
  }

  getFusionScope(): FusionScope | undefined {
    return this._fusionScope || 'all';
  }

  protected syncWith(other: CutBase) {
    this._draft = other._draft;
    this._endOffset = other._endOffset;
    this._fusionScope = other._fusionScope;
    return this;
  }

  compareTo(other: CutBase): boolean {
    if (!super.compareTo(other)) {
      return false;
    }

    if (this._fusionScope !== other._fusionScope
      || this._endOffset !== other._endOffset) {
      return false;
    }

    let thisDraft = this._draft || [0, 0];
    let otherDraft = other._draft || [0, 0];

    thisDraft = this._draft instanceof Array ? this._draft : [this._draft, this._draft];
    otherDraft = other._draft instanceof Array ? other._draft : [other._draft, other._draft];

    if (thisDraft[0] !== otherDraft[0] || thisDraft[1] !== otherDraft[1]) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "cut";
  }
}
