import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { LoftOps, LoftOptions, LoftEndCondition } from "../oc/loft-ops.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { FaceOps } from "../oc/face-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Plane } from "../math/plane.js";
import { ILoft, LoftConditionType } from "../core/interfaces.js";
import { type NumberParam, resolveParam } from "../core/param.js";
import { fuseWithSceneObjects, cutWithSceneObjects, wiresFromSceneObjectEdges } from "../helpers/scene-helpers.js";
import { ExtrudeBase } from "./extrude-base.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";
import { Shape } from "../common/shape.js";
import { requireShapes } from "../common/operand-check.js";

export class Loft extends ExtrudeBase implements ILoft {
  private _profiles: SceneObject[] = [];
  private _guides: SceneObject[] = [];
  private _startCondition?: LoftEndCondition;
  private _endCondition?: LoftEndCondition;

  constructor(...profiles: SceneObject[]) {
    super();
    this._profiles = profiles;
  }

  get profiles(): SceneObject[] {
    return this._profiles;
  }

  /**
   * Adds side guide curves the loft surface must follow. FluidCAD supports
   * one or two guides (the underlying OCC algorithm has no notion of more);
   * each guide must pass through every profile.
   */
  guides(...guides: SceneObject[]): this {
    if (guides.length === 0) {
      throw new Error("loft.guides: provide at least one guide curve.");
    }
    this._guides = guides;
    return this;
  }

  /**
   * Constrains how the surface leaves the first profile: 'normal' takes off
   * perpendicular to the profile plane, 'tangent' takes off inside the
   * profile plane (outward), 'none' clears the constraint. The magnitude
   * scales the takeoff strength (default 1).
   */
  startCondition(type: LoftConditionType, magnitude?: NumberParam): this {
    this._startCondition = Loft.resolveCondition("startCondition", type, magnitude);
    return this;
  }

  /**
   * Constrains how the surface arrives at the last profile — see
   * {@link startCondition}.
   */
  endCondition(type: LoftConditionType, magnitude?: NumberParam): this {
    this._endCondition = Loft.resolveCondition("endCondition", type, magnitude);
    return this;
  }

  private static resolveCondition(
    method: string,
    type: LoftConditionType,
    magnitude: NumberParam | undefined,
  ): LoftEndCondition | undefined {
    if (type === "none") {
      if (magnitude !== undefined) {
        throw new Error(`loft.${method}: magnitude has no effect with 'none'.`);
      }
      return undefined;
    }
    if (type !== "normal" && type !== "tangent") {
      throw new Error(`loft.${method}: expected 'none', 'normal' or 'tangent', got '${type}'.`);
    }
    const value = magnitude === undefined ? 1 : resolveParam(magnitude);
    if (value === 0) {
      throw new Error(`loft.${method}: magnitude must be non-zero.`);
    }
    return { kind: type, magnitude: value };
  }

  private hasConditions(): boolean {
    return this._startCondition !== undefined || this._endCondition !== undefined;
  }

  override validate() {
    for (let i = 0; i < this._profiles.length; i++) {
      requireShapes(this._profiles[i], `profile ${i + 1}`, "loft");
    }
    for (let i = 0; i < this._guides.length; i++) {
      requireShapes(this._guides[i], `guide ${i + 1}`, "loft");
    }
    if (this._guides.length > 2) {
      throw new Error("Loft supports at most two guide curves.");
    }
    if (this._guides.length > 0 && this.isThin()) {
      throw new Error("Loft guides cannot be combined with thin mode.");
    }
  }

