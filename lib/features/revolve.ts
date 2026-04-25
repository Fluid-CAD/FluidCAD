import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { rad } from "../helpers/math-helpers.js";
import { Solid } from "../common/shapes.js";
import { cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { ExtrudeOps, MakeRevolResult } from "../oc/extrude-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Extrudable } from "../helpers/types.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { IRevolve } from "../core/interfaces.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { ThinFaceMaker, ThinFaceResult } from "../oc/thin-face-maker.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { Convert } from "../oc/convert.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { getOC } from "../oc/init.js";
import type { TopoDS_Shape } from "occjs-wrapper";

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
    const revolved = this.runRevolutions(faces, context);
    const classified = this.classifyRevolveByInnerWires(revolved, plane);
    this.dispatchFinalize(revolved.solids, classified, plane, context);
  }

  /** Thin revolve: shell-like profile with inward/outward offsets. */
  private buildRevolveThin(thinResult: ThinFaceResult, plane: Plane, context: BuildSceneObjectContext) {
    const revolved = this.runRevolutions(thinResult.faces, context);

    let classified: ClassifiedFaces;
    if (thinResult.inwardEdges.length > 0) {
      // Open profile: each input edge of the thin face categorizes the side
      // face it generated (inward → internal, outward → side, anything else
      // is a cap edge → cap face).
      classified = this.classifyThinByEdgeHistory(revolved, thinResult);
    } else {
      // Closed profile: regular inner-wire detection.
      classified = this.classifyRevolveByInnerWires(revolved, plane);
    }

    this.dispatchFinalize(revolved.solids, classified, plane, context);
  }

  /**
   * Classify a thin open-profile revolve via the per-edge history captured
   * during `makeRevol`. Each entry in `revols[i].edgeFaces` pairs an input
   * edge of the thin face with the swept face it produced; we route that
   * face into internal / side / cap based on which edge category the input
   * belongs to (`thinResult.inwardEdges`, `outwardEdges`, or neither →
   * cap-line edge added by `makeOpenFaceWithCaps`).
   */
  private classifyThinByEdgeHistory(
    revolved: ReturnType<Revolve['runRevolutions']>,
    thinResult: ThinFaceResult,
  ): ClassifiedFaces {
    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];
    const capFaces: Face[] = [];

    const matchesAny = (edge: TopoDS_Shape, refs: Edge[]) =>
      refs.some(r => r.getShape().IsSame(edge));

    for (const revol of revolved.revols) {
      for (const { edge, face } of revol.edgeFaces) {
        if (!face) {
          continue;
        }
        if (matchesAny(edge, thinResult.inwardEdges)) {
          internalFaces.push(face);
        } else if (matchesAny(edge, thinResult.outwardEdges)) {
          sideFaces.push(face);
        } else {
          capFaces.push(face);
        }
      }
    }

    return {
      startFaces: revolved.startFaces,
      endFaces: revolved.endFaces,
      sideFaces,
      internalFaces,
      capFaces,
    };
  }

  /**
   * Run the revolutions for each fused profile face. Identifies start/end
   * faces via the maker's `FirstShape` / `LastShape` and tracks which side
   * face each input edge generated via `Generated()` — both survive the
   * downstream `cleanShapeRaw`. Caller refines side → side/internal/cap
   * using the per-edge mapping in `revols[i].edgeFaces`.
   */
  private runRevolutions(faces: Face[], context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const { result: fusedFaces } = p.record('Fuse faces', () => BooleanOps.fuseFaces(faces));

    const axis = this.axis.getAxis();

    const solids: Solid[] = [];
    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];
    const revols: MakeRevolResult[] = [];

    for (const face of fusedFaces as Face[]) {
      let revol = p.record('Revolve face', () => ExtrudeOps.makeRevol(face, axis, rad(this.angle)));

      if (this._symmetric) {
        const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, -rad(this.angle) / 2);
        revol = this.applySymmetricTransform(revol, matrix);
      }

      const resultSolid = Solid.fromTopoDSSolid(Explorer.toSolid(revol.solid.getShape()));
      solids.push(resultSolid);
      revols.push(revol);

      const firstRaw = revol.firstFace?.getShape() ?? null;
      const lastRaw = revol.lastFace?.getShape() ?? null;

      for (const f of Explorer.findFacesWrapped(resultSolid)) {
        const raw = f.getShape();
        if (firstRaw && raw.IsSame(firstRaw)) {
          startFaces.push(f as Face);
        } else if (lastRaw && raw.IsSame(lastRaw)) {
          endFaces.push(f as Face);
        } else {
          sideFaces.push(f as Face);
        }
      }
    }

    return { solids, startFaces, endFaces, sideFaces, revols };
  }

  /**
   * Rotate the revolved solid by `matrix` (used for `.symmetric()`) and
   * remap firstFace / lastFace / edgeFaces through the transformer's
   * `ModifiedShape` so classification keeps pointing at the right TShapes.
   */
  private applySymmetricTransform(revol: MakeRevolResult, matrix: Matrix4): MakeRevolResult {
    const oc = getOC();
    const [trsf, disposeTrsf] = Convert.toGpTrsf(matrix);
    const transformer = new oc.BRepBuilderAPI_Transform(trsf);
    transformer.Perform(revol.solid.getShape(), true);
    const transformedSolid = ShapeFactory.fromShape(transformer.Shape());

    const remapFace = (f: Face | null): Face | null => {
      if (!f) {
        return null;
      }
      const modified = transformer.ModifiedShape(f.getShape());
      return Face.fromTopoDSFace(Explorer.toFace(modified));
    };

    const result: MakeRevolResult = {
      solid: transformedSolid,
      firstFace: remapFace(revol.firstFace),
      lastFace: remapFace(revol.lastFace),
      edgeFaces: revol.edgeFaces.map(({ edge, face }) => ({
        edge,
        face: remapFace(face),
      })),
    };

    transformer.delete();
    disposeTrsf();
    return result;
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
