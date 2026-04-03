import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { ExtrudeOptions } from "./extrude-options.js";
import { Extrudable } from "../helpers/types.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { LazyVertex } from "./lazy-vertex.js";
import { ICut } from "../core/interfaces.js";
import { Point2DLike } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { normalizePoint2D } from "../helpers/normalize.js";
import { FaceOps } from "../oc/face-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Point } from "../math/point.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ShapeFilter } from "../filters/filter.js";

export interface CutOptions extends ExtrudeOptions { }

export abstract class CutBase extends SceneObject implements ICut {
  protected _extrudable: Extrudable | null = null;
  protected _draft?: number | [number, number];
  protected _endOffset?: number;
  protected _picking: boolean = false;
  protected _pickPoints: LazyVertex[] = [];

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

  removeMetaShapes(removedBy: SceneObject): void {
    for (const shape of this.getAddedShapes()) {
      if (shape.isMetaShape()) {
        this.removeShape(shape, removedBy);
      }
    }
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

  /**
   * Classifies edges and faces from cleaned result shapes by comparing with
   * original stock shapes. Edges/faces not present in stock are "section" geometry
   * created by the cut. Section edges are further classified by signed distance
   * from the cut plane into start, end, and internal groups.
   */
  protected classifyCutResult(
    stockShapes: Shape[],
    cleanedShapes: Shape[],
    plane: Plane,
    cutDistance: number,
  ) {
    // Collect stock edge midpoints for geometric comparison
    const stockEdgeMidpoints: Point[] = [];

    for (const stock of stockShapes) {
      const edges = Explorer.findEdgesWrapped(stock);
      for (const edge of edges) {
        stockEdgeMidpoints.push(EdgeOps.getEdgeMidPoint(edge));
      }
    }

    const tolerance = 1e-6;
    const isStockEdge = (edge: Edge): boolean => {
      const mid = EdgeOps.getEdgeMidPoint(edge);
      return stockEdgeMidpoints.some(sm =>
        Math.abs(mid.x - sm.x) < tolerance &&
        Math.abs(mid.y - sm.y) < tolerance &&
        Math.abs(mid.z - sm.z) < tolerance
      );
    };

    // Find section edges from cleaned result (edges not in stock)
    const sectionEdges: Edge[] = [];
    const sectionEdgeSet = new Set<Edge>();

    for (const shape of cleanedShapes) {
      const edges = Explorer.findEdgesWrapped(shape);
      for (const edge of edges) {
        if (!isStockEdge(edge)) {
          sectionEdges.push(edge);
          sectionEdgeSet.add(edge);
        }
      }
    }

    // Internal faces: faces where ALL edges are section edges (not from stock).
    // Modified stock faces (e.g., top face with holes) still have stock edges
    // on their outer boundary, so they are correctly excluded.
    const internalFaces: Face[] = [];

    for (const shape of cleanedShapes) {
      const faces = Explorer.findFacesWrapped(shape);
      for (const f of faces) {
        const faceEdges = (f as Face).getEdges();
        if (faceEdges.length > 0 && faceEdges.every(e => !isStockEdge(e))) {
          internalFaces.push(f as Face);
        }
      }
    }

    // Classify section edges by signed distance from cut plane
    const startEdges: Edge[] = [];
    const endEdges: Edge[] = [];
    const internalEdges: Edge[] = [];

    if (plane && sectionEdges.length > 0) {
      const isThroughAll = cutDistance === 0;

      const dists = sectionEdges.map(edge => ({
        edge,
        d: plane.signedDistanceToPoint(EdgeOps.getEdgeMidPoint(edge))
      }));

      const startDist = isThroughAll ? Math.max(...dists.map(e => e.d)) : 0;
      const endDist = isThroughAll ? Math.min(...dists.map(e => e.d)) : -cutDistance;

      const distTolerance = 1e-4;
      for (const { edge, d } of dists) {
        if (Math.abs(d - startDist) < distTolerance) {
          startEdges.push(edge);
        } else if (Math.abs(d - endDist) < distTolerance) {
          endEdges.push(edge);
        } else {
          internalEdges.push(edge);
        }
      }
    }

    this.setState('section-edges', sectionEdges);
    this.setState('start-edges', startEdges);
    this.setState('end-edges', endEdges);
    this.setState('internal-edges', internalEdges);
    this.setState('internal-faces', internalFaces);
  }

  protected syncWith(other: CutBase) {
    this._draft = other._draft;
    this._endOffset = other._endOffset;
    this._fusionScope = other.getFusionScope()
    this._picking = other._picking;
    this._pickPoints = other._pickPoints;
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

  startEdges(...args: (number | EdgeFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('start-edges', args);
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const edges = this.getState('start-edges') as Edge[] || [];
        return this.resolveShapes(edges, args);
      });
  }

  endEdges(...args: (number | EdgeFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('end-edges', args);
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const edges = this.getState('end-edges') as Edge[] || [];
        return this.resolveShapes(edges, args);
      });
  }

  internalEdges(...args: (number | EdgeFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('internal-edges', args);
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const edges = this.getState('internal-edges') as Edge[] || [];
        return this.resolveShapes(edges, args);
      });
  }

  internalFaces(...args: (number | FaceFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('internal-faces', args);
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const faces = this.getState('internal-faces') as Face[] || [];
        return this.resolveShapes(faces, args);
      });
  }

  private buildSuffix(prefix: string, args: any[]): string {
    if (args.length === 0) {
      return prefix;
    }
    const key = args.map(a => typeof a === 'number' ? a : 'f').join('-');
    return `${prefix}-${key}`;
  }

  private resolveShapes<T extends Shape>(shapes: T[], args: (number | FilterBuilderBase<T>)[]): T[] {
    if (args.length === 0) {
      return shapes;
    }

    if (args.every(a => typeof a === 'number')) {
      const indices = args as number[];
      return indices.filter(i => i >= 0 && i < shapes.length).map(i => shapes[i]);
    }

    const filters = args.filter(a => a instanceof FilterBuilderBase) as FilterBuilderBase<T>[];
    return new ShapeFilter(shapes as any, ...filters).apply() as T[];
  }

  getType(): string {
    return "cut";
  }
}
