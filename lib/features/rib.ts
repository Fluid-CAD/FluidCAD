import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Extrudable } from "../helpers/types.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { IRib } from "../core/interfaces.js";
import { Vector3d } from "../math/vector3d.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { RibOps } from "../oc/rib-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { Explorer } from "../oc/explorer.js";
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

    let spineWire = p.record('Get spine wire', () => this.getSpineWire(this._spine));

    const scopeObjects = this.resolveFusionScope(context.getSceneObjects());
    const scopeShapes = scopeObjects.flatMap(o => o.getShapes({}, 'solid'));

    if (scopeShapes.length === 0) {
      throw new Error("Rib requires target solids in the scene or via .scope()");
    }

    if (this._extend) {
      const extensionAmount = p.record('Compute extension', () =>
        RibOps.computeExtensionAmount(scopeShapes),
      );
      spineWire = p.record('Extend spine', () =>
        RibOps.extendSpineWire(spineWire, extensionAmount),
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
      if (this._thickness > 0) {
        angle = -angle;
      }
      const rad = (deg: number) => deg * Math.PI / 180;
      const draftResult = p.record('Apply draft', () =>
        ExtrudeOps.applyDraftOnSideFaces(ribSolid, ribFirstFace, ribLastFace, plane, rad(angle)),
      );
      ribSolid = draftResult.solid;
      ribFirstFace = draftResult.firstFace;
      ribLastFace = draftResult.lastFace;
    }

    const classified = p.record('Classify faces', () =>
      this.classifyRibFaces(ribSolid, ribFirstFace, ribLastFace, spineWire),
    );

    this.extrudable.removeShapes(this);
    if (this._spine !== (this.extrudable as unknown as SceneObject)) {
      this._spine.removeShapes(this);
    }

    if (this._operationMode === 'new') {
      const trimmed = p.record('Trim rib', () =>
        RibOps.trimRibToScope(ribSolid, scopeShapes),
      );
      this.setState('start-faces', classified.startFaces);
      this.setState('end-faces', classified.endFaces);
      this.setState('side-faces', classified.sideFaces);
      this.setState('internal-faces', classified.internalFaces);
      this.setState('cap-faces', classified.capFaces);
      this.addShapes(trimmed);
      this.recordShapeFacesAndEdgesAsAdditions(trimmed);
      this.classifyExtrudeEdges();
      return;
    }

    this.finalizeAndFuse([ribSolid], classified, context);
  }

  private getSpineWire(pathObj: SceneObject): Wire {
    const shapes = pathObj.getShapes({ excludeMeta: false });
    const edges = shapes.flatMap(s => s.getSubShapes('edge')) as Edge[];
    return WireOps.makeWireFromEdges(edges);
  }

  private classifyRibFaces(
    solid: Shape,
    firstFace: Shape,
    lastFace: Shape,
    spineWire: Wire,
  ): ClassifiedFaces {
    const allFaces = Explorer.findFacesWrapped(solid);
    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];
    const capFaces: Face[] = [];

    const spineStartPt = spineWire.getFirstVertex().toPoint().toVector3d();
    const spineEndPt = spineWire.getLastVertex().toPoint().toVector3d();

    for (const f of allFaces) {
      const raw = f.getShape();
      if (raw.IsSame(firstFace.getShape())) {
        startFaces.push(f as Face);
      } else if (raw.IsSame(lastFace.getShape())) {
        endFaces.push(f as Face);
      } else {
        const bbox = f.getBoundingBox();
        const center = new Vector3d(bbox.centerX, bbox.centerY, bbox.centerZ);
        const distToStart = center.subtract(spineStartPt).length();
        const distToEnd = center.subtract(spineEndPt).length();
        const faceSize = Math.max(
          bbox.maxX - bbox.minX,
          bbox.maxY - bbox.minY,
          bbox.maxZ - bbox.minZ,
        );

        // Cap faces are small and near spine endpoints; side faces are larger
        const isSmall = faceSize < Math.abs(this._thickness) * 1.5;
        const isNearEndpoint = distToStart < Math.abs(this._thickness) * 2
          || distToEnd < Math.abs(this._thickness) * 2;

        if (isSmall && isNearEndpoint) {
          capFaces.push(f as Face);
        } else {
          sideFaces.push(f as Face);
        }
      }
    }

    return { startFaces, endFaces, sideFaces, internalFaces: [], capFaces };
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
    return new Rib(this._thickness, spine, extrudable).syncWith(this);
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
