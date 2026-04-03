import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ShellOps } from "../oc/shell-ops.js";
import { SelectSceneObject } from "./select.js";
import { Face, Shape, Solid, Edge } from "../common/shapes.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { FaceQuery } from "../oc/face-query.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ShapeFilter } from "../filters/filter.js";
import { IShell } from "../core/interfaces.js";

export class Shell extends SceneObject implements IShell {

  private _faceSelection: SelectSceneObject | null = null;

  constructor(private thickness: number, faceSelection?: SelectSceneObject) {
    super();
    this._faceSelection = faceSelection ?? null;
  }

  get faceSelection(): SelectSceneObject {
    return this._faceSelection;
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

    const allFaceShapes = this.faceSelection.getShapes();
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

    this.faceSelection.removeShapes(this);

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
    return new LazySceneObject(`${this.generateUniqueName(suffix)}`,
      () => {
        const faces = this.getState('internal-faces') as Face[] || [];
        return this.resolveShapes(faces, args);
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

    if (!this.faceSelection.compareTo(other.faceSelection)) {
      return false;
    }

    return true;
  }

  override getDependencies(): SceneObject[] {
    return this.faceSelection ? [this.faceSelection] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const faceSelection = this.faceSelection
      ? (remap.get(this.faceSelection) || this.faceSelection) as SelectSceneObject
      : undefined;
    return new Shell(this.thickness, faceSelection);
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
