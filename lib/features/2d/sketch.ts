import { Plane } from "../../math/plane.js";
import { Point2D } from "../../math/point.js";
import { GeometrySceneObject } from "./geometry.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { ShapeFilter } from "../../common/shape.js";
import { Extrudable } from "../../helpers/types.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SketchSolverContext } from "./solved/solver-context.js";

export class Sketch extends SceneObject implements Extrudable {

  private _solvedMode: boolean;
  private _solver: SketchSolverContext | null;
  private _solveDone = false;

  constructor(public planeObj: PlaneObjectBase, solvedMode: boolean = false) {
    super();
    this._solvedMode = solvedMode;
    this._solver = solvedMode ? new SketchSolverContext() : null;
  }

  /** Solved (constraint) mode vs legacy pen mode — set by the third
   * argument of sketch(plane, callback, mode). */
  isSolvedMode(): boolean {
    return this._solvedMode;
  }

  solver(): SketchSolverContext | null {
    return this._solver;
  }

  /**
   * The one solve of the render pass. Triggered by the first solved child's
   * build() — the sketch callback has fully executed by then, so the solver
   * system holds the complete statement graph. Stores the serializable
   * snapshot in state so cached re-renders and rollbacks keep serving it.
   */
  ensureSolvedForBuild(): void {
    if (!this._solvedMode || this._solveDone || !this._solver) {
      return;
    }
    this._solveDone = true;
    const summary = this._solver.ensureSolved();
    this.setState('solver-system', summary.snapshot);
    if (summary.sketchError) {
      this.setError(summary.sketchError);
    }
  }

  isContainer(): boolean {
    return true;
  }

  isExtrudable(): boolean {
    return true;
  }

  getPlane(): Plane {
    return this.planeObj.getPlane();
  }

  getStartPoint(): Point2D {
    const center = this.planeObj.getPlaneCenter();
    if (center) {
      const plane = this.getPlane();
      return plane.worldToLocal(center);
    }

    return new Point2D(0, 0);
  }

  getTangentAt(currentObj: GeometrySceneObject): Point2D {
    const children = this.getChildren();
    const previous = children.slice(0, children.indexOf(currentObj));
    let last = previous[previous.length - 1];
    while (last) {
      if (!(last instanceof GeometrySceneObject)) {
        previous.pop();
        last = previous[previous.length - 1];
        continue;
      }

      const tangent = last.getTangent();
      if (tangent) {
        return tangent;
      }

      previous.pop();
      last = previous[previous.length - 1];
    }

    return new Point2D(1, 0);
  }

  getPositionAt(currentObj: GeometrySceneObject): Point2D {
    const children = this.getChildren() as GeometrySceneObject[];
    if (children.length === 1) {
      return this.getStartPoint();
    }

    const previous = children.slice(0, children.indexOf(currentObj));
    let last = previous[previous.length - 1];
    while (last) {
      const pos = last.getState('current-position') as Point2D;
      if (pos) {
        return pos;
      }

      previous.pop();
      last = previous[previous.length - 1];
    }

    return this.getStartPoint();
  }

  getPreviousPosition(currentObj: GeometrySceneObject, count: number = 1): Point2D {
    const children = this.getChildren() as GeometrySceneObject[];
    const previous = children.slice(0, children.indexOf(currentObj));
    let remaining = count;
    for (let i = previous.length - 1; i >= 0; i--) {
      const pos = previous[i].getState('current-position') as Point2D;
      if (pos) {
        if (remaining === 0) {
          return pos;
        }
        remaining--;
      }
    }
    return this.getStartPoint();
  }

  getPreviousState(currentObj: GeometrySceneObject, count: number = 1): { position: Point2D, tangent: Point2D } {
    const children = this.getChildren() as GeometrySceneObject[];
    const previous = children.slice(0, children.indexOf(currentObj));
    let remaining = count;
    for (let i = previous.length - 1; i >= 0; i--) {
      const pos = previous[i].getState('current-position') as Point2D;
      if (pos) {
        if (remaining === 0) {
          for (let j = i; j >= 0; j--) {
            const prev = previous[j];
            if (!(prev instanceof GeometrySceneObject)) {
              continue;
            }
            const t = prev.getTangent();
            if (t) {
              return { position: pos, tangent: t };
            }
          }
          return { position: pos, tangent: new Point2D(1, 0) };
        }
        remaining--;
      }
    }
    return { position: this.getStartPoint(), tangent: new Point2D(1, 0) };
  }

  getLastPosition(scope?: Set<SceneObject>): Point2D {
    let children = this.getChildren().slice() as GeometrySceneObject[];
    if (scope) {
      children = children.filter(c => scope.has(c));
    }
    if (children.length === 0) {
      return this.getStartPoint();
    }

    while (true) {
      const last = children[children.length - 1];
      if (!last) {
        return this.getStartPoint();
      }

      const pos = last.getState('current-position') as Point2D;
      if (pos) {
        return pos;
      }
      children.pop();
    }
  }

