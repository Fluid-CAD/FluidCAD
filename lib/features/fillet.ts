import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge, Shape, Solid } from "../common/shapes.js";
import { SelectSceneObject } from "./select.js";
import { FusionScope } from "./extrude-options.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Explorer } from "../oc/explorer.js";

export class Fillet extends SceneObject {
  private _targetEdges: SceneObject | null = null;

  constructor(private radius: number) {
    super();
  }

  target(selection: SceneObject): this {
    this._targetEdges = selection;
    return this;
  }

  get targetEdges(): SceneObject {
    return this._targetEdges;
  }

  build(context: BuildSceneObjectContext) {
    let selection: SceneObject = this.targetEdges;

    let sceneObjects: Map<SceneObject, Shape[]>;

    sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of context.getSceneObjects()) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      if (shapes.length === 0) {
        continue;
      }

      sceneObjects.set(obj, shapes);
    }

    const { addedShapes, removedShapes } = this.doBuild(sceneObjects, selection);

    for (const item of removedShapes) {
      item.owner.removeShape(item.shape, this);
    }

    this.addShapes(addedShapes);
  }

  doBuild(sceneObjectsMap: Map<SceneObject, Shape[]>,
    selection: SceneObject) {
    const addedShapes: Shape[] = [];
    const removedShapes: { shape: Shape, owner: SceneObject }[] = [];

    const allEdgeShapes = selection.getShapes();

    let edges: Edge[] = [];
    for (const shape of allEdgeShapes) {
      if (shape.isEdge()) {
        edges.push(shape as Edge);
      } else {
        edges.push(...Explorer.findEdgesWrapped(shape));
      }
    }

    console.log('Fillet: Target edges total count:', edges.length);
    console.log('Fillet: Scene objects count:', sceneObjectsMap.size);

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
        const newShape = FilletOps.makeFillet(solid, targetEdges, this.radius);

        const obj = sceneShapeObjectMap.get(shape);
        removedShapes.push({ shape: solid, owner: obj });

        const subShapes = Explorer.findSolidsWrapped(newShape);
        for (const subShape of subShapes) {
          addedShapes.push(subShape);
        }
      } catch {
        console.error("Fillet: Failed to create fillet.");
        continue;
      }
    }

    const shapes = selection.getShapes();
    for (const shape of shapes) {
      removedShapes.push({ shape, owner: selection });
    }

    return { addedShapes, removedShapes };
  }

  override getDependencies(): SceneObject[] {
    return this.targetEdges ? [this.targetEdges] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Fillet(this.radius);
    if (this.targetEdges) {
      copy.target(remap.get(this.targetEdges) || this.targetEdges);
    }
    return copy;
  }

  compareTo(other: Fillet): boolean {
    if (!(other instanceof Fillet)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.radius !== other.radius) {
      return false;
    }

    if (!this.targetEdges.compareTo(other.targetEdges)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "fillet";
  }

  serialize() {
    return {
      edges: this.targetEdges.serialize(),
      radius: this.radius
    }
  }
}
