import { SceneObject, type BuildSceneObjectContext, type SourceLocation } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Part } from "../features/part.js";
import { Connector } from "../features/connector.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { OccScope } from "../oc/occ-scope.js";
import { KernelTraps } from "../oc/kernel-traps.js";
import type { Scene } from "../rendering/scene.js";
import type { LengthUnit } from "../units/units.js";
import { CONNECTOR_NAME_PATTERN } from "../selection/types.js";
import { FeatureCall } from "./call-shape.js";
import { SchemaValidator } from "./value-schema.js";

/**
 * Plain JSON: what a generator's part inputs are made of — numbers (finite),
 * strings, booleans, `null`, arrays and plain objects, nested to any depth.
 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * How much a generator's `build` should make: `'full'`, every detail, or
 * `'preview'`, what is quick to make while the user is still changing a
 * value (no drilling, no small hardware). Builds are `'full'` for now.
 */
export type GeneratorDetail = 'preview' | 'full';

/** A point or a direction in a frame: `[x, y, z]`. */
export type JsonVector = readonly [number, number, number];

/**
 * One connector of a generated part, as plain JSON in the generator's unit
 * and in the part's own coordinates: `{ origin: [0, 0, 0], z: [0, 0, 1] }`.
 */
export type GeneratedFrameSpec = {
  /** Where the connector sits. */
  origin: JsonVector;
  /** Its Z axis — what a mate lines up — of any length but zero. */
  z: JsonVector;
  /**
   * Its X axis, squared against Z; it must not run along Z. Left out, X is
   * the one a connector on a plane of that normal takes.
   */
  x?: JsonVector;
};

/**
 * What a generator's `static build(type, inputs, ctx)` is handed beside the
 * part's type and inputs.
 */
export type GeneratorBuildContext = {
  /** How much to make — see {@link GeneratorDetail}. Always `'full'` for now. */
  readonly detail: GeneratorDetail;
  /**
   * The unit the build's numbers are in: the generator's — its defining
   * module's (`defineAssembly`), whatever unit the assembly that inserts it
   * runs in. The engine rescales the part afterwards.
   */
  readonly unit: LengthUnit;
  /**
   * Run raw OpenCascade code (`fluidcad/sdk/occt`) in a scope that frees
   * what it makes when `fn` returns or throws, except what `fn` returns or
   * the scope's `keep()` keeps — as a feature's `this.occ(fn)` does.
   */
  occ<T>(fn: (scope: OccScope) => T): T;
};

/** The side of a generator class a template builds through: its name, for messages, and its `static build`. */
export type TemplateBuilder = {
  readonly name: string;
  build(type: string, inputs: any, ctx: GeneratorBuildContext): unknown;
};

/** Checking, copying and spelling plain JSON (see {@link JsonValue}). */
export class PlainJson {

  /**
   * Refuse anything in `value` that is not plain JSON — `undefined`, a
   * function, a number that isn't finite, an object of a class (a Map, a
   * shape), an object that holds itself — naming where it sits: `path` is
   * the value's own (`inputs`), and each step down adds to it
   * (`inputs.hinge.side`, `inputs.shelves[2]`). `rule` ends the message.
   */
  static check(value: unknown, path: string, rule: string): void {
    PlainJson.walk(value, path, rule, new Set());
  }

  /**
   * The canonical text of plain JSON: object keys sorted, at every depth.
   * Two values that hold the same data have the same text, whatever order
   * their keys were written in.
   */
  static canonical(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(entry => PlainJson.canonical(entry)).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map(key => `${JSON.stringify(key)}:${PlainJson.canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  /** A deep copy of plain JSON, frozen: what the engine keeps of what a generator handed it. */
  static frozenCopy<T>(value: T): T {
    return SchemaValidator.frozenCopy(value) as T;
  }

  private static walk(value: unknown, path: string, rule: string, ancestors: Set<object>): void {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is ${value} — ${rule}`);
      }
      return;
    }
    if (typeof value !== 'object') {
      const what = value === undefined ? 'undefined (leave it out, or give null)' : `a ${typeof value}`;
      throw new Error(`${path} is ${what} — ${rule}`);
    }
    if (ancestors.has(value)) {
      throw new Error(`${path} holds itself — ${rule}`);
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        PlainJson.walk(value[i], `${path}[${i}]`, rule, ancestors);
      }
    } else if (FeatureCall.isPlainObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        PlainJson.walk(entry, PlainJson.step(path, key), rule, ancestors);
      }
    } else {
      const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
      const what = typeof name === 'string' && name !== '' ? SchemaValidator.article(name) + ` ${name}` : 'an object of a class';
      throw new Error(`${path} is ${what} — ${rule}`);
    }
    ancestors.delete(value);
  }

  /** `path` one key down: `.key` for an identifier, `["key"]` for anything else. */
  private static step(path: string, key: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
  }
}

