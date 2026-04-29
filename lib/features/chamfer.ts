import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge, Face, Shape, Solid } from "../common/shapes.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { ColorTransfer } from "../oc/color-transfer.js";
import { requireShapes } from "../common/operand-check.js";

export class Chamfer extends SceneObject {
  private _selections: SceneObject[] = [];

  constructor(private distance: number, private distance2: number, private isAngle: boolean = false, ...selections: SceneObject[]) {
    super();
    this._selections = selections;
  }

  get selections(): SceneObject[] {
    return this._selections;
  }

  override validate() {
    for (let i = 0; i < this._selections.length; i++) {
      requireShapes(this._selections[i], `edge selection ${i + 1}`, "chamfer");
    }
  }

  build(context: BuildSceneObjectContext): void {
    let sceneObjects: Map<SceneObject, Shape[]>;

    sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of context.getSceneObjects()) {
      const shapes = obj.getShapes({}, 'solid');
      if (shapes.length) {
        sceneObjects.set(obj, shapes);
      }
    }

    let edges: Edge[] = [];
    for (const selection of this.selections) {
      const allEdgeShapes = selection.getShapes();
      for (const shape of allEdgeShapes) {
        if (shape.isEdge()) {
          edges.push(shape as Edge);
        } else {
          edges.push(...Explorer.findEdgesWrapped(shape));
        }
      }
    }

    const newShapes = [];

    const shapeObjectMap = new Map<Shape, SceneObject>();
    for (const [obj, shapes] of sceneObjects) {
      if (obj.id === this.parentId) {
        continue;
      }

      for (const shape of shapes) {
        console.log('Chamfer: Mapping shape to object:', shape.getType(), obj.id);
        shapeObjectMap.set(shape, obj);
      }
    }

    const allTargetShapes = Array.from(shapeObjectMap.keys());
    console.log('Chamfer: All target shapes count:', allTargetShapes.length);
    console.log('Fillet: Target shapes count:', allTargetShapes.length);

    for (const shape of allTargetShapes) {
      const solid = shape as Solid;
      console.log('Chamfer: Processing solid:', solid.getType(), solid.id);
      const targetEdges = edges.filter(e => solid.hasEdge(e.getShape()));
      console.log('Fillet: Target edges count:', targetEdges.length);
      if (!targetEdges.length) {
        continue;
      }

      edges = edges.filter(e => !targetEdges.includes(e));

      try {
        let preCleanSolids: Solid[];
        if (!this.distance2) {
          preCleanSolids = FilletOps.makeChamfer(solid, targetEdges, this.distance);
        } else {
          const faces = solid.getFaces();
          const commonFaces: Face[] = [];

          for (const edge of targetEdges) {
            const firstCommonFace = faces.find(f => f.hasEdge(edge.getShape()));
            if (!firstCommonFace) {
              newShapes.push(shape);
              console.error("Chamfer: Failed to find common face for chamfer.");
              continue;
            }
            commonFaces.push(firstCommonFace);
          }

          preCleanSolids = FilletOps.makeChamferTwoDistances(solid, targetEdges, this.distance, this.distance2, commonFaces, this.isAngle);
        }

        const obj = shapeObjectMap.get(shape);
        obj.removeShape(shape, this);

        // Clean each chamfer result and chain colors through the cleanup's
        // UnifySameDomain history so any merged faces keep their colors.
        for (const preClean of preCleanSolids) {
          const cleanup = ShapeOps.cleanShapeWithLineage(preClean);
          ColorTransfer.applyThroughCleanup(preClean, cleanup);
          const cleaned = cleanup.shape as Solid;
          cleanup.dispose();
          newShapes.push(cleaned);
        }
      } catch {
        console.error("Fillet: Failed to create chamfer.");
        continue;
      }
    }

    for (const selection of this.selections) {
      const shapes = selection.getShapes();
      for (const shape of shapes) {
        selection.removeShape(shape, this);
      }
    }

    this.addShapes(newShapes);
  }

  override getDependencies(): SceneObject[] {
    return [...this.selections];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const selections = this.selections.map(s => remap.get(s) || s);
    return new Chamfer(this.distance, this.distance2, this.isAngle, ...selections);
  }

  compareTo(other: SceneObject): boolean {
    if (!(other instanceof Chamfer)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    if (this.distance2 !== other.distance2) {
      return false;
    }

    if (this.isAngle !== other.isAngle) {
      return false;
    }

    if (this.selections.length !== other.selections.length) {
      return false;
    }

    for (let i = 0; i < this.selections.length; i++) {
      if (!this.selections[i].compareTo(other.selections[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "chamfer";
  }

  serialize() {
    return {
      edges: this.selections.map(s => s.serialize()),
      distance: this.distance,
      distance2: this.distance2,
      isAngle: this.isAngle
    }
  }
}
