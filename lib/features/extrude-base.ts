import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { Extrudable } from "../helpers/types.js";
import { IExtrude } from "../core/interfaces.js";
import { LazyVertex } from "./lazy-vertex.js";
import { Point2DLike } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { normalizePoint2D } from "../helpers/normalize.js";
import { FaceOps } from "../oc/face-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { Matrix4 } from "../math/matrix4.js";
import { EdgeOps } from "../oc/edge-ops.js";

export abstract class ExtrudeBase extends SceneObject implements IExtrude {
  protected _extrudable: Extrudable | null = null;
  protected _draft?: number | [number, number];
  protected _endOffset?: number;
  protected _drill?: boolean = true;
  protected _picking: boolean = false;
  protected _pickPoints: LazyVertex[] = [];
  protected _thin?: [number] | [number, number];

  constructor(extrudable?: Extrudable) {
    super();
    this._extrudable = extrudable ?? null;
  }

  get extrudable(): Extrudable {
    return this._extrudable;
  }

  startFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('start-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('start-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('start-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  endFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('end-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('end-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('end-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  startEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('start-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        if (this._operationMode === 'remove') {
          const edges = parent.getState('start-edges') as Edge[] || [];
          const transform = parent.getTransform();
          const originalEdges = transform
            ? (this.getState('start-edges') as Edge[] || [])
            : null;
          return this.resolveEdges(edges, args, transform, originalEdges);
        }
        const faces = parent.getState('start-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        const transform = parent.getTransform();
        const originalEdges = transform
          ? (this.getState('start-faces') as Face[] || []).flatMap(f => f.getEdges())
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges);
      }, this);
  }

  endEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('end-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        if (this._operationMode === 'remove') {
          const edges = parent.getState('end-edges') as Edge[] || [];
          const transform = parent.getTransform();
          const originalEdges = transform
            ? (this.getState('end-edges') as Edge[] || [])
            : null;
          return this.resolveEdges(edges, args, transform, originalEdges);
        }
        const faces = parent.getState('end-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        const transform = parent.getTransform();
        const originalEdges = transform
          ? (this.getState('end-faces') as Face[] || []).flatMap(f => f.getEdges())
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges);
      }, this);
  }

  sideFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('side-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('side-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('side-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  sideEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('side-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const sideFaces = parent.getState('side-faces') as Face[] || [];
        const startFaces = parent.getState('start-faces') as Face[] || [];
        const endFaces = parent.getState('end-faces') as Face[] || [];
        const excludedEdges = [...startFaces, ...endFaces].flatMap(f => f.getEdges());
        const edges = sideFaces.flatMap(f => f.getEdges())
          .filter(e => !excludedEdges.some(ex => e.getShape().IsSame(ex.getShape())))
          .filter((e, i, arr) => arr.findIndex(o => o.getShape().IsSame(e.getShape())) === i);
        return this.resolveEdges(edges, args);
      }, this);
  }

  /**
   * Returns the section edges created by a cut operation.
   * Only meaningful when operationMode is 'remove'.
   */
  edges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `section-edges-${indices.join('-')}` : 'section-edges';
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = parent.getState('section-edges') as Edge[] || [];
        if (indices.length === 0) {
          return edges;
        }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      }, this);
  }

  internalFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('internal-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('internal-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('internal-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  internalEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('internal-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        if (this._operationMode === 'remove') {
          const edges = parent.getState('internal-edges') as Edge[] || [];
          return this.resolveEdges(edges, args);
        }
        const faces = parent.getState('internal-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        return this.resolveEdges(edges, args);
      }, this);
  }

  capFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('cap-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('cap-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('cap-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  capEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('cap-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('cap-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        return this.resolveEdges(edges, args);
      }, this);
  }

  private buildSuffix(prefix: string, args: any[]): string {
    if (args.length === 0) {
      return prefix;
    }
    const key = args.map(a => typeof a === 'number' ? a : 'f').join('-');
    return `${prefix}-${key}`;
  }

  private resolveFaces<T extends Shape>(shapes: Face[], args: number[] | FaceFilterBuilder[],
    transform: Matrix4 = null,
    originalShapes: Face[] = null): T[] {
    if (args.length === 0) {
      return new ShapeFilter(shapes).apply() as T[];
    }

    if (args.some(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new FaceFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as T[];
    }

    let filters = args as FaceFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
    }
    return new ShapeFilter(shapes, ...filters).apply() as T[];
  }

  private resolveEdges<T extends Shape>(shapes: Edge[], args: number[] | EdgeFilterBuilder[],
    transform: Matrix4 = null,
    originalShapes: Edge[] = null): T[] {
    if (args.length === 0) {
      return new ShapeFilter(shapes).apply() as T[];
    }

    if (args.some(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new EdgeFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as T[];
    }

    let filters = args as EdgeFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
    }
    return new ShapeFilter(shapes, ...filters).apply() as T[];
  }

  draft(value: number | [number, number]): this {
    this._draft = value;
    return this;
  }

  endOffset(value: number): this {
    this._endOffset = value;
    return this;
  }

  drill(value: boolean = true): this {
    this._drill = value;
    return this;
  }

  thin(offset1: number, offset2?: number): this {
    this._thin = offset2 !== undefined ? [offset1, offset2] : [offset1];
    return this;
  }

  isThin(): boolean {
    return this._thin !== undefined;
  }

  getThinOffsets(): [number] | [number, number] | undefined {
    return this._thin;
  }

  protected serializePickFields() {
    const plane = this._extrudable?.getPlane();
    return {
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
      trigger: this.isThin() ? undefined : 'region-picking' as const,
      pickPlane: plane ? {
        origin: plane.origin,
        xDirection: plane.xDirection,
        yDirection: plane.yDirection,
        normal: plane.normal,
      } : undefined,
    };
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

  /**
   * Resolves pick mode: partitions sketch into cells via CellsBuilder,
   * classifies which cells are selected, adds meta shapes for all cells + edges,
   * and returns the selected faces to extrude.
   * Returns null if not in pick mode.
   */
  protected resolvePickedFaces(plane: Plane): Face[] | null {
    if (!this.isPicking()) {
      return null;
    }

    const sketchShapes = this.extrudable.getGeometries();
    const cells = FaceMaker2.getRegions(sketchShapes, plane, false);

    if (cells.length === 0) {
      return [];
    }

    const pickPoints = this.getPickPoints();
    const selectedCells: Face[] = [];

    for (const cell of cells) {
      let isSelected = false;
      let pickPoint: [number, number] | null = null;
      for (const lazyPt of pickPoints) {
        const pt2d = lazyPt.asPoint2D();
        const pt3d = plane.localToWorld(pt2d);
        if (FaceOps.isPointInsideFace(pt3d, cell)) {
          isSelected = true;
          pickPoint = [pt2d.x, pt2d.y];
          break;
        }
      }

      if (isSelected) {
        cell.markAsMetaShape('pick-region-selected');
        cell.metaData = { pickPoint };
        selectedCells.push(cell);
      } else {
        cell.markAsMetaShape('pick-region');
      }

      this.addShape(cell);

      for (const edge of cell.getEdges()) {
        edge.markAsMetaShape('pick-edge');
        this.addShape(edge);
      }
    }

    return selectedCells;
  }

  override clean(allObjects: SceneObject[]): void {
    if (!this.isPicking()) {
      return;
    }

    const lastObject = allObjects[allObjects.length - 1];
    if (lastObject !== this) {
      this.removeMetaShapes(lastObject);
    }
  }

  removeMetaShapes(removedBy: SceneObject): void {
    for (const shape of this.getAddedShapes()) {
      if (shape.isMetaShape()) {
        this.removeShape(shape, removedBy);
      }
    }
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

  getDrill(): boolean {
    return this._drill;
  }

  protected syncWith(other: ExtrudeBase) {
    this._draft = other._draft;
    this._endOffset = other._endOffset;
    this._fusionScope = other._fusionScope;
    this._operationMode = other._operationMode;
    this._symmetric = other._symmetric;
    this._picking = other._picking;
    this._pickPoints = other._pickPoints;
    this._thin = other._thin;
    this._drill = other._drill;
    return this;
  }

  /**
   * Reclassifies faces for thin open-profile extrusions into side, internal, and cap faces.
   * Uses 2D midpoint projection (onto sketch plane) to match reference face edges to
   * the inward/outward wire edges, then IsPartner within the solid to classify faces.
   */
  protected reclassifyThinFaces(
    remainingFaces: Face[],
    referenceFaces: Face[],
    plane: Plane,
    inwardEdges: Edge[],
    outwardEdges: Edge[]
  ): { sideFaces: Face[]; internalFaces: Face[]; capFaces: Face[] } {
    // Project edge midpoints to 2D on the sketch plane for height-independent matching
    const to2D = (edge: Edge) => plane.worldToLocal(EdgeOps.getEdgeMidPointRaw(edge.getShape()));

    const inwardMids = inwardEdges.map(to2D);
    const outwardMids = outwardEdges.map(to2D);

    // Find reference face edges matching inward/outward in 2D
    const solidInwardEdges: Edge[] = [];
    const solidOutwardEdges: Edge[] = [];

    for (const rf of referenceFaces) {
      for (const rfe of rf.getEdges()) {
        const rfeMid = to2D(rfe);
        if (inwardMids.some(mp => rfeMid.distanceTo(mp) < 1e-4)) {
          solidInwardEdges.push(rfe);
        } else if (outwardMids.some(mp => rfeMid.distanceTo(mp) < 1e-4)) {
          solidOutwardEdges.push(rfe);
        }
      }
    }

    // Classify remaining faces using IsPartner within the solid
    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];
    const capFaces: Face[] = [];

    for (const f of remainingFaces) {
      const faceEdges = f.getEdges();
      const isInward = solidInwardEdges.length > 0 && faceEdges.some(fe =>
        solidInwardEdges.some(ie => fe.getShape().IsPartner(ie.getShape()))
      );
      const isOutward = solidOutwardEdges.length > 0 && faceEdges.some(fe =>
        solidOutwardEdges.some(oe => fe.getShape().IsPartner(oe.getShape()))
      );

      if (isInward) {
        internalFaces.push(f);
      } else if (isOutward) {
        sideFaces.push(f);
      } else {
        capFaces.push(f);
      }
    }

    return { sideFaces, internalFaces, capFaces };
  }

  compareTo(other: ExtrudeBase): boolean {
    if (!super.compareTo(other)) {
      return false;
    }

    if (this._endOffset !== other._endOffset
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

    const thisThin = this._thin;
    const otherThin = other._thin;
    if ((thisThin === undefined) !== (otherThin === undefined)) {
      return false;
    }
    if (thisThin && otherThin) {
      if (thisThin.length !== otherThin.length) {
        return false;
      }
      for (let i = 0; i < thisThin.length; i++) {
        if (thisThin[i] !== otherThin[i]) {
          return false;
        }
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
    return this._operationMode === "remove" ? "cut" : "extrude";
  }
}