/** What `g.part(type, spec)` reads off its spec: the instance's name and the template's parts. */
type TemplateSpec = {
  name: string;
  inputs: JsonValue;
  connectors: Readonly<Record<string, GeneratedFrameSpec>>;
  appearance: string | null;
  material: string | null;
};

/**
 * One part template a generator declares: its type, its inputs, its
 * connectors, its appearance and its material — what `g.part(type, spec)`
 * reads — under one canonical identity key.
 *
 * The rules:
 * - **Identity.** Two declarations of one definition with equal type,
 *   inputs, connectors, appearance and material are one template (the
 *   {@link key}): their instances share one part, built once. The
 *   instance's name is no part of it.
 * - **Plain JSON.** Inputs and connectors are plain JSON, copied and frozen
 *   when declared: `build` can read nothing else, so whatever changes a
 *   part's geometry has to be in its inputs — which is what makes a
 *   template's identity say everything about its shapes.
 * - **One build.** {@link build} is the one place a generator's `static
 *   build` runs; the render calls it through the template's body for each
 *   template it does not hold built.
 */
export class GeneratedTemplate {

  /** The detail every build runs at for now (see {@link GeneratorDetail}). */
  static readonly DETAIL: GeneratorDetail = 'full';

  /** What a spec may hold. */
  private static readonly FIELDS = ['name', 'inputs', 'connectors', 'appearance', 'material'];

  /** What a frame may hold. */
  private static readonly FRAME_FIELDS = ['origin', 'z', 'x'];

  private static readonly INPUTS_RULE = 'inputs are plain JSON: numbers, strings, booleans, null, arrays and plain objects';

  private constructor(
    /** The id of the definition that declared it (`wardrobe-unit`, `@acme/cabinets:wardrobe-unit`). */
    readonly definition: string,
    private readonly builder: TemplateBuilder,
    readonly type: string,
    /** The inputs `build` is handed, frozen. */
    readonly inputs: JsonValue,
    /** The connectors each instance carries, by name, frozen. */
    readonly connectors: Readonly<Record<string, GeneratedFrameSpec>>,
    readonly appearance: string | null,
    readonly material: string | null,
    /** The canonical identity key — see {@link GeneratedTemplate.keyOf}. */
    readonly key: string,
  ) {}

  /**
   * Read `g.part(type, spec)`: check the type and every field of the spec,
   * refusing — with a message that leads with `g.part('<type>')` and names
   * the field or the path — anything a template can't be made of, and make
   * the template. The instance's name comes back beside it: `spec.name`,
   * else the type.
   */
  static declare(definition: string, builder: TemplateBuilder, type: unknown, spec: unknown): { template: GeneratedTemplate; name: string } {
    if (typeof type !== 'string' || type.trim() === '') {
      throw new Error(`g.part(): the first argument is the part's type, a non-empty string such as 'door' — build(type, inputs, ctx) is handed it; got ${SchemaValidator.describe(type)}`);
    }
    const where = `g.part('${type}')`;
    const read = GeneratedTemplate.readSpec(where, type, spec);
    const template = new GeneratedTemplate(
      definition, builder, type, read.inputs, read.connectors, read.appearance, read.material,
      GeneratedTemplate.keyOf(definition, type, read),
    );
    return { template, name: read.name };
  }

