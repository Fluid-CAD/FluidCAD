import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge, Shape, Solid } from "../common/shapes.js";
import { SelectSceneObject } from "./select.js";
import { FusionScope } from "./extrude-options.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Explorer } from "../oc/explorer.js";
import { requireShapes } from "../common/operand-check.js";
import { recordModifierHistory } from "../helpers/scene-helpers.js";

export class Fillet extends SceneObject {
  private _targetEdges: SceneObject[] = [];

  constructor(private radius: number, ...selections: SceneObject[]) {
    super();
    this._targetEdges = selections;
  }

  get targetEdges(): SceneObject[] {
    return this._targetEdges;
  }

  override validate() {
    for (let i = 0; i < this._targetEdges.length; i++) {
      requireShapes(this._targetEdges[i], `edge selection ${i + 1}`, "fillet");
    }
  }

  build(context: BuildSceneObjectContext) {
    const selections = this.targetEdges;

    let sceneObjects: Map<SceneObject, Shape[]>;

    sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of context.getSceneObjects()) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      if (shapes.length === 0) {
        continue;
      }

      sceneObjects.set(obj, shapes);
    }

    const { addedShapes, removedShapes } = this.doBuild(sceneObjects, selections);

    for (const item of removedShapes) {
      item.owner.removeShape(item.shape, this);
    }

    this.addShapes(addedShapes);
  }

  doBuild(sceneObjectsMap: Map<SceneObject, Shape[]>,
    selections: SceneObject[]) {
    const addedShapes: Shape[] = [];
    const removedShapes: { shape: Shape, owner: SceneObject }[] = [];

    let edges: Edge[] = [];
    for (const selection of selections) {
      const allEdgeShapes = selection.getShapes();
      for (const shape of allEdgeShapes) {
        if (shape.isEdge()) {
          edges.push(shape as Edge);
        } else {
          edges.push(...Explorer.findEdgesWrapped(shape));
        }
      }
    }

    console.log('Fillet: Target edges total count:', edges.length);
    console.log('Fillet: Scene objects count:', sceneObjectsMap.size);

    if (edges.length === 0) {
      this.setError(
        selections.length === 0
          ? "fillet: no edges selected — nothing was filleted."
          : "fillet: the selection resolved to no edges — nothing was filleted.\n" +
            "Hint: a later operation may have removed the selected edges, or the " +
            "filter matched nothing. Re-select on the final model or widen the filter."
      );
    }

    const sceneShapeObjectMap = new Map<Shape, SceneObject>();

    for (const [obj, shapes] of sceneObjectsMap.entries()) {
      if (obj.id === this.parentId) {
        continue;
      }

      for (const shape of shapes) {
        sceneShapeObjectMap.set(shape, obj);
      }
    }

    const allTargetSceneShapes = Array.from(sceneShapeObjectMap.keys());

    for (const shape of allTargetSceneShapes) {
      const solid = shape as Solid;
      const targetEdges = edges.filter(e => solid.hasEdge(e.getShape()));
      console.log('Fillet: Target edges count:', targetEdges.length);
      if (!targetEdges.length) {
        continue;
      }

      edges = edges.filter(e => !targetEdges.includes(e));

      try {
        const { solids: newSolids, history } = FilletOps.makeFillet(solid, targetEdges, this.radius);

        const obj = sceneShapeObjectMap.get(shape);
        removedShapes.push({ shape: solid, owner: obj });
        if (obj) {
          recordModifierHistory(history, obj, this);
        }

        for (const newSolid of newSolids) {
          addedShapes.push(newSolid);
        }
      } catch {
        // OCCT refused the fillet (radius too large for the adjacent
        // geometry, tangency trouble, …). Keep the original solid in the
        // scene, but surface the failure instead of silently skipping it.
        console.error("Fillet: Failed to create fillet.");
        this.setError(
          "fillet: could not fillet the selected edges — the radius may be " +
          "too large for the adjacent geometry. The solid was left unfilleted."
        );
        continue;
      }
    }

    if (edges.length > 0) {
      this.setError(
        `fillet: ${edges.length} selected edge(s) matched no solid in the scene ` +
        "and were skipped.\n" +
        "Hint: a later operation may have consumed them — re-select on the final model."
      );
    }

    for (const selection of selections) {
      const shapes = selection.getShapes();
      for (const shape of shapes) {
        removedShapes.push({ shape, owner: selection });
      }
    }

    return { addedShapes, removedShapes };
  }

  override getDependencies(): SceneObject[] {
    return [...this.targetEdges];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const selections = this.targetEdges.map(s => remap.get(s) || s);
    return new Fillet(this.radius, ...selections);
  }

  compareTo(other: Fillet): boolean {
    if (!(other instanceof Fillet)) {
      return false;
    }

    if (this.radius !== other.radius) {
      return false;
    }

    if (this.targetEdges.length !== other.targetEdges.length) {
      return false;
    }

    for (let i = 0; i < this.targetEdges.length; i++) {
      if (!this.targetEdges[i].compareTo(other.targetEdges[i])) {
        return false;
      }
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "fillet";
  }

  serialize() {
    return {
      edges: this.targetEdges.map(s => s.serialize()),
      radius: this.radius
    }
  }
}
