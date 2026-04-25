import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Extruder } from "./simple-extruder.js";
import { cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { Extrudable } from "../helpers/types.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ExtrudeThroughAll } from "./infinite-extrude.js";
import { ThinFaceMaker, ThinFaceResult } from "../oc/thin-face-maker.js";
import { Plane } from "../math/plane.js";

export class Extrude extends ExtrudeBase {
  constructor(public distance: number, source?: Extrudable | SceneObject) {
    super(source);
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();

    const plane = p.record('Get source plane', () => this.getSourcePlane());

    const pickedFaces = p.record('Resolve picked faces', () => this.resolvePickedFaces(plane));
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    if (this.isThin()) {
      if (this.isFaceSourced()) {
        throw new Error("thin() is not supported with a face-sourced extrude");
      }
      const thinResult = p.record('Resolve thin faces', () =>
        ThinFaceMaker.make(this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1]),
      );

      if (this._operationMode === 'remove') {
        // Thin + remove: use the thin profile faces as the cut tool source,
        // but the cut path doesn't apply thin face reclassification.
        this.buildRemove(thinResult.faces, plane, context);
      } else if (this._symmetric) {
        this.buildSymmetricThin(thinResult, plane, context);
      } else {
        this.buildAddThin(thinResult, plane, context);
      }
    } else {
      const faces = p.record('Resolve faces', () => this.resolveSourceFaces(plane, pickedFaces));

      if (this._operationMode === 'remove') {
        this.buildRemove(faces, plane, context);
      } else if (this._symmetric) {
        this.buildSymmetric(faces, plane, context);
      } else {
        this.buildAdd(faces, plane, context);
      }
    }

    this.setFinalShapes(this.getShapes());
  }

  /** Resolve the source faces for a non-thin extrude (add / symmetric / remove). */
  private resolveSourceFaces(plane: Plane, pickedFaces: Face[] | null): Face[] {
    if (this.isFaceSourced()) {
      return pickedFaces ?? this.getSourceFaces();
    }
    return pickedFaces ?? FaceMaker2.getRegions(
      this.extrudable.getGeometries(),
      plane,
      this.getDrill(),
    );
  }

  /** Plain extrude: one direction, regular face classification. */
  private buildAdd(faces: Face[], plane: Plane, context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const extruder = new Extruder(faces, plane, this.distance, this.getDraft(), this.getEndOffset(), p);
    const extrusions = p.record('Extrude faces', () => extruder.extrude());

    const classified: ClassifiedFaces = {
      startFaces: extruder.getStartFaces(),
      endFaces: extruder.getEndFaces(),
      sideFaces: extruder.getSideFaces(),
      internalFaces: extruder.getInternalFaces(),
      capFaces: [],
    };

    this.getSource()?.removeShapes(this);
    this.finalizeAndFuse(extrusions, classified, context, {
      glue: this.isFaceSourced() ? 'full' : undefined,
    });
  }

  /** Thin extrude: shell-like profile with inward/outward offsets. */
  private buildAddThin(thinResult: ThinFaceResult, plane: Plane, context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const extruder = new Extruder(thinResult.faces, plane, this.distance, this.getDraft(), this.getEndOffset(), p);
    const extrusions = p.record('Extrude thin faces', () => extruder.extrude());

    const classified = this.classifyThinExtrusion(
      extruder.getStartFaces(),
      extruder.getEndFaces(),
      extruder.getSideFaces(),
      extruder.getInternalFaces(),
      extruder.getStartFaces(),
      plane,
      thinResult,
    );

    this.getSource()?.removeShapes(this);
    this.finalizeAndFuse(extrusions, classified, context, {
      glue: this.isFaceSourced() ? 'full' : undefined,
    });
  }

  /**
   * Classify a thin extrusion's faces. For OPEN profiles (`inwardEdges`
   * non-empty) we reclassify side/internal/cap via the inward/outward edge
   * matching. For CLOSED profiles (no inward edges, e.g. a rect with `thin(5)`
   * creating an annulus) the Extruder's own inner-wire detection already
   * separated start/end/side/internal correctly — keep it as-is.
   */
  private classifyThinExtrusion(
    startFaces: Face[],
    endFaces: Face[],
    sideFaces: Face[],
    internalFaces: Face[],
    referenceFaces: Face[],
    plane: Plane,
    thinResult: ThinFaceResult,
  ): ClassifiedFaces {
    if (thinResult.inwardEdges.length === 0) {
      return {
        startFaces,
        endFaces,
        sideFaces,
        internalFaces,
        capFaces: [],
      };
    }

    const reclass = this.reclassifyThinFaces(
      [...sideFaces, ...internalFaces],
      referenceFaces,
      plane,
      thinResult.inwardEdges,
      thinResult.outwardEdges,
    );

    return {
      startFaces,
      endFaces,
      sideFaces: reclass.sideFaces,
      internalFaces: reclass.internalFaces,
      capFaces: reclass.capFaces,
    };
  }


  /** Symmetric extrude: two halves fused together, regular face classification. */
  private buildSymmetric(faces: Face[], plane: Plane, context: BuildSceneObjectContext) {
    const halves = this.buildSymmetricHalves(faces, plane, context);
    const classified = this.classifySymmetricByInnerWires(halves, plane);
    this.getSource()?.removeShapes(this);
    this.finalizeAndFuse(halves.extrusions, classified, context);
  }

  /**
   * Classify symmetric-extrusion remaining faces using inner-wire detection.
   * Used by both `buildSymmetric` and the closed-profile fallback in
   * `buildSymmetricThin`. Faces of the fused solid that share an edge with a
   * detected inner wire (a hole) are internal; the rest are side.
   */
  private classifySymmetricByInnerWires(
    halves: ReturnType<Extrude['buildSymmetricHalves']>,
    plane: Plane,
  ): ClassifiedFaces {
    const fusedInnerEdges = this.detectFusedInnerEdges(halves.extruder1, halves.fusedStartFaces, plane);

    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];
    for (const f of halves.remainingFaces) {
      const isInternal = fusedInnerEdges.length > 0 && f.getEdges().some(fe =>
        fusedInnerEdges.some(ie => fe.getShape().IsPartner(ie.getShape()))
      );
      if (isInternal) {
        internalFaces.push(f);
      } else {
        sideFaces.push(f);
      }
    }

    return {
      startFaces: halves.startFaces,
      endFaces: halves.endFaces,
      sideFaces,
      internalFaces,
      capFaces: [],
    };
  }

  /** Symmetric thin extrude: two halves of a shell-like profile fused. */
  private buildSymmetricThin(thinResult: ThinFaceResult, plane: Plane, context: BuildSceneObjectContext) {
    const halves = this.buildSymmetricHalves(thinResult.faces, plane, context);

    let classified: ClassifiedFaces;

    if (thinResult.inwardEdges.length > 0) {
      // Open profile: reclassify side/internal/cap via inward/outward edge matching.
      const reclass = this.reclassifyThinFaces(
        halves.remainingFaces,
        [...halves.fusedStartFaces, ...halves.fusedEndFaces],
        plane,
        thinResult.inwardEdges,
        thinResult.outwardEdges,
      );

      classified = {
        startFaces: halves.startFaces,
        endFaces: halves.endFaces,
        sideFaces: reclass.sideFaces,
        internalFaces: reclass.internalFaces,
        capFaces: reclass.capFaces,
      };
    } else {
      // Closed profile (e.g. rect.thin(5) producing an annulus): fall back to
      // the regular symmetric inner-wire detection — the Extruder's wire
      // orientation already encoded the hole correctly.
      classified = this.classifySymmetricByInnerWires(halves, plane);
    }

    this.getSource()?.removeShapes(this);
    this.finalizeAndFuse(halves.extrusions, classified, context);
  }

  /**
   * Build the two half-extrusions for a symmetric op, fuse them together, and
   * remap start/end faces onto the fused solid. The "remaining" faces (not
   * start, not end) are returned for the caller to classify per-mode (regular
   * inner-wire detection vs thin reclassification).
   */
  private buildSymmetricHalves(faces: Face[], plane: Plane, context: BuildSceneObjectContext) {
    const p = context.getProfiler();

    const extruder1 = new Extruder(faces, plane, this.distance / 2, this.getDraft(), this.getEndOffset(), p);
    const extrusions1 = p.record('Extrude direction 1', () => extruder1.extrude());
    const startFaces = extruder1.getEndFaces();

    const extruder2 = new Extruder(faces, plane, -this.distance / 2, this.getDraft(), this.getEndOffset(), p);
    const extrusions2 = p.record('Extrude direction 2', () => extruder2.extrude());
    const endFaces = extruder2.getEndFaces();

    const all = [...extrusions1, ...extrusions2];
    const halvesFuse = p.record('Fuse halves', () => BooleanOps.fuse(all));
    const extrusions = halvesFuse.result;
    halvesFuse.dispose();

    // Re-find start/end faces in the fused solid (NonDestructive preserves
    // their TShape, so IsSame matching works) and collect everything else as
    // "remaining" for per-mode classification.
    const remainingFaces: Face[] = [];
    const fusedStartFaces: Face[] = [];
    const fusedEndFaces: Face[] = [];
    for (const solid of extrusions) {
      for (const f of Explorer.findFacesWrapped(solid)) {
        const raw = f.getShape();
        if (startFaces.some(sf => raw.IsSame(sf.getShape()))) {
          fusedStartFaces.push(f as Face);
        } else if (endFaces.some(ef => raw.IsSame(ef.getShape()))) {
          fusedEndFaces.push(f as Face);
        } else {
          remainingFaces.push(f as Face);
        }
      }
    }

    return {
      extrusions,
      extruder1,
      extruder2,
      startFaces,
      endFaces,
      fusedStartFaces,
      fusedEndFaces,
      remainingFaces,
    };
  }

  /**
   * Find post-fusion edges that came from inner wires of the start face's
   * pre-fusion profile (holes). Used to classify the symmetric fused solid's
   * remaining faces into side vs internal. Inner wires are detected as
   * counter-clockwise wires on the sketch plane; their edges are mapped onto
   * the fused solid by 2D midpoint matching (SimplifyResult breaks TShape
   * identity for merged half-faces).
   */
  private detectFusedInnerEdges(extruder1: Extruder, fusedStartFaces: Face[], plane: Plane): Edge[] {
    const preInnerEdges: Edge[] = [];
    for (const sf of extruder1.getStartFaces()) {
      for (const wire of (sf as Face).getWires()) {
        if (!wire.isCW(plane.normal)) {
          for (const edge of wire.getEdges()) {
            preInnerEdges.push(edge as Edge);
          }
        }
      }
    }

    if (preInnerEdges.length === 0) {
      return [];
    }

    const innerMids = preInnerEdges.map(e => plane.worldToLocal(EdgeOps.getEdgeMidPointRaw(e.getShape())));
    const fusedInnerEdges: Edge[] = [];
    for (const sf of fusedStartFaces) {
      for (const sfe of sf.getEdges()) {
        const mid = plane.worldToLocal(EdgeOps.getEdgeMidPointRaw(sfe.getShape()));
        if (innerMids.some(im => mid.distanceTo(im) < 1e-4)) {
          fusedInnerEdges.push(sfe);
        }
      }
    }

    return fusedInnerEdges;
  }

  private buildRemove(faces: Face[], plane: any, context: BuildSceneObjectContext) {
    const scope = this.resolveFusionScope(context.getSceneObjects());

    let toolShapes: any[];
    const isThroughAll = this.distance === 0;

    if (this._symmetric) {
      // Symmetric cut: create tool centered on sketch plane
      if (isThroughAll) {
        if (this.isFaceSourced()) {
          throw new Error("through-all is not supported with a face-sourced extrude");
        }
        const extrudeThroughAll = new ExtrudeThroughAll(this.extrudable, true, true, faces);
        toolShapes = extrudeThroughAll.build();
      } else {
        const extruder1 = new Extruder(faces, plane, -this.distance / 2, this.getDraft(), this.getEndOffset());
        const extrusions1 = extruder1.extrude();
        const extruder2 = new Extruder(faces, plane, this.distance / 2, this.getDraft(), this.getEndOffset());
        const extrusions2 = extruder2.extrude();
        const all = [...extrusions1, ...extrusions2];
        const halvesFuse = BooleanOps.fuse(all);
        toolShapes = halvesFuse.result;
        halvesFuse.dispose();
      }
    } else if (isThroughAll) {
      if (this.isFaceSourced()) {
        throw new Error("through-all is not supported with a face-sourced extrude");
      }
      const extrudeThroughAll = new ExtrudeThroughAll(this.extrudable, false, true, faces);
      toolShapes = extrudeThroughAll.build();
    } else {
      const distance = -this.distance;
      const extruder = new Extruder(faces, plane, distance, this.getDraft(), this.getEndOffset());
      toolShapes = extruder.extrude();
    }

    this.getSource()?.removeShapes(this);

    cutWithSceneObjects(scope, toolShapes, plane, this.distance, this, {
      recordHistoryFor: this,
    });
  }

  override getDependencies(): SceneObject[] {
    const source = this.getSource();
    return source ? [source] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const source = this.getSource();
    const remapped = source ? (remap.get(source) || source) : undefined;
    return new Extrude(this.distance, remapped).syncWith(this);
  }

  compareTo(other: Extrude): boolean {
    if (!(other instanceof Extrude)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    const thisSource = this.getSource();
    const otherSource = other.getSource();
    if (!thisSource !== !otherSource) {
      return false;
    }
    if (thisSource && otherSource && !thisSource.compareTo(otherSource)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    if (this._operationMode === 'remove') {
      if (this._symmetric) {
        return 'cut-symmetric';
      }
      return 'cut';
    }
    if (this._symmetric) {
      return 'extrude-symmetric';
    }
    return 'extrude-by-distance';
  }

  serialize() {
    return {
      extrudable: this.getSource()?.serialize(),
      distance: this.distance,
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      symmetric: this._symmetric || undefined,
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      thin: this._thin,
      ...this.serializePickFields(),
    }
  }
}