  /**
   * The canonical identity key of a template: its definition's id, its
   * type, and the canonical JSON of its inputs, its connectors, its
   * appearance and its material (see {@link PlainJson.canonical}). Equal
   * keys, one template.
   */
  static keyOf(definition: string, type: string, spec: Omit<TemplateSpec, 'name'>): string {
    return PlainJson.canonical({
      definition,
      type,
      inputs: spec.inputs,
      connectors: spec.connectors,
      appearance: spec.appearance,
      material: spec.material,
    });
  }

  /**
   * The template's shapes: the generator's `static build(type, inputs,
   * ctx)` run once, at `detail`, in `unit` (the generator's), its result
   * checked — an array of shapes. Throws what `build` throws, or why its
   * result is no shapes.
   */
  build(detail: GeneratorDetail, unit: LengthUnit): Shape[] {
    const ctx: GeneratorBuildContext = Object.freeze({
      detail,
      unit,
      occ: <T>(fn: (scope: OccScope) => T): T => OccScope.run(fn),
    });
    const result = this.builder.build(this.type, this.inputs, ctx);
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('build runs synchronously — it must not be async');
    }
    if (!Array.isArray(result)) {
      throw new Error(`returned ${SchemaValidator.describe(result)} — build returns the part's shapes, an array such as [solid]`);
    }
    for (let i = 0; i < result.length; i++) {
      if (!(result[i] instanceof Shape)) {
        throw new Error(`shape ${i} is ${SchemaValidator.describe(result[i])} — build returns shapes made with fluidcad/sdk/kernel (a Solid, a Face, …)`);
      }
    }
    return result as Shape[];
  }

  /** Who a build's refusals name: `Cabinet.build('door')`. */
  where(): string {
    return `${this.builder.name || 'the generator'}.build('${this.type}')`;
  }

  private static readSpec(where: string, type: string, spec: unknown): TemplateSpec {
    if (spec === undefined) {
      return { name: type, inputs: Object.freeze({}), connectors: Object.freeze({}), appearance: null, material: null };
    }
    if (!FeatureCall.isPlainObject(spec)) {
      throw new Error(`${where}: the second argument describes the part, such as { name: 'Left door', inputs: { width: 300 } } — got ${SchemaValidator.describe(spec)}`);
    }
    for (const field of Object.keys(spec)) {
      if (!GeneratedTemplate.FIELDS.includes(field)) {
        throw new Error(`${where}: unknown field '${field}' — the fields are ${GeneratedTemplate.FIELDS.join(', ')}`);
      }
    }
    const name = spec.name === undefined ? type : GeneratedTemplate.text(where, 'name', spec.name);
    const inputs = spec.inputs === undefined ? {} : spec.inputs;
    try {
      PlainJson.check(inputs, 'inputs', GeneratedTemplate.INPUTS_RULE);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
    return {
      name,
      inputs: PlainJson.frozenCopy(inputs as JsonValue),
      connectors: GeneratedTemplate.readConnectors(where, spec.connectors),
      appearance: spec.appearance === undefined ? null : GeneratedTemplate.text(where, 'appearance', spec.appearance),
      material: spec.material === undefined ? null : GeneratedTemplate.text(where, 'material', spec.material),
    };
  }

  private static text(where: string, field: string, value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${where}: '${field}' must be a non-empty string, got ${SchemaValidator.describe(value)}`);
    }
    return value;
  }

  private static readConnectors(where: string, connectors: unknown): Readonly<Record<string, GeneratedFrameSpec>> {
    if (connectors === undefined) {
      return Object.freeze({});
    }
    if (!FeatureCall.isPlainObject(connectors)) {
      throw new Error(`${where}: 'connectors' holds the part's connectors by name, such as { hinge: { origin: [0, 0, 0], z: [0, 0, 1] } } — got ${SchemaValidator.describe(connectors)}`);
    }
    const out: Record<string, GeneratedFrameSpec> = {};
    for (const [name, frame] of Object.entries(connectors)) {
      if (!CONNECTOR_NAME_PATTERN.test(name)) {
        throw new Error(`${where}: connector '${name}' — a connector's name is a plain identifier, such as 'hinge'`);
      }
      out[name] = GeneratedTemplate.readFrame(`${where}: connectors.${name}`, frame);
    }
    return PlainJson.frozenCopy(out);
  }

  private static readFrame(where: string, frame: unknown): GeneratedFrameSpec {
    if (!FeatureCall.isPlainObject(frame)) {
      throw new Error(`${where} is a frame, { origin: [x, y, z], z: [x, y, z], x: [x, y, z] } — got ${SchemaValidator.describe(frame)}`);
    }
    for (const field of Object.keys(frame)) {
      if (!GeneratedTemplate.FRAME_FIELDS.includes(field)) {
        throw new Error(`${where}: unknown field '${field}' — a frame holds origin, z and x`);
      }
    }
    const spec: GeneratedFrameSpec = {
      origin: GeneratedTemplate.vector(where, 'origin', frame.origin),
      z: GeneratedTemplate.vector(where, 'z', frame.z),
    };
    if (frame.x !== undefined) {
      spec.x = GeneratedTemplate.vector(where, 'x', frame.x);
    }
    try {
      GeneratedFrame.planeOf(spec);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
    return spec;
  }

  private static vector(where: string, field: string, value: unknown): JsonVector {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`${where}: '${field}' must be [x, y, z], three finite numbers — got ${SchemaValidator.describe(value)}`);
    }
    return [value[0], value[1], value[2]];
  }
}

