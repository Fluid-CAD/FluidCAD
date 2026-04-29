import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ShellOps } from "../oc/shell-ops.js";
import { SelectSceneObject } from "./select.js";
import { Face, Shape, Solid, Edge } from "../common/shapes.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { FaceQuery } from "../oc/face-query.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { Matrix4 } from "../math/matrix4.js";
import { IShell } from "../core/interfaces.js";
import { requireShapes } from "../common/operand-check.js";

export class Shell extends SceneObject implements IShell {

  private _faceSelections: SelectSceneObject[] = [];

  constructor(private thickness: number, faceSelections?: SelectSceneObject[]) {
    super();
    this._faceSelections = faceSelections ?? [];
  }

  get faceSelections(): SelectSceneObject[] {
    return this._faceSelections;
  }

  override validate() {
    for (let i = 0; i < this._faceSelections.length; i++) {
      requireShapes(this._faceSelections[i], `face selection ${i + 1}`, "shell");
    }
  }

  build(context: BuildSceneObjectContext): void {
    const shapeObjMap = new Map<Shape, SceneObject>();
    for (const obj of context.getSceneObjects()) {
      if (obj.id === this.parentId) {
        continue;
      }

      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      for (const shape of shapes) {
        shapeObjMap.set(shape, obj);
      }
    }

    if (!shapeObjMap.size) {
      return;
    }

    const allFaceShapes: Shape[] = [];
    for (const sel of this.faceSelections) {
      allFaceShapes.push(...sel.getShapes());
    }
    const faces = allFaceShapes as Face[];

    const newShapes: Shape[] = [];
    const allTargetShapes = Array.from(shapeObjMap.keys());

    for (const shape of allTargetShapes) {
      const solid = shape as Solid;
      const targetFaces = faces.filter(f => solid.hasFace(f.getShape()));
      if (!targetFaces.length) {
        continue;
      }

      try {
        const newShape = ShellOps.makeThickSolid(shape, targetFaces, this.thickness);
        newShapes.push(newShape);

        const originalObj = shapeObjMap.get(shape);
        originalObj.removeShape(shape, this);
      } catch {
        newShapes.push(shape);
        console.warn("Shell: Failed to create thick solid.");
      }
    }

    for (const sel of this.faceSelections) {
      sel.removeShapes(this);
    }

    this.addShapes(newShapes);

    // Classify internal faces/edges: faces and edges in the shelled result
    // that were not in the original stock are internal (inner walls).
    // Edges on the plane of the removed face selection are excluded from
    // internal edges since they form the opening rim, not inner walls.
    const tolerance = 1e-6;
    const stockEdgeMidpoints: Point[] = [];
    for (const shape of allTargetShapes) {
      for (const edge of Explorer.findEdgesWrapped(shape)) {
        stockEdgeMidpoints.push(EdgeOps.getEdgeMidPoint(edge));
      }
    }

    // Collect planes from the face selection to exclude opening rim edges
    const selectionPlanes: Plane[] = [];
    for (const face of faces) {
      try {
        selectionPlanes.push(FaceQuery.getSurfacePlane(face));
      } catch {
        // Non-planar face — skip
      }
    }

    const isStockEdge = (edge: Edge): boolean => {
      const mid = EdgeOps.getEdgeMidPoint(edge);
      return stockEdgeMidpoints.some(sm =>
        Math.abs(mid.x - sm.x) < tolerance &&
        Math.abs(mid.y - sm.y) < tolerance &&
        Math.abs(mid.z - sm.z) < tolerance
      );
    };

    const isOnSelectionPlane = (edge: Edge): boolean => {
      const mid = EdgeOps.getEdgeMidPoint(edge);
      return selectionPlanes.some(p =>
        Math.abs(p.signedDistanceToPoint(mid)) < tolerance
      );
    };

    const internalFaces: Face[] = [];
    const internalEdges: Edge[] = [];

    for (const shape of newShapes) {
      const resultFaces = Explorer.findFacesWrapped(shape);
      for (const f of resultFaces) {
        const faceEdges = (f as Face).getEdges();
        if (faceEdges.length > 0 && faceEdges.every(e => !isStockEdge(e))) {
          internalFaces.push(f as Face);
        }
      }

      const edges = Explorer.findEdgesWrapped(shape);
      for (const edge of edges) {
        if (!isStockEdge(edge) && !isOnSelectionPlane(edge)) {
          internalEdges.push(edge);
        }
      }
    }

    this.setState('internal-faces', internalFaces);
    this.setState('internal-edges', internalEdges);
  }

  internalFaces(...args: (number | FaceFilterBuilder)[]): SceneObject {
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

  internalEdges(...args: (number | EdgeFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('internal-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = parent.getState('internal-edges') as Edge[] || [];
        const transform = parent.getTransform();
        const originalEdges = transform
          ? (this.getState('internal-edges') as Edge[] || [])
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges);
      }, this);
  }

  private buildSuffix(prefix: string, args: any[]): string {
    if (args.length === 0) {
      return prefix;
    }
    const key = args.map(a => typeof a === 'number' ? a : 'f').join('-');
    return `${prefix}-${key}`;
  }

  private resolveEdges(shapes: Edge[], args: (number | EdgeFilterBuilder)[],
                       transform: Matrix4 = null, originalShapes: Edge[] = null): Edge[] {
    if (args.length === 0) {
      return shapes;
    }

    if (args.every(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new EdgeFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as Edge[];
    }

    let filters = args.filter(a => a instanceof EdgeFilterBuilder) as EdgeFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
    }
    return new ShapeFilter(shapes as any, ...filters).apply() as Edge[];
  }

  private resolveFaces(shapes: Face[], args: (number | FaceFilterBuilder)[],
                       transform: Matrix4 = null, originalShapes: Face[] = null): Face[] {
    if (args.length === 0) {
      return shapes;
    }

    if (args.every(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new FaceFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as Face[];
    }

    let filters = args.filter(a => a instanceof FaceFilterBuilder) as FaceFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
    }
    return new ShapeFilter(shapes as any, ...filters).apply() as Face[];
  }

  compareTo(other: SceneObject): boolean {
    if (!(other instanceof Shell)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.thickness !== other.thickness) {
      return false;
    }

    if (this._faceSelections.length !== other._faceSelections.length) {
      return false;
    }
    for (let i = 0; i < this._faceSelections.length; i++) {
      if (!this._faceSelections[i].compareTo(other._faceSelections[i])) {
        return false;
      }
    }

    return true;
  }

  override getDependencies(): SceneObject[] {
    return [...this._faceSelections];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const faceSelections = this._faceSelections.map(
      sel => (remap.get(sel) || sel) as SelectSceneObject
    );
    return new Shell(this.thickness, faceSelections.length > 0 ? faceSelections : undefined);
  }

  getType(): string {
    return 'shell';
  }

  serialize() {
    return {
      thickness: this.thickness
    }
  }
}