  build(context: BuildSceneObjectContext) {
    if (this.profiles.length < 2) {
      throw new Error("Loft requires at least two profiles.");
    }

    const p = context.getProfiler();
    const options = p.record('Resolve loft options', () => this.resolveLoftOptions());
    let newShapes: Shape[];

    if (this.isThin()) {
      newShapes = p.record('Build thin loft', () => this.buildThinLoft(options));
    } else {
      const allWires: Wire[] = [];

      for (const profile of this.profiles) {
        const wires = p.record('Get profile wires', () => this.getWiresFromSceneObject(profile));

        if (wires.length === 0) {
          throw new Error("Could not extract wire from profile.");
        }
        if (options && wires.length !== 1) {
          throw new Error("Loft with guides or start/end conditions requires exactly one region per profile.");
        }

        for (const wire of wires) {
          allWires.push(wire);
        }
      }

      newShapes = p.record('Make loft', () => LoftOps.makeLoft(allWires, options));
    }

    for (const profile of this.profiles) {
      profile.removeShapes(this);
    }
    for (const guide of this._guides) {
      guide.removeShapes(this);
    }

    // Classify faces into start/end/side using profile planes
    const firstPlane = this.getProfilePlane(this.profiles[0]);
    const lastPlane = this.getProfilePlane(this.profiles[this.profiles.length - 1]);

    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];

    for (const shape of newShapes) {
      const faces = Explorer.findFacesWrapped(shape);
      for (const f of faces) {
        if (firstPlane && FaceOps.faceOnPlaneWrapped(f as Face, firstPlane)) {
          startFaces.push(f as Face);
        } else if (lastPlane && FaceOps.faceOnPlaneWrapped(f as Face, lastPlane)) {
          endFaces.push(f as Face);
        } else {
          sideFaces.push(f as Face);
        }
      }
    }

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', sideFaces);

