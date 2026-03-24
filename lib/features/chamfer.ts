import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { SelectSceneObject } from "./select.js";
import { Edge, Face, Shape, Solid } from "../common/shapes.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";

export class Chamfer extends SceneObject {
  private _selection: SceneObject | null = null;

  constructor(private distance: number, private distance2: number, private isAngle: boolean = false, selection?: SceneObject) {
    super();
    this._selection = selection ?? null;
  }

  get selection(): SceneObject {
    return this._selection;
  }

  build(context: BuildSceneObjectContext): void {
    let sceneObjects: Map<SceneObject, Shape[]>;

    sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of context.getSceneObjects()) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      if (shapes.length) {
        sceneObjects.set(obj, shapes);
      }
    }

    const allEdgeShapes = this.selection.getShapes();

    let edges = allEdgeShapes as Edge[];

    const newShapes = [];

    const shapeObjectMap = new Map<Shape, SceneObject>();
    for (const [obj, shapes] of sceneObjects) {
      if (obj.id === this.parentId) {
        continue;
      }

      for (const shape of shapes) {
        shapeObjectMap.set(shape, obj);
      }
    }

    const allTargetShapes = Array.from(shapeObjectMap.keys());
    console.log('Fillet: Target shapes count:', allTargetShapes.length);

    for (const shape of allTargetShapes) {
      const solid = shape as Solid;
      const targetEdges = edges.filter(e => solid.hasEdge(e.getShape()));
      console.log('Fillet: Target edges count:', targetEdges.length);
      if (!targetEdges.length) {
        continue;
      }

      edges = edges.filter(e => !targetEdges.includes(e));

      try {
        let newShape;
        if (!this.distance2) {
          newShape = FilletOps.makeChamfer(solid, targetEdges, this.distance);
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

          newShape = FilletOps.makeChamferTwoDistances(solid, targetEdges, this.distance, this.distance2, commonFaces, this.isAngle);
        }

        const obj = shapeObjectMap.get(shape);
        obj.removeShape(shape, this);

        const subShapes = Explorer.findSolidsWrapped(ShapeOps.cleanShape(newShape));
        for (const subShape of subShapes) {
          newShapes.push(subShape);
        }
      } catch {
        console.error("Fillet: Failed to create chamfer.");
        continue;
      }
    }

    this.selection.removeShapes(this);

    this.addShapes(newShapes);
  }

  override getDependencies(): SceneObject[] {
    return this.selection ? [this.selection] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const selection = this.selection
      ? (remap.get(this.selection) || this.selection)
      : undefined;
    return new Chamfer(this.distance, this.distance2, this.isAngle, selection);
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

    if (!this.selection.compareTo(other.selection)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "chamfer";
  }

  serialize() {
    return {
      edges: this.selection.serialize(),
      distance: this.distance,
      distance2: this.distance2,
      isAngle: this.isAngle
    }
  }
}
