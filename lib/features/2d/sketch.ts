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
import { isReferenceProducer } from "./solved/reference.js";
import { isMacroProducer } from "./solved/macros/finalize.js";

export class Sketch extends SceneObject implements Extrudable {

  private _solver: SketchSolverContext | null;
  private _solveDone = false;

  constructor(public planeObj: PlaneObjectBase) {
    super();
    this._solver = new SketchSolverContext();
  }

  /** Always true since P7 — kept for callers that still branch on it. */
  isSolvedMode(): boolean {
    return true;
  }

  solver(): SketchSolverContext | null {
    return this._solver;
  }

  /**
   * The one solve of the render pass. Triggered by the sketch's own build
   * (or defensively by the first solved child's) — the sketch callback has
   * fully executed by then, so the solver system holds the complete
   * statement graph. Stores the serializable snapshot in state so cached
   * re-renders and rollbacks keep serving it.
   *
   * P6 sequencing: reference producers (project/intersect) run their OCCT
   * compute FIRST and register their outputs as fixed entities — their
   * geometry only exists at build time, unlike statement-time entities.
   * Constraints that target them resolve right after, then the solve runs
   * over the complete system.
   */
  ensureSolvedForBuild(): void {
    if (this._solveDone || !this._solver) {
      return;
    }
    this._solveDone = true;
    for (const child of this.getChildren()) {
      // Macro shapes register their sub-entities + internal rows now — the
      // callback has executed, so chained modifiers (.radius/.centered) are
      // final. Like prepare, finalize stashes its own error for the child's
      // build slot rather than aborting the solve.
      if (isMacroProducer(child)) {
        child.finalizeMacro();
      }
      if (isReferenceProducer(child)) {
        // prepare caches its own error for the child's build slot — a failed
        // projection must not abort the sketch's solve.
        child.prepareReferences();
      }
    }
    this._solver.resolveDeferredConstraints();
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

  build(context?: BuildSceneObjectContext) {
    // Statements registered during module evaluation, so the graph is
    // complete here even before any child builds — and an empty solved
    // sketch (no children to trigger the solve) still stores its snapshot,
    // which carries the datums the UI renders and picks.
    this.ensureSolvedForBuild();
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
    return new Sketch(planeObj);
  }

  compareTo(other: Sketch): boolean {
    if (!(other instanceof Sketch)) {
      return false;
    }

    if (!super.compareTo(other)) {
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

  getType(): string {
    return "sketch";
  }

  serialize(scope?: Set<SceneObject>) {
    const plane = this.getPlane();
    if (!plane) {
      // The plane could not be built (e.g. a sketch on a non-planar face); the
      // plane object already carries the real error. Emit a benign payload so
      // this sketch doesn't crash serialization with a null dereference.
      return { plane: this.planeObj.serialize(), solvedMode: true, solver: this.getState('solver-system') ?? null };
    }
    // The SketchSolverSystem snapshot (entities/constraints/params/
    // diagnostics) — the UI's read model (P3) and drag client seed (P4).
    return {
      plane: this.planeObj.serialize(),
      solvedMode: true,
      solver: this.getState('solver-system') ?? null,
    };
  }

  override toString(): string {
    return `Sketch`;
  }
}
