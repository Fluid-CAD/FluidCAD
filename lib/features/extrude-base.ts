import { Face } from "../common/face.js";
import { SceneObject } from "../common/scene-object.js";
import { FusionScope } from "./extrude-options.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Extrudable } from "../helpers/types.js";
import { IExtrude } from "../core/interfaces.js";
import { LazyVertex } from "./lazy-vertex.js";
import { Point2DLike } from "../math/point.js";
import { normalizePoint2D } from "../helpers/normalize.js";

export abstract class ExtrudeBase extends SceneObject implements IExtrude {
  protected _extrudable: Extrudable | null = null;
  protected _draft?: number | [number, number];
  protected _endOffset?: number;
  protected _fusionScope?: FusionScope = 'all';
  protected _drill?: boolean = true;
  protected _picking: boolean = false;
  protected _pickPoints: LazyVertex[] = [];

  constructor(extrudable?: Extrudable) {
    super();
    this._extrudable = extrudable ?? null;
  }

  get extrudable(): Extrudable {
    return this._extrudable;
  }

  startFace(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `start-faces-${indices.join('-')}` : 'start-faces';
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const faces = this.getState('start-faces') as Face[] || [];
        if (indices.length === 0) return faces.length > 0 ? [faces[0]] : [];
        return indices.filter(i => i >= 0 && i < faces.length).map(i => faces[i]);
      });
  }

  endFace(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-faces-${indices.join('-')}` : 'end-faces';
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const faces = this.getState('end-faces') as Face[] || [];
        if (indices.length === 0) return faces.length > 0 ? [faces[0]] : [];
        return indices.filter(i => i >= 0 && i < faces.length).map(i => faces[i]);
      });
  }

  startEdge(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `start-edges-${indices.join('-')}` : 'start-edges';
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const faces = this.getState('start-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        if (indices.length === 0) return edges;
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  endEdge(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-edges-${indices.join('-')}` : 'end-edges';
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const faces = this.getState('end-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        if (indices.length === 0) return edges;
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  sideFace(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `side-faces-${indices.join('-')}` : 'side-faces';
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const faces = this.getState('side-faces') as Face[] || [];
        if (indices.length === 0) return faces.length > 0 ? [faces[0]] : [];
        return indices.filter(i => i >= 0 && i < faces.length).map(i => faces[i]);
      });
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

  drill(value: boolean = true): this {
    this._drill = value;
    return this;
  }

  pick(...points: Point2DLike[]): this {
    this._picking = true;
    this._pickPoints = points.map(p => normalizePoint2D(p));
    return this;
  }

  isPicking(): boolean {
    return this._picking;
  }

  getPickPoints(): LazyVertex[] {
    return this._pickPoints;
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

  getDrill(): boolean {
    return this._drill;
  }

  protected syncWith(other: ExtrudeBase) {
    this._draft = other._draft;
    this._endOffset = other._endOffset;
    this._fusionScope = other._fusionScope;
    this._picking = other._picking;
    this._pickPoints = other._pickPoints;
    return this;
  }

  compareTo(other: ExtrudeBase): boolean {
    if (!super.compareTo(other)) {
      return false;
    }

    if (this._fusionScope !== other._fusionScope
      || this._endOffset !== other._endOffset
       || this._drill !== other._drill) {
      return false;
    }

    if (this._picking !== other._picking) {
      return false;
    }

    if (this._pickPoints.length !== other._pickPoints.length) {
      return false;
    }

    for (let i = 0; i < this._pickPoints.length; i++) {
      if (!this._pickPoints[i].compareTo(other._pickPoints[i])) {
        return false;
      }
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
    return "extrude";
  }
}
