import { BuildSceneObjectContext } from "../common/scene-object.js";
import { Shape, Solid } from "../common/shapes.js";
import { rad } from "../helpers/math-helpers.js";
import { Plane } from "../math/plane.js";
import { ExtrudeBase } from "./extrude-base.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { Vector3d } from "../math/vector3d.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Face } from "../common/face.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { SceneObject } from "../common/scene-object.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { Extruder } from "./simple-extruder.js";

export class ExtrudeSymmetric extends ExtrudeBase {

  constructor(public distance?: number, extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const sceneObjects = context.getSceneObjects();
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill());
    console.log("Extruding faces:", faces);

    const extruder1 = new Extruder(faces, plane, this.distance / 2, this.getDraft(), this.getEndOffset());
    const extrusions1 = extruder1.extrude();
    const startFaces = extruder1.getStartFaces();
    const sideFaces1 = extruder1.getSideFaces();

    const extruder2 = new Extruder(faces, plane, -this.distance / 2, this.getDraft(), this.getEndOffset());
    const extrusions2 = extruder2.extrude();
    const endFaces = extruder2.getEndFaces();
    const sideFaces2 = extruder2.getSideFaces();

    const all = [...extrusions1, ...extrusions2];
    const { result: extrusions } = BooleanOps.fuse(all);

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', [...sideFaces1, ...sideFaces2]);

    this.extrudable.removeShapes(this);

    if (this.getFusionScope() === 'none' || extrusions.length === 0 || sceneObjects?.length === 0) {
      this.addShapes(extrusions);
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, extrusions);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (!modifiedShape.object) {
        continue;
      }

      modifiedShape.object.removeShape(modifiedShape.shape, this);
    }

    this.addShapes(fusionResult.newShapes);
  }

  private applyDraft(solid: Shape, firstFace: Shape, lastFace: Shape, plane: Plane): Shape {
    const angle: number = this.getDraft()[0]
    return ExtrudeOps.applyDraftOnSideFaces(solid, firstFace, lastFace, plane, rad(angle));
  }

  private doExtrude(shape: Shape, vector: Vector3d) {
    const { solid: rawSolid, firstFace, lastFace } = ExtrudeOps.makePrismFromVec(shape, vector);
    const solid = ShapeOps.cleanShape(rawSolid);

    return { solid, firstFace, lastFace };
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
        if (indices.length === 0) return edges;
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  endEdge(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-edges-${indices.join('-')}` : 'end-edges';
    return new LazySceneObject(`${this.getUniqueName(suffix)}`,
      () => {
        const faces = this.getState('end-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        if (indices.length === 0) return edges;
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

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new ExtrudeSymmetric(this.distance, extrudable).syncWith(this);
  }

  compareTo(other: ExtrudeSymmetric): boolean {
    if (!(other instanceof ExtrudeSymmetric)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'extrude-symmetric';
  }

  serialize() {
    return {
      extrudables: this.extrudable.serialize(),
      distance: this.distance,
      symmetric: true,
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
