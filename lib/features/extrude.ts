import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ExtrudeOptions, MergeScope } from "./extrude-options.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { Sketch } from "./2d/sketch.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { Face } from "../common/face.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Extrudable } from "../helpers/types.js";

export class Extrude extends SceneObject {
  constructor(
    private extrudable: Extrudable,
    public distance: number,
    public options: ExtrudeOptions = {}) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    const sketchShapes = this.extrudable.getGeometries();

    let sceneObjects = context.getSceneObjects();

    if (this.parentId) {
      sceneObjects.filter(so => so.id !== this.parentId);
    }

    console.log("Extrude:: all scene objects for fusion:", sceneObjects);

    const plane = this.extrudable.getPlane();

    console.log("Extrude:: wires to extrude:", sketchShapes);

    const faces = FaceMaker.getFaces(sketchShapes, this.extrudable.getPlane());
    console.log("Extruding faces::", faces);

    const extruder = new Extruder(faces, plane, this.distance, this.options);
    let extrusions = extruder.extrude();

    this.setState('start-faces', extruder.getStartFaces());
    this.setState('end-faces', extruder.getEndFaces());
    this.setState('side-faces', extruder.getSideFaces());

    this.extrudable.removeShapes(this)

    console.log('Extrude: Generated extrusions count:', extrusions.length);

    if (this.options?.mergeScope === 'none' || extrusions.length === 0 || sceneObjects?.length === 0) {
      this.addShapes(extrusions);
      return;
    }

    console.log('::: Extrusions to fuse count:', extrusions.length);

    const fusionResult = fuseWithSceneObjects(sceneObjects, extrusions);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      modifiedShape.object.removeShape(modifiedShape.shape, this)
    }

    this.addShapes(fusionResult.newShapes);
  }

  override clone(): SceneObject[] {
    const extrudableClones = this.extrudable.clone();
    const extrudable = extrudableClones.find(c => c instanceof Sketch) as Sketch;
    console.log("Extrude::clone extrudable clone:", extrudable);
    const extrude = new Extrude(extrudable, this.distance, this.options);
    const r = [...extrudableClones, extrude];
    console.log("Extrude::clone created:", r);
    return r;
  }

  override getFusionScope(): MergeScope {
    return this.options?.mergeScope || 'all';
  }

  getType(): string {
    return 'extrude';
  }

  compareTo(other: Extrude): boolean {
    if (!(other instanceof Extrude)) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    if (JSON.stringify(this.options || {}) !== JSON.stringify(other.options || {})) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'extrude-by-distance';
  }

  private getUniqueName(suffix: string) {
    return `${this.getOrder()}-${this.getUniqueType()}-${suffix}`;
  }

  startFace(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `start-faces-${indices.join('-')}` : 'start-faces';
    return new LazySceneObject(`${this.getUniqueName(suffix)}`,
      () => {
        const faces = this.getState('start-faces') as Face[] || [];
        if (indices.length === 0) return faces.length > 0 ? [faces[0]] : [];
        return indices.filter(i => i >= 0 && i < faces.length).map(i => faces[i]);
      });
  }

  endFace(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-faces-${indices.join('-')}` : 'end-faces';
    return new LazySceneObject(`${this.getUniqueName(suffix)}`,
      () => {
        const faces = this.getState('end-faces') as Face[] || [];
        if (indices.length === 0) return faces.length > 0 ? [faces[0]] : [];
        return indices.filter(i => i >= 0 && i < faces.length).map(i => faces[i]);
      });
  }

  startEdge(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `start-edges-${indices.join('-')}` : 'start-edges';
    return new LazySceneObject(`${this.getUniqueName(suffix)}`,
      () => {
        const faces = this.getState('start-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        if (indices.length === 0) return edges.length > 0 ? [edges[0]] : [];
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  endEdge(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-edges-${indices.join('-')}` : 'end-edges';
    return new LazySceneObject(`${this.getUniqueName(suffix)}`,
      () => {
        const faces = this.getState('end-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        if (indices.length === 0) return edges.length > 0 ? [edges[0]] : [];
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  sideFace(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `side-faces-${indices.join('-')}` : 'side-faces';
    return new LazySceneObject(`${this.getUniqueName(suffix)}`,
      () => {
        const faces = this.getState('side-faces') as Face[] || [];
        if (indices.length === 0) return faces.length > 0 ? [faces[0]] : [];
        return indices.filter(i => i >= 0 && i < faces.length).map(i => faces[i]);
      });
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance: this.distance,
      options: this.options
    }
  }
}
