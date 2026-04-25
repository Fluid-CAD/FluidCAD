import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { rad } from "../helpers/math-helpers.js";
import { Solid } from "../common/shapes.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Extrudable } from "../helpers/types.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ExtrudeBase } from "./extrude-base.js";
import { IRevolve } from "../core/interfaces.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { FaceOps } from "../oc/face-ops.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";
import { Matrix4 } from "../math/matrix4.js";

export class Revolve extends ExtrudeBase implements IRevolve {

  constructor(
    public axis: AxisObjectBase,
    public angle: number,
    extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const plane = this.extrudable.getPlane();

    const pickedFaces = p.record('Resolve picked faces', () => this.resolvePickedFaces(plane));
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const solids: Solid[] = [];
    const allStartFaces: Face[] = [];
    const allEndFaces: Face[] = [];
    let allSideFaces: Face[] = [];
    let allInternalFaces: Face[] = [];
    let allCapFaces: Face[] = [];

    let faces = pickedFaces ?? p.record('Resolve faces', () => FaceMaker2.getRegions(this.extrudable.getGeometries(), plane));
    let inwardEdges: Edge[] | undefined;
    let outwardEdges: Edge[] | undefined;

    if (this.isThin()) {
      const thinResult = p.record('Make thin faces', () => ThinFaceMaker.make(this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1]));
      faces = thinResult.faces;
      inwardEdges = thinResult.inwardEdges;
      outwardEdges = thinResult.outwardEdges;
    }

    const { result: fusedFaces } = p.record('Fuse faces', () => BooleanOps.fuseFaces(faces));

    const axis = this.axis.getAxis();
    const isFullRevolution = Math.abs(this.angle) >= 360;

    for (const face of fusedFaces as Face[]) {
      const solid = p.record('Revolve face', () => ExtrudeOps.makeRevol(face, axis, rad(this.angle)));

      let resultSolid: Solid;
      if (this._symmetric) {
        const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, -rad(this.angle) / 2);
        const rotated = ShapeOps.transform(solid, matrix);
        resultSolid = Solid.fromTopoDSSolid(Explorer.toSolid(rotated.getShape()));
      } else {
        resultSolid = Solid.fromTopoDSSolid(Explorer.toSolid(solid.getShape()));
      }
      solids.push(resultSolid);

      // Classify faces of the revolved solid
      const solidFaces = Explorer.findFacesWrapped(resultSolid);
      for (const f of solidFaces) {
        const isOnSourcePlane = FaceOps.faceOnPlaneWrapped(f as Face, plane);
        if (isOnSourcePlane && !isFullRevolution) {
          allStartFaces.push(f as Face);
        } else {
          allSideFaces.push(f as Face);
        }
      }
    }

    // For partial revolves with symmetric, classify start/end by plane offset
    if (!isFullRevolution && allStartFaces.length > 1) {
      const half = Math.floor(allStartFaces.length / 2);
      const startSlice = allStartFaces.splice(0, half);
      const endSlice = allStartFaces.splice(0);
      allStartFaces.length = 0;
      allStartFaces.push(...startSlice);
      allEndFaces.push(...endSlice);
    }

    if (inwardEdges && inwardEdges.length > 0) {
      const result = this.reclassifyThinFaces(
        allSideFaces, allStartFaces, plane, inwardEdges, outwardEdges || []
      );
      allSideFaces = result.sideFaces;
      allInternalFaces = result.internalFaces;
      allCapFaces = result.capFaces;
    } else {
      const innerWireEdges: Edge[] = [];
      for (const sf of allStartFaces) {
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
        for (const f of allSideFaces) {
          const isInternal = f.getEdges().some(fe =>
            innerWireEdges.some(iwe => fe.getShape().IsPartner(iwe.getShape()))
          );
          if (isInternal) {
            allInternalFaces.push(f);
          } else {
            remaining.push(f);
          }
        }
        allSideFaces = remaining;
      }
    }

    this.setState('start-faces', allStartFaces);
    this.setState('end-faces', allEndFaces);
    this.setState('side-faces', allSideFaces);
    this.setState('internal-faces', allInternalFaces);
    this.setState('cap-faces', allCapFaces);

    this.extrudable.removeShapes(this);
    this.axis.removeShapes(this);

    if (this._operationMode === 'remove') {
      const scope = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));
      p.record('Cut with scene objects', () => {
        cutWithSceneObjects(scope, solids, plane, 0, this, { recordHistoryFor: this });
      });
      this.setFinalShapes(this.getShapes());
      return;
    }

    const sceneObjects = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));

    if (sceneObjects.length === 0) {
      this.addShapes(solids);
      this.recordShapeFacesAndEdgesAsAdditions(solids);
      this.classifyExtrudeEdges();
      this.setFinalShapes(this.getShapes());
      return;
    }

    const fusionResult = p.record('Fuse with scene objects', () => fuseWithSceneObjects(sceneObjects, solids, {
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

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new Revolve(this.axis, this.angle, extrudable).syncWith(this);
  }

  compareTo(other: Revolve): boolean {
    if (!(other instanceof Revolve)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.angle !== other.angle) {
      return false;
    }

    if (!this.axis.compareTo(other.axis)) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "revolve";
  }

  serialize() {
    return {
      angle: this.angle,
      axis: this.axis.serialize(),
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      symmetric: this._symmetric || undefined,
      thin: this._thin,
      ...this.serializePickFields(),
    }
  }
}