  build(context?: BuildSceneObjectContext) {
    this.setState('tangent', new Point2D(1, 0));
    this.planeObj.removeShapes(this);

    const source = this.getCloneSource();
    const transform = context?.getTransform();

    if (source instanceof Sketch && transform) {
      const sourceChildren = source.getChildren();
      const clonedChildren = this.getChildren();

      for (let i = 0; i < sourceChildren.length; i++) {
        const sourceChild = sourceChildren[i];
        const clonedChild = clonedChildren[i];
        if (!clonedChild) {
          continue;
        }

        const shapes = sourceChild.getAddedShapes();
        const removedShapes = sourceChild.getRemovedShapes();

        for (const shape of shapes) {
          if (shape.isMetaShape() || shape.isGuideShape()) {
            continue;
          }

          const isRemovedBySibling = removedShapes.some(
            s => s.shape === shape && s.removedBy?.parentId === source.id
          );
          if (isRemovedBySibling) {
            continue;
          }

          const transformed = ShapeOps.transform(shape, transform);
          clonedChild.addShape(transformed);
        }
      }
    }
  }

  getEdges(): Edge[] {
    return [...this.getEdgesWithOwner().keys()];
  }

  /** The default filter excludes guides; pass `{ excludeGuide: false }` to
   * index construction geometry too (the tArc-to-edge target resolution). */
  getEdgesWithOwner(filter?: ShapeFilter): Map<Edge, GeometrySceneObject> {
    const children = this.getChildren() as GeometrySceneObject[];
    const result: Map<Edge, GeometrySceneObject> = new Map();

    for (const child of children) {
      // Lazy accessor children (e.g. r.edge('top')) and select statements
      // hold the same Edge instances as the primitive that built them —
      // counting them would reassign ownership and double-count edges.
      if (child.isLazy() || child.isSelection()) {
        continue;
      }

      const shapes = child.getShapes(filter);
      for (const shape of shapes) {
        if (shape instanceof Edge) {
          result.set(shape, child);
        } else if (shape instanceof Wire) {
          // Invariant: sketch features emit individual Edge shapes, never
          // Wires (1 shapeId = 1 edge). Expand defensively but flag it.
          console.warn(`Sketch: child "${child.getType()}" emitted a Wire shape; sketch features must emit individual edges.`);
          for (const edge of shape.getEdges()) {
            result.set(edge, child);
          }
        }
      }
    }

    return result;
  }

  getGeometriesWithOwner(): Map<Edge, GeometrySceneObject> {
    return this.getEdgesWithOwner();
  }

  getGeometries(): Edge[] {
    return this.getEdges();
  }

  override getDependencies(): SceneObject[] {
    return [this.planeObj];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const planeObj = (remap.get(this.planeObj) as PlaneObjectBase) || this.planeObj;
    return new Sketch(planeObj, this._solvedMode);
  }

  compareTo(other: Sketch): boolean {
    if (!(other instanceof Sketch)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this._solvedMode !== other._solvedMode) {
      return false;
    }

    if (this.comparableOrder() !== other.comparableOrder()) {
      return false;
    }

    return true;
  }

  /**
   * Positional identity for the shallow compare — geometry is compared by
   * the callers' child walks, so position is what tells two same-flag
   * sketches apart (e.g. as fusion-scope references). Measured relative to
   * the outermost ancestor (the owning part) rather than absolutely:
   * AssemblyCompare pairs top-level parts by declared identity, so a part
   * moved to a different scene position must still match its counterpart.
   * Top-level sketches have no ancestor and keep their absolute order.
   */
  private comparableOrder(): number {
    let base = 0;
    for (let ancestor = this.getParent(); ancestor; ancestor = ancestor.getParent()) {
      base = ancestor.getOrder();
    }
    return this.getOrder() - base;
  }

  getTangent(scope?: Set<SceneObject>): Point2D {
    let children = this.getChildren()?.slice() as GeometrySceneObject[];
    if (scope) {
      children = children.filter(c => scope.has(c));
    }
    if (children.length === 0) {
      return new Point2D(1, 0);
    }

    let last = children[children.length - 1];
    while (last) {
      if (!(last instanceof GeometrySceneObject)) {
        children.pop();
        last = children[children.length - 1];
        continue;
      }

      const tangent = last.getTangent();
      if (tangent) {
        return tangent;
      }

      children.pop();
      last = children[children.length - 1];
    }

    return new Point2D(1, 0);
  }

  getType(): string {
    return "sketch";
  }

  serialize(scope?: Set<SceneObject>) {
    const plane = this.getPlane();
    if (!plane) {
      // The plane could not be built (e.g. a sketch on a non-planar face); the
      // plane object already carries the real error. Emit a benign payload so
      // this sketch doesn't crash serialization with a null dereference.
      return this._solvedMode
        ? { plane: this.planeObj.serialize(), solvedMode: true, solver: this.getState('solver-system') ?? null }
        : { plane: this.planeObj.serialize() };
    }
    const tangent = this.getTangent(scope);
    const payload = {
      currentPosition: plane.localToWorld(this.getLastPosition(scope)),
      currentTangent: plane.localToWorld(tangent),
      plane: this.planeObj.serialize(),
    };
    if (this._solvedMode) {
      // The SketchSolverSystem snapshot (entities/constraints/params/
      // diagnostics) — the UI's read model (P3) and drag client seed (P4).
      return { ...payload, solvedMode: true, solver: this.getState('solver-system') ?? null };
    }
    return payload;
  }

  override toString(): string {
    return `Sketch`;
  }
}
