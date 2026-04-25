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
import { ThinFaceMaker } from "../oc/thin-face-maker.js";

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
    const p = context.getProfiler();
    const plane = this.extrudable.getPlane();

    const pickedFaces = p.record('Resolve picked faces', () => this.resolvePickedFaces(plane));
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    // Extract spine wire from path
    const spineWire = p.record('Get spine wire', () => this.getSpineWire(this._path));

    // Extract profile faces from extrudable
    let profileFaces = pickedFaces ?? p.record('Resolve faces', () => FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill()));
    let inwardEdges: Edge[] | undefined;
    let outwardEdges: Edge[] | undefined;

    if (this.isThin()) {
      const thinResult = p.record('Make thin faces', () => ThinFaceMaker.make(this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1]));
      profileFaces = thinResult.faces;
      inwardEdges = thinResult.inwardEdges;
      outwardEdges = thinResult.outwardEdges;
    }

    if (profileFaces.length === 0) {
      throw new Error("Could not extract profile faces from extrudable.");
    }

    // Perform sweep
    const sweepResult = p.record('Make sweep', () => SweepOps.makeSweep(spineWire, profileFaces));
    const newShapes = sweepResult.solids;

    // Classify faces using FirstShape/LastShape from the OC result
    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    let sideFaces: Face[] = [];

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

    let internalFaces: Face[] = [];
    let capFaces: Face[] = [];

    if (inwardEdges && inwardEdges.length > 0) {
      const result = this.reclassifyThinFaces(
        sideFaces, startFaces, plane, inwardEdges, outwardEdges || []
      );
      sideFaces = result.sideFaces;
      internalFaces = result.internalFaces;
      capFaces = result.capFaces;
    } else {
      const innerWireEdges: Edge[] = [];
      for (const sf of startFaces) {
        for (const wire of sf.getWires()) {
          if (!wire.isCW(plane.normal)) {
            for (const edge of wire.getEdges()) {
              innerWireEdges.push(edge);
            }
          }
        }
      }

      if (innerWireEdges.length > 0) {
        const remaining: Face[] = [];
        for (const f of sideFaces) {
          const isInternal = f.getEdges().some(fe =>
            innerWireEdges.some(iwe => fe.getShape().IsPartner(iwe.getShape()))
          );
          if (isInternal) {
            internalFaces.push(f);
          } else {
            remaining.push(f);
          }
        }
        sideFaces = remaining;
      }
    }

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', sideFaces);
    this.setState('internal-faces', internalFaces);
    this.setState('cap-faces', capFaces);

    // Remove consumed input shapes
    this.extrudable.removeShapes(this);
    this._path.removeShapes(this);

    // Handle boolean operation based on operation mode
    if (this._operationMode === 'remove') {
      const scope = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));
      p.record('Cut with scene objects', () => {
        cutWithSceneObjects(scope, newShapes, plane, 0, this, { recordHistoryFor: this });
      });
      this.setFinalShapes(this.getShapes());
      return;
    }

    const sceneObjects = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));

    if (sceneObjects.length === 0) {
      this.addShapes(newShapes);
      this.recordShapeFacesAndEdgesAsAdditions(newShapes);
      this.classifyExtrudeEdges();
      this.setFinalShapes(this.getShapes());
      return;
    }

    const fusionResult = p.record('Fuse with scene objects', () => fuseWithSceneObjects(sceneObjects, newShapes, {
      recordHistoryFor: this,
    }));

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (modifiedShape.object) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(fusionResult.newShapes);

    if (fusionResult.toolHistory) {
      this.remapClassifiedFaces(fusionResult.toolHistory);
    }
    this.classifyExtrudeEdges();
    this.setFinalShapes(this.getShapes());
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
      thin: this._thin,
      ...this.serializePickFields(),
    };
  }
}