/**
 * The member of a generated part that holds its shapes: an internal row,
 * built at render time like any part member, from its template
 * ({@link GeneratedTemplate.build}) in the generator's unit — the render
 * rescales it with the rest of the part afterwards.
 *
 * A build that fails is the error of the part it belongs to: the part's own
 * row says why, naming the build (`Cabinet.build('door'): …`), and the part
 * holds no shapes. The rest of the render goes on.
 */
export class GeneratedBody extends SceneObject {

  constructor(readonly template: GeneratedTemplate) {
    super();
    this.markInternal();
  }

  build(_context?: BuildSceneObjectContext): void {
    let shapes: Shape[];
    try {
      shapes = this.template.build(GeneratedTemplate.DETAIL, this.getAuthoredUnit());
    } catch (error) {
      const message = `${this.template.where()}: ${error instanceof Error ? error.message : String(error)}`;
      this.getParent()?.setError(message);
      if (KernelTraps.isTrap(error)) {
        // The kernel itself trapped: the render records it on this row as
        // the trap it is, and hears that the engine's memory may be damaged.
        throw error;
      }
      return;
    }
    for (const shape of shapes) {
      this.addShape(shape);
    }
  }

  override createCopy(_remap: Map<SceneObject, SceneObject>): SceneObject {
    return new GeneratedBody(this.template);
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof GeneratedBody) || other.template.key !== this.template.key) {
      return false;
    }
    return super.compareTo(other);
  }

  getType(): string {
    return 'generated-part';
  }

  serialize() {
    return { type: this.template.type };
  }
}

/**
 * The plane a generated part's connector stands on: a frame a generator
 * declared as plain JSON (see {@link GeneratedFrameSpec}), in the part's own
 * coordinates and the generator's unit. An internal row of the part, before
 * its connector.
 */
export class GeneratedFrame extends PlaneObjectBase {

  private readonly plane: Plane;

  constructor(readonly frameName: string, readonly spec: GeneratedFrameSpec) {
    super();
    this.plane = GeneratedFrame.planeOf(spec);
    this.markInternal();
  }

