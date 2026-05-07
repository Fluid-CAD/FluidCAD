import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Extrudable } from "../helpers/types.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { IRib } from "../core/interfaces.js";
import { Plane } from "../math/plane.js";
import { Vector3d } from "../math/vector3d.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { RibOps } from "../oc/rib-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { requireShapes } from "../common/operand-check.js";

export class Rib extends ExtrudeBase implements IRib {
  private _thickness: number;
  private _spine: SceneObject;
  private _parallel: boolean = false;
  private _extend: boolean = false;

  constructor(
    thickness: number,
    spine: SceneObject,
    extrudable?: Extrudable,
  ) {
    super(extrudable);
    this._thickness = thickness;
    this._spine = spine;
  }

  get thickness(): number {
    return this._thickness;
  }

  get spine(): SceneObject {
    return this._spine;
  }

  parallel(): this {
    this._parallel = true;
    return this;
  }

  extend(): this {
    this._extend = true;
    return this;
  }

  override validate() {
    requireShapes(this._spine, "spine", "rib");
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const plane = this.extrudable.getPlane();

    const originalSpineWire = p.record('Get spine wire', () => this.getSpineWire(this._spine));
    let spineWire = originalSpineWire;

    const scopeObjects = this.resolveFusionScope(context.getSceneObjects());
    const scopeShapes = scopeObjects.flatMap(o => o.getShapes({}, 'solid'));

    if (scopeShapes.length === 0) {
      throw new Error("Rib requires target solids in the scene or via .scope()");
    }

    if (this._extend) {
      spineWire = p.record('Extend spine', () =>
        RibOps.extendSpineWire(spineWire, scopeShapes, plane),
      );
    }

    const profileFace = p.record('Make rib profile', () =>
      this._parallel
        ? RibOps.makeRibProfileParallel(spineWire, this._thickness, plane)
        : RibOps.makeRibProfile(spineWire, this._thickness, plane),
    );

    let direction: Vector3d;
    let distance: number;
    if (this._parallel) {
      const perpDir = RibOps.computeSpinePerpendicularDirection(spineWire, plane);
      direction = perpDir.multiply(Math.sign(this._thickness));
      distance = p.record('Compute extrude distance', () =>
        RibOps.computeExtrudeDistanceAlongDirection(direction, plane.origin, scopeShapes),
      );
    } else {
      direction = plane.normal.multiply(Math.sign(this._thickness));
      distance = p.record('Compute extrude distance', () =>
        RibOps.computeExtrudeDistance(plane, scopeShapes),
      );
    }

    const vec = direction.multiply(distance);
    const { solid, firstFace, lastFace } = p.record('Extrude rib', () =>
      ExtrudeOps.makePrismFromVec(profileFace, vec),
    );

    let ribSolid = solid;
    let ribFirstFace = firstFace;
    let ribLastFace = lastFace;

    if (this.getDraft()) {
      const draft = this.getDraft()!;
      let angle = draft[0];

      // The draft "neutral plane" must be perpendicular to the extrude
      // direction. Normal mode: that's the sketch plane. Parallel mode:
      // synthesize a plane whose normal is the signed extrude direction.
      const draftPlane = this._parallel
        ? new Plane(plane.origin, plane.normal, direction.normalize())
        : plane;

      // OCC's BRepOffsetAPI_DraftAngle uses an "outward bias" — positive
      // angle widens the part on the dir side. We want the user-facing
      // convention "positive draft tapers the rib inward as it extends",
      // so we negate when the dir we hand OCC matches the extrude sign:
      //   - normal mode: matches only when thickness > 0
      //   - parallel mode: always (draftPlane is built from signed direction)
      if (this._parallel || this._thickness > 0) {
        angle = -angle;
      }
      const rad = (deg: number) => deg * Math.PI / 180;

      const draftResult = p.record('Apply draft', () =>
        ExtrudeOps.applyDraftOnSideFaces(ribSolid, ribFirstFace, ribLastFace, draftPlane, rad(angle)),
      );
      ribSolid = draftResult.solid;
      ribFirstFace = draftResult.firstFace;
      ribLastFace = draftResult.lastFace;
    }

    this.extrudable.removeShapes(this);
    if (this._spine !== (this.extrudable as unknown as SceneObject)) {
      this._spine.removeShapes(this);
    }

    const conformed = p.record('Conform rib', () =>
      RibOps.conformRibToScope(ribSolid, scopeShapes, originalSpineWire, ribFirstFace, ribLastFace),
    );

    const classified: ClassifiedFaces = {
      startFaces: conformed.startFaces,
      endFaces: conformed.endFaces,
      sideFaces: conformed.sideFaces,
      internalFaces: conformed.internalFaces,
      capFaces: [],
    };

    if (this._operationMode === 'new') {
      this.setState('start-faces', classified.startFaces);
      this.setState('end-faces', classified.endFaces);
      this.setState('side-faces', classified.sideFaces);
      this.setState('internal-faces', classified.internalFaces);
      this.setState('cap-faces', classified.capFaces);
      this.addShapes(conformed.solids);
      this.recordShapeFacesAndEdgesAsAdditions(conformed.solids);
      this.classifyExtrudeEdges();
      return;
    }

    this.finalizeAndFuse(conformed.solids, classified, context);
  }

  private getSpineWire(pathObj: SceneObject): Wire {
    const shapes = pathObj.getShapes({ excludeMeta: false });
    const edges = shapes.flatMap(s => s.getSubShapes('edge')) as Edge[];
    return WireOps.makeWireFromEdges(edges);
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.extrudable) {
      deps.push(this.extrudable);
    }
    if (this._spine) {
      deps.push(this._spine);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    const spine = remap.get(this._spine) || this._spine;
    const copy = new Rib(this._thickness, spine, extrudable).syncWith(this) as Rib;
    copy._parallel = this._parallel;
    copy._extend = this._extend;
    return copy;
  }

  compareTo(other: Rib): boolean {
    if (!(other instanceof Rib)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this._thickness !== other._thickness) {
      return false;
    }
    if (!this._spine.compareTo(other._spine)) {
      return false;
    }
    if (this.extrudable && other.extrudable && !this.extrudable.compareTo(other.extrudable)) {
      return false;
    }
    if (this._parallel !== other._parallel) {
      return false;
    }
    if (this._extend !== other._extend) {
      return false;
    }
    return true;
  }

  getType(): string {
    return "rib";
  }

  serialize() {
    return {
      thickness: this._thickness,
      spine: this._spine.serialize(),
      extrudable: this.extrudable?.serialize(),
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      parallel: this._parallel || undefined,
      extend: this._extend || undefined,
      draft: this._draft,
    };
  }
}