    // Handle boolean operation based on operation mode
    if (this._operationMode === 'remove') {
      const scope = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));
      const plane = firstPlane || lastPlane;
      p.record('Cut with scene objects', () => {
        cutWithSceneObjects(scope, newShapes, plane, 0, this, { recordHistoryFor: this });
      });
      this.setFinalShapes(this.getShapes());
      return;
    }

    const sceneObjects = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));

    if (sceneObjects.length === 0) {
      this.addShapes(newShapes);
      this.recordShapeFacesAndEdgesAsAdditions(newShapes);
      this.classifyExtrudeEdges();
      this.setFinalShapes(this.getShapes());
      return;
    }

    const fusionResult = p.record('Fuse with scene objects', () => fuseWithSceneObjects(sceneObjects, newShapes, {
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

  /**
   * The options for `LoftOps.makeLoft`, with guide objects resolved to wires.
   * A single guide argument may carry several separate curves (e.g. a sketch
   * with a curve and its mirror) — each connected chain counts as one guide.
   * Returns undefined for a plain loft, keeping the legacy multi-wire path
   * untouched.
   */
  private resolveLoftOptions(): LoftOptions | undefined {
    if (this._guides.length === 0 && !this.hasConditions()) {
      return undefined;
    }

    let guides: Wire[] | undefined;
    if (this._guides.length > 0) {
      guides = this._guides.flatMap((guide, i) => wiresFromSceneObjectEdges(guide, `loft guide ${i + 1}`));
      if (guides.length > 2) {
        throw new Error(`Loft supports at most two guide curves, got ${guides.length}.`);
      }
    }

    return {
      startCondition: this._startCondition,
      endCondition: this._endCondition,
      guides,
    };
  }

  private buildThinLoft(options?: LoftOptions): Shape[] {
    const outerWires: Wire[] = [];
    const innerWires: Wire[] = [];

    for (const profile of this.profiles) {
      if (!profile.isExtrudable()) {
        throw new Error("Thin loft requires all profiles to be sketches.");
      }
      const extrudable = profile as unknown as Extrudable;
      const profilePlane = extrudable.getPlane();
      const thinResult = ThinFaceMaker.make(
        extrudable.getGeometries(), profilePlane, this._thin[0], this._thin[1]
      );
      for (const face of thinResult.faces) {
        const wires = face.getWires();
        outerWires.push(wires[0]);
        if (wires.length > 1) {
          innerWires.push(wires[1]);
        }
      }
    }

    // With conditions, both walls come from the in-house skin — assemble the
    // thin solid directly (walls + ring caps). Booleans between two
    // nearly-parallel B-spline shells take OCC seconds.
    if (options && innerWires.length > 0 && innerWires.length === outerWires.length) {
      return LoftOps.makeThinLoft(outerWires, innerWires, options);
    }

    const outerSolids = LoftOps.makeLoft(outerWires, options);

    if (innerWires.length > 0 && innerWires.length === outerWires.length) {
      const innerSolids = LoftOps.makeLoft(innerWires, options);
      const outerFuse = BooleanOps.fuse(outerSolids);
      const innerFuse = BooleanOps.fuse(innerSolids);
      const cutResult = BooleanOps.cutShapes(outerFuse.result[0], innerFuse.result[0]);
      outerFuse.dispose();
      innerFuse.dispose();
      return [cutResult];
    }

    return outerSolids;
  }

  private getProfilePlane(profile: SceneObject): Plane | null {
    if ('getPlane' in profile && typeof (profile as any).getPlane === 'function') {
      return (profile as Extrudable).getPlane();
    }
    return null;
  }

  private getWiresFromSceneObject(obj: SceneObject): Wire[] {
    const shapes = obj.getShapes({ excludeMeta: false });

    // If shapes are faces, extract their outer wires
    const faceShapes = shapes.filter(s => s.isFace()) as Face[];
    if (faceShapes.length > 0) {
      const wires: Wire[] = [];
      for (const face of faceShapes) {
        const faceWires = face.getWires();
        if (faceWires.length > 0) {
          wires.push(faceWires[0]); // outer wire
        }
      }
      return wires;
    }

    // If shapes are wires directly
    const wireShapes = shapes.filter(s => s.isWire()) as Wire[];
    if (wireShapes.length > 0) {
      return wireShapes;
    }

    // If it's an extrudable (sketch), get geometries and make faces to get wires
    if ('getGeometries' in obj && 'getPlane' in obj) {
      const extrudable = obj as unknown as Extrudable;
      const geometries = extrudable.getGeometries();
      const plane = extrudable.getPlane();
      const faces = FaceMaker2.getRegions(geometries, plane);
      const wires: Wire[] = [];
      for (const face of faces) {
        const faceWires = face.getWires();
        if (faceWires.length > 0) {
          wires.push(faceWires[0]);
        }
      }
      return wires;
    }

    // Try to extract wires from solid shapes
    const solidShapes = shapes.filter(s => s.isSolid());
    if (solidShapes.length > 0) {
      const wires: Wire[] = [];
      for (const solid of solidShapes) {
        const solidWires = Explorer.findWiresWrapped(solid);
        if (solidWires.length > 0) {
          wires.push(solidWires[0]);
        }
      }
      return wires;
    }

    return [];
  }

  override getDependencies(): SceneObject[] {
    return [...this._profiles, ...this._guides];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const profiles = this._profiles.map(p => remap.get(p) || p);
    const copy = new Loft(...profiles);
    copy.syncWith(this);
    copy._guides = this._guides.map(g => remap.get(g) || g);
    copy._startCondition = this._startCondition ? { ...this._startCondition } : undefined;
    copy._endCondition = this._endCondition ? { ...this._endCondition } : undefined;
    return copy;
  }

  compareTo(other: Loft): boolean {
    if (!(other instanceof Loft)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.profiles.length !== other.profiles.length) {
      return false;
    }

    for (let i = 0; i < this.profiles.length; i++) {
      if (!this.profiles[i].compareTo(other.profiles[i])) {
        return false;
      }
    }

    if (this._guides.length !== other._guides.length) {
      return false;
    }

    for (let i = 0; i < this._guides.length; i++) {
      if (!this._guides[i].compareTo(other._guides[i])) {
        return false;
      }
    }

    if (!Loft.conditionsEqual(this._startCondition, other._startCondition)
      || !Loft.conditionsEqual(this._endCondition, other._endCondition)) {
      return false;
    }

    return true;
  }

  private static conditionsEqual(a: LoftEndCondition | undefined, b: LoftEndCondition | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.kind === b.kind && a.magnitude === b.magnitude;
  }

  getType(): string {
    return "loft";
  }

  serialize() {
    return {
      profiles: this.profiles.map(f => f.serialize()),
      guides: this._guides.length > 0 ? this._guides.map(g => g.serialize()) : undefined,
      startCondition: this._startCondition,
      endCondition: this._endCondition,
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      thin: this._thin,
    }
  }
}
