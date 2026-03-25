import { SceneObject } from "../common/scene-object.js";
import { ExtrudeOptions, FusionScope } from "./extrude-options.js";
import { Extrudable } from "../helpers/types.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Edge } from "../common/edge.js";
import { ICut } from "../core/interfaces.js";

export interface CutOptions extends ExtrudeOptions { }

export abstract class CutBase extends SceneObject implements ICut {
  protected _extrudable: Extrudable | null = null;
  protected _draft?: number | [number, number];
  protected _endOffset?: number;
  protected _fusionScope?: FusionScope;

  constructor(extrudable?: Extrudable) {
    super();
    this._extrudable = extrudable ?? null;
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

  internalEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `internal-edges-${indices.join('-')}` : 'internal-edges';
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const edges = this.getState('internal-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  getType(): string {
    return "cut";
  }
}
