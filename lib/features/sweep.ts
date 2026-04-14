import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { SweepOps } from "../oc/sweep-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ExtrudeBase } from "./extrude-base.js";
import { ISweep } from "../core/interfaces.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";

export class Sweep extends ExtrudeBase implements ISweep {
  private _path: SceneObject;

  constructor(
    path: SceneObject,
    extrudable?: Extrudable,
  ) {
    super(extrudable);
    this._path = path;
  }

  get path(): SceneObject {
    return this._path;
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    // Extract spine wire from path
    const spineWire = this.getSpineWire(this._path);

    // Extract profile faces from extrudable
    const profileFaces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill());

    if (profileFaces.length === 0) {
      throw new Error("Could not extract profile faces from extrudable.");
    }

    // Perform sweep
    const sweepResult = SweepOps.makeSweep(spineWire, profileFaces);
    const newShapes = sweepResult.solids;

    // Classify faces using FirstShape/LastShape from the OC result
    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];

    const firstShapeFromOC = sweepResult.firstShape;
    const lastShapeFromOC = sweepResult.lastShape;

    for (const shape of newShapes) {
      const shapeFaces = Explorer.findFacesWrapped(shape);
      for (const f of shapeFaces) {
        if (firstShapeFromOC && f.getShape().IsSame(firstShapeFromOC)) {
          startFaces.push(f as Face);
        } else if (lastShapeFromOC && f.getShape().IsSame(lastShapeFromOC)) {
          endFaces.push(f as Face);
        } else {
          sideFaces.push(f as Face);
        }
      }
    }

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', sideFaces);

    // Remove consumed input shapes
    this.extrudable.removeShapes(this);
    this._path.removeShapes(this);

    // Handle boolean operation based on operation mode
    if (this._operationMode === 'remove') {
      const scope = this.resolveFusionScope(context.getSceneObjects());
      cutWithSceneObjects(scope, newShapes, plane, 0, this);
      return;
    }

    const sceneObjects = this.resolveFusionScope(context.getSceneObjects());

    if (sceneObjects.length === 0) {
      this.addShapes(newShapes);
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, newShapes);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (modifiedShape.object) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(fusionResult.newShapes);
  }

  private getSpineWire(pathObj: SceneObject): Wire {
    const shapes = pathObj.getShapes({ excludeMeta: false });

    const edges = shapes.flatMap(s => s.getSubShapes('edge')) as Edge[];
    console.log(`Sweep: Extracted ${edges.length} edges from path object for spine wire.`);

    return WireOps.makeWireFromEdges(edges);
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.extrudable) {
      deps.push(this.extrudable);
    }
    if (this._path) {
      deps.push(this._path);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    const path = remap.get(this._path) || this._path;
    return new Sweep(path, extrudable).syncWith(this);
  }

  compareTo(other: Sweep): boolean {
    if (!(other instanceof Sweep)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this._path.compareTo(other._path)) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "sweep";
  }

  serialize() {
    return {
      path: this._path.serialize(),
      extrudable: this.extrudable.serialize(),
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      ...this.serializePickFields(),
    };
  }
}
