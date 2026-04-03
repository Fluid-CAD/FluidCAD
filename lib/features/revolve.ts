import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { rad } from "../helpers/math-helpers.js";
import { Solid } from "../common/shapes.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
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
import { FaceOps } from "../oc/face-ops.js";
import { Plane } from "../math/plane.js";

export class Revolve extends ExtrudeBase implements IRevolve {

  constructor(
    public axis: AxisObjectBase,
    public angle: number,
    public symmetric: boolean = false,
    extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const solids: Solid[] = [];
    const allStartFaces: Face[] = [];
    const allEndFaces: Face[] = [];
    const allSideFaces: Face[] = [];
    const allInternalFaces: Face[] = [];
    const faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane);
    const { result: fusedFaces } = BooleanOps.fuseFaces(faces);

    const axis = this.axis.getAxis();
    const isFullRevolution = Math.abs(this.angle) >= 360;

    for (const face of fusedFaces as Face[]) {
      const solid = ExtrudeOps.makeRevol(face, axis, rad(this.angle));

      // Collect inner wire edges for internal face detection
      const innerWireEdges: any[] = [];
      const wires = face.getWires();
      for (const wire of wires) {
        if (!wire.isCW(plane.normal)) {
          for (const edge of wire.getEdges()) {
            innerWireEdges.push(edge);
          }
        }
      }

      let resultSolid: Solid;
      if (this.symmetric) {
        const rotated = ShapeOps.rotateShape(solid.getShape(), axis, -rad(this.angle) / 2);
        resultSolid = Solid.fromTopoDSSolid(Explorer.toSolid(rotated));
      } else {
        resultSolid = Solid.fromTopoDSSolid(Explorer.toSolid(solid.getShape()));
      }
      solids.push(resultSolid);

      // Classify faces of the revolved solid
      const solidFaces = Explorer.findFacesWrapped(resultSolid);
      for (const f of solidFaces) {
        const isOnSourcePlane = FaceOps.faceOnPlaneWrapped(f as Face, plane);
        if (isOnSourcePlane && !isFullRevolution) {
          // Planar faces on the source plane are start/end faces for partial revolves
          allStartFaces.push(f as Face);
        } else if (!isOnSourcePlane) {
          // Check if face is internal (from inner wire)
          if (innerWireEdges.length > 0) {
            const faceEdges = (f as Face).getEdges();
            const isInternal = faceEdges.some(fe =>
              innerWireEdges.some(iwe => fe.getShape().IsPartner(iwe.getShape()))
            );
            if (isInternal) {
              allInternalFaces.push(f as Face);
              continue;
            }
          }
          allSideFaces.push(f as Face);
        }
      }
    }

    // For partial revolves with symmetric, classify start/end by plane offset
    if (!isFullRevolution && allStartFaces.length > 1) {
      // Split planar faces into start (first half) and end (second half)
      const half = Math.floor(allStartFaces.length / 2);
      const startSlice = allStartFaces.splice(0, half);
      const endSlice = allStartFaces.splice(0);
      allStartFaces.length = 0;
      allStartFaces.push(...startSlice);
      allEndFaces.push(...endSlice);
    }

    this.setState('start-faces', allStartFaces);
    this.setState('end-faces', allEndFaces);
    this.setState('side-faces', allSideFaces);
    this.setState('internal-faces', allInternalFaces);

    this.extrudable.removeShapes(this);
    this.axis.removeShapes(this);

    const sceneObjects = context.getSceneObjects();

    if (this.getFusionScope() === 'none' || !sceneObjects.length) {
      this.addShapes(solids);
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, solids);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (modifiedShape.object) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(fusionResult.newShapes);
  }

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new Revolve(this.axis, this.angle, this.symmetric, extrudable).syncWith(this);
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

    if (this.symmetric !== other.symmetric) {
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
      symmetric: this.symmetric || undefined,
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
