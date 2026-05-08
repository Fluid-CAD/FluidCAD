import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { Extrudable } from "../helpers/types.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { IRib } from "../core/interfaces.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceQuery } from "../oc/face-query.js";
import { RibOps } from "../oc/rib-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { Shape } from "../common/shape.js";
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

    const ribSolid = solid;
    const ribFirstFace = firstFace;
    const ribLastFace = lastFace;

    this.extrudable.removeShapes(this);
    if (this._spine !== (this.extrudable as unknown as SceneObject)) {
      this._spine.removeShapes(this);
    }

    const conformed = p.record('Conform rib', () =>
      RibOps.conformRibToScope(ribSolid, scopeShapes, originalSpineWire, ribFirstFace, ribLastFace, direction),
    );

    let classified: ClassifiedFaces = {
      startFaces: conformed.startFaces,
      endFaces: conformed.endFaces,
      sideFaces: conformed.sideFaces,
      internalFaces: conformed.internalFaces,
      capFaces: [],
    };
    let conformedSolids = conformed.solids;

    // Draft is applied AFTER conformance so the prism walls are already
    // bounded by the cavity. Drafting the over-extended pre-conform
    // prism caused OCC to fail (walls would cross within the over-
    // extension); the conformed rib is finite, so OCC handles strong
    // drafts cleanly.
    //
    // The neutral plane (= where draft = 0) is anchored at the spine
    // plane in parallel mode so the face the user originally drew stays
    // at the original thickness; in normal mode the sketch plane
    // already coincides with the prism base.
    if (this.getDraft() && conformedSolids.length === 1 && classified.startFaces.length > 0) {
      const draft = this.getDraft()!;
      let angle = draft[0];

      let draftPlane: Plane;
      if (this._parallel) {
        // Anchor the neutral plane just past the spine plane in the
        // OPPOSITE direction of the extrude. This places the entire rib
        // body on the +dir side of the neutral plane, so OCC's draft
        // tilts walls coherently around a pivot OUTSIDE the rib.
        // Empirically OCC's BRepOffsetAPI_DraftAngle returns IsDone=true
        // but does nothing when the neutral plane is at the wall
        // boundary; placing it 0.1mm "above" the spine (in -direction)
        // gives OCC a stable pivot while keeping the spine face
        // effectively unchanged (movement at the spine = 0.1*tan(angle)
        // which is sub-precision for any reasonable draft angle).
        const spineOrigin = originalSpineWire.getFirstVertex().toPoint();
        const dn = direction.normalize();
        const shifted = spineOrigin.add(dn.multiply(-0.1));
        draftPlane = new Plane(shifted, plane.normal, dn);
      } else {
        draftPlane = plane;
      }

      if (this._thickness > 0) {
        angle = -angle;
      }
      const rad = (deg: number) => deg * Math.PI / 180;

      const draftResult = p.record('Apply draft', () => {
        // Use the first start face as the OCC "firstFace" param (pivot
        // anchor). When the conformance trimmed the original end face
        // into the cavity (so endFaces is empty), the tip is already
        // captured as an internal face — we pass startFaces[0] as the
        // "lastFace" placeholder so its IsSame check is a no-op (it'll
        // also match firstFace and so be excluded once). The actual tip
        // surface stays excluded via the internalFaces argument.
        const startRep = classified.startFaces[0];
        const endRep = classified.endFaces[0] ?? startRep;
        // Faces of the rib that sit flush with a scope face (the rib's
        // mounting face — typically a cap that meets the cavity wall)
        // must not be tilted. Drafting them either tears the rib away
        // from the parent (negative draft) or makes OCC fail outright
        // (positive draft) because there's no material outside the wall
        // for the tilt to extend into.
        const wallTouchingFaces = findScopeCoincidentFaces(classified.sideFaces, scopeShapes);
        const excludes = [
          ...classified.startFaces.slice(1),
          ...classified.endFaces.slice(classified.endFaces[0] === endRep ? 1 : 0),
          ...classified.internalFaces,
          ...wallTouchingFaces,
        ];
        return ExtrudeOps.applyDraftOnSideFaces(
          conformedSolids[0],
          startRep,
          endRep,
          draftPlane,
          rad(angle),
          excludes,
        );
      });

      const remap = (faces: Face[]): Face[] => {
        const out: Face[] = [];
        for (const f of faces) {
          for (const r of draftResult.remapFace(f)) {
            out.push(r as Face);
          }
        }
        return out;
      };

      classified = {
        startFaces: remap(classified.startFaces),
        endFaces: remap(classified.endFaces),
        sideFaces: remap(classified.sideFaces),
        internalFaces: remap(classified.internalFaces),
        capFaces: [],
      };
      conformedSolids = [draftResult.solid];
    }

    if (this._operationMode === 'new') {
      this.setState('start-faces', classified.startFaces);
      this.setState('end-faces', classified.endFaces);
      this.setState('side-faces', classified.sideFaces);
      this.setState('internal-faces', classified.internalFaces);
      this.setState('cap-faces', classified.capFaces);
      this.addShapes(conformedSolids);
      this.recordShapeFacesAndEdgesAsAdditions(conformedSolids);
      this.classifyExtrudeEdges();
      return;
    }

    this.finalizeAndFuse(conformedSolids, classified, context);
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

// Faces of the rib whose surface sits flush with a face of any scope
// shape (planar coincidence). These are the rib's mounting faces — they
// must not be tilted by draft; tilting them either tears the rib away
// from the parent (negative draft) or makes OCC's draft fail (positive
// draft), since there's no material outside the parent wall for the
// tilt to extend into.
function findScopeCoincidentFaces(ribSideFaces: Face[], scopeShapes: Shape[]): Face[] {
  const out: Face[] = [];
  const scopePlanarFaces: { face: Face; origin: Point; normal: Vector3d }[] = [];
  for (const scope of scopeShapes) {
    const rawFaces = Explorer.findShapes(scope.getShape(), Explorer.getOcShapeType("face"));
    for (const rf of rawFaces) {
      const wrapped = Face.fromTopoDSFace(Explorer.toFace(rf));
      if (FaceQuery.getSurfaceType(wrapped) !== "plane") {
        continue;
      }
      const pl = FaceQuery.getSurfacePlane(wrapped);
      scopePlanarFaces.push({ face: wrapped, origin: pl.origin, normal: pl.normal });
    }
  }
  const tol = 1e-4;
  for (const rf of ribSideFaces) {
    if (FaceQuery.getSurfaceType(rf) !== "plane") {
      continue;
    }
    const rPl = FaceQuery.getSurfacePlane(rf);
    for (const { origin: sOrigin, normal: sNormal } of scopePlanarFaces) {
      // Parallel test: |normal · normal'| ≈ 1
      if (1 - Math.abs(rPl.normal.dot(sNormal)) > 1e-6) {
        continue;
      }
      // Coincidence test: perpendicular distance from one plane's origin
      // to the other plane is below tolerance. (FaceQuery.getSignedPlaneDistance
      // routes through gp_Pln.Distance, which returns 0 for parallel-but-
      // separated planes — useless for coincidence — so we compute it
      // directly here.)
      const offset = sOrigin.vectorTo(rPl.origin);
      const d = Math.abs(offset.dot(sNormal));
      if (d <= tol) {
        out.push(rf);
        break;
      }
    }
  }
  return out;
}
