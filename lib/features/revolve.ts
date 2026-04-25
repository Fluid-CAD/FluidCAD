import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { rad } from "../helpers/math-helpers.js";
import { Solid } from "../common/shapes.js";
import { cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Extrudable } from "../helpers/types.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { IRevolve } from "../core/interfaces.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { FaceOps } from "../oc/face-ops.js";
import { ThinFaceMaker, ThinFaceResult } from "../oc/thin-face-maker.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";

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

    if (this.isThin()) {
      const thinResult = p.record('Make thin faces', () => ThinFaceMaker.make(
        this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1],
      ));
      this.buildRevolveThin(thinResult, plane, context);
    } else {
      const faces = pickedFaces ?? p.record('Resolve faces', () =>
        FaceMaker2.getRegions(this.extrudable.getGeometries(), plane),
      );
      this.buildRevolve(faces, plane, context);
    }

    this.setFinalShapes(this.getShapes());
  }

  /** Plain revolve: classify by inner-wire detection on the source plane. */
  private buildRevolve(faces: Face[], plane: Plane, context: BuildSceneObjectContext) {
    const revolved = this.runRevolutions(faces, plane, context);
    const classified = this.classifyRevolveByInnerWires(revolved, plane);
    this.dispatchFinalize(revolved.solids, classified, plane, context);
  }

  /** Thin revolve: shell-like profile with inward/outward offsets. */
  private buildRevolveThin(thinResult: ThinFaceResult, plane: Plane, context: BuildSceneObjectContext) {
    const revolved = this.runRevolutions(thinResult.faces, plane, context);

    let classified: ClassifiedFaces;
    if (thinResult.inwardEdges.length > 0) {
      // Open profile: reclassify side/internal/cap via inward/outward edges.
      const reclass = this.reclassifyThinFaces(
        revolved.sideFaces,
        revolved.startFaces,
        plane,
        thinResult.inwardEdges,
        thinResult.outwardEdges,
      );
      classified = {
        startFaces: revolved.startFaces,
        endFaces: revolved.endFaces,
        sideFaces: reclass.sideFaces,
        internalFaces: reclass.internalFaces,
        capFaces: reclass.capFaces,
      };
    } else {
      // Closed profile: regular inner-wire detection.
      classified = this.classifyRevolveByInnerWires(revolved, plane);
    }

    this.dispatchFinalize(revolved.solids, classified, plane, context);
  }

  /**
   * Run the revolutions for each fused profile face and return the resulting
   * solids with start/end/side faces split out (start = faces still on the
   * source plane for partial revolutions, side = everything else). Caller
   * then refines side → side/internal/cap.
   */
  private runRevolutions(faces: Face[], plane: Plane, context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const { result: fusedFaces } = p.record('Fuse faces', () => BooleanOps.fuseFaces(faces));

    const axis = this.axis.getAxis();
    const isFullRevolution = Math.abs(this.angle) >= 360;

    const solids: Solid[] = [];
    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];

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

      for (const f of Explorer.findFacesWrapped(resultSolid)) {
        const isOnSourcePlane = FaceOps.faceOnPlaneWrapped(f as Face, plane);
        if (isOnSourcePlane && !isFullRevolution) {
          startFaces.push(f as Face);
        } else {
          sideFaces.push(f as Face);
        }
      }
    }

    // Partial revolutions produce two source-plane caps; the second half are
    // the "end" faces. Split by index halves.
    if (!isFullRevolution && startFaces.length > 1) {
      const half = Math.floor(startFaces.length / 2);
      endFaces.push(...startFaces.splice(half));
    }

    return { solids, startFaces, endFaces, sideFaces };
  }

  /** Inner-wire classification used by both regular revolve and closed thin profiles. */
  private classifyRevolveByInnerWires(
    revolved: ReturnType<Revolve['runRevolutions']>,
    plane: Plane,
  ): ClassifiedFaces {
    const innerWireEdges: Edge[] = [];
    for (const sf of revolved.startFaces) {
      for (const wire of sf.getWires()) {
        if (!wire.isCW(plane.normal)) {
          for (const edge of wire.getEdges()) {
            innerWireEdges.push(edge);
          }
        }
      }
    }

    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];

    if (innerWireEdges.length === 0) {
      sideFaces.push(...revolved.sideFaces);
    } else {
      for (const f of revolved.sideFaces) {
        const isInternal = f.getEdges().some(fe =>
          innerWireEdges.some(iwe => fe.getShape().IsPartner(iwe.getShape()))
        );
        if (isInternal) {
          internalFaces.push(f);
        } else {
          sideFaces.push(f);
        }
      }
    }

    return {
      startFaces: revolved.startFaces,
      endFaces: revolved.endFaces,
      sideFaces,
      internalFaces,
      capFaces: [],
    };
  }

  /** Remove source + axis, then dispatch to cut or fuse path. */
  private dispatchFinalize(
    solids: Solid[],
    classified: ClassifiedFaces,
    plane: Plane,
    context: BuildSceneObjectContext,
  ) {
    this.extrudable.removeShapes(this);
    this.axis.removeShapes(this);

    if (this._operationMode === 'remove') {
      const scope = this.resolveFusionScope(context.getSceneObjects());
      // Note: stash classification state up front — cutWithSceneObjects /
      // classifyCutResult writes its own state keys, but the pre-classified
      // faces are useful for the remove path's selection accessors when no
      // cut-specific edges exist for that category.
      this.setState('start-faces', classified.startFaces);
      this.setState('end-faces', classified.endFaces);
      this.setState('side-faces', classified.sideFaces);
      this.setState('internal-faces', classified.internalFaces);
      this.setState('cap-faces', classified.capFaces);
      cutWithSceneObjects(scope, solids, plane, 0, this, { recordHistoryFor: this });
      return;
    }

    this.finalizeAndFuse(solids, classified, context);
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