  /**
   * The plane a frame spec names: at `origin`, its normal `z` made unit
   * length, its X `x` squared against it — or, with none, the upright X a
   * connector on a plane of that normal takes. Refuses a zero `z` and an `x`
   * along `z`.
   */
  static planeOf(spec: GeneratedFrameSpec): Plane {
    const z = new Vector3d(spec.z[0], spec.z[1], spec.z[2]);
    if (z.isZero(1e-12)) {
      throw new Error("'z' has no length — it is the connector's axis");
    }
    const normal = z.normalize();
    let x: Vector3d;
    if (spec.x === undefined) {
      x = Plane.uprightXDirection(normal);
    } else {
      const given = new Vector3d(spec.x[0], spec.x[1], spec.x[2]);
      const square = given.isZero(1e-12) ? given : given.normalize().subtract(normal.multiply(given.normalize().dot(normal)));
      if (square.isZero(1e-9)) {
        throw new Error("'x' runs along 'z' — give an X square to the connector's axis, or leave it out");
      }
      x = square.normalize();
    }
    return new Plane(new Point(spec.origin[0], spec.origin[1], spec.origin[2]), x, normal);
  }

  build(_context?: BuildSceneObjectContext): void {
    this.setState('plane', this.plane);
  }

  override createCopy(_remap: Map<SceneObject, SceneObject>): SceneObject {
    return new GeneratedFrame(this.frameName, this.spec);
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof GeneratedFrame) || other.frameName !== this.frameName) {
      return false;
    }
    if (PlainJson.canonical(other.spec) !== PlainJson.canonical(this.spec)) {
      return false;
    }
    return super.compareTo(other);
  }

  override getUniqueType(): string {
    return 'generated-frame';
  }

  serialize() {
    return { frame: this.frameName };
  }
}

/** The units a generated part is made in and read in. */
export type TemplateUnits = Readonly<{ definition: LengthUnit; target: LengthUnit }>;

/**
 * The generated parts a scene holds, by template: one part per template and
 * units, shared by every instance of it — across the occurrences of one
 * definition in the scene too.
 *
 * A template's part is made detached ({@link materialize}) — in no scene —
 * and joins the scene ({@link adopt}) only once the layout that declared it
 * returned: a layout that throws leaves no part of its own behind.
 */
export class GeneratedTemplates {

  private static readonly byScene = new WeakMap<Scene, Map<string, Part>>();

  /** Where a template's part is filed: its identity key and the units it is made and read in. */
  static slotOf(template: GeneratedTemplate, units: TemplateUnits): string {
    return `${template.key}\u0000${units.definition}\u0000${units.target}`;
  }

  /** The part `scene` holds for the template filed at `slot`, if it holds one. */
  static find(scene: Scene, slot: string): Part | undefined {
    return GeneratedTemplates.byScene.get(scene)?.get(slot);
  }

  /**
   * A new part for `template`, detached: named after its type, in the
   * definition's unit and read in the target unit (the render rescales it
   * when they differ), with the template's appearance and material, and its
   * identity in {@link Part.generatedBy}. It holds the body that builds its
   * shapes, then one frame and one connector of that name per connector the
   * template declares. Every row is located at `location` — the
   * `defineAssembly()` that defines it.
   */
  static materialize(template: GeneratedTemplate, units: TemplateUnits, location: SourceLocation | null): Part {
    const part = new Part(template.type);
    part.generatedBy = Object.freeze({ definition: template.definition, type: template.type, key: template.key });
    part.setMaterial(template.material);
    part.setAppearance(template.appearance);
    part.setTargetUnit(units.target);
    const members: SceneObject[] = [new GeneratedBody(template)];
    for (const [name, spec] of Object.entries(template.connectors)) {
      const frame = new GeneratedFrame(name, spec);
      members.push(frame, new Connector(name, frame));
    }
    for (const obj of [part, ...members]) {
      if (location) {
        obj.setSourceLocation(location);
      }
      obj.setUnit(units.definition);
    }
    for (const member of members) {
      part.addChildObject(member);
    }
    return part;
  }

  /**
   * Add a detached template part and its members to `scene`, at the top
   * level, and file it at `slot` — every later declaration of the template
   * in the scene shares it.
   */
  static adopt(scene: Scene, slot: string, part: Part): void {
    scene.runTopLevel(() => {
      scene.addSceneObject(part);
      for (const member of part.getChildren()) {
        scene.addSceneObject(member);
      }
    });
    let parts = GeneratedTemplates.byScene.get(scene);
    if (!parts) {
      parts = new Map();
      GeneratedTemplates.byScene.set(scene, parts);
    }
    parts.set(slot, part);
  }
}
