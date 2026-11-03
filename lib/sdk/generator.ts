import mate, { type MateSide } from "../core/mate.js";
import relation from "../core/relation.js";
import { Instance } from "../features/instance.js";
import { MateBuilder } from "../features/mate.js";
import type { RelationBuilder } from "../features/relation.js";
import { recordInstance } from "../features/insert-records.js";
import type { Part } from "../features/part.js";
import type { SourceLocation } from "../common/scene-object.js";
import type { Shape } from "../common/shape.js";
import type { AssemblyInstance, AssemblyMate, AssemblyScene, MateType, RelationType } from "../rendering/assembly-scene.js";
import { Axis, toAxis, type AxisLike } from "../math/axis.js";
import { Quaternion } from "../math/quaternion.js";
import { Vector3d } from "../math/vector3d.js";
import { rad } from "../helpers/math-helpers.js";
import { unitFactor } from "../units/units.js";
import { TextDigest } from "../common/text-digest.js";
import { FeatureCall } from "./call-shape.js";
import { FeatureNamespaces } from "./feature-namespaces.js";
import { SchemaValidator, ValueSchema } from "./value-schema.js";
import type { ScalarParamSpec } from "./meta.js";
import type { ValuesOf } from "./feature-params.js";
import type { FeatureValues } from "./feature-inputs.js";
import {
  GeneratedTemplate, GeneratedTemplates,
  type GeneratedFrameSpec, type GeneratorBuildContext, type JsonValue, type TemplateBuild, type TemplateBuilder,
} from "./generated-template.js";

/** The values a generator declares: typed-in values only — numbers, lengths, angles, booleans, selects, radios, texts. */
export type GeneratorParams = { readonly [name: string]: ScalarParamSpec };

/**
 * What `Generator.with(params)` returns: an abstract `Generator` whose
 * values are typed by `params`, which it carries as `static params`.
 */
export type GeneratorWith<P extends GeneratorParams> =
  (abstract new (values: ValuesOf<P>) => Generator<ValuesOf<P>>) & { readonly params: P };

/** What `g.part(type, spec)` is told about one part beside its type. */
export type GeneratedPartSpec = {
  /** The instance's name — what its row reads; the type when left out. Not part of the template's identity. */
  name?: string;
  /**
   * Everything the part's geometry depends on, as plain JSON (numbers,
   * strings, booleans, null, arrays, plain objects): `build(type, inputs,
   * ctx)` is handed it and nothing else. `{}` when left out.
   */
  inputs?: JsonValue;
  /** The part's connectors by name, each a frame in the part's own coordinates. */
  connectors?: Readonly<Record<string, GeneratedFrameSpec>>;
  /** The part's appearance id (`'oak'`, `'steel'`, …), as `part(…).appearance(id)` takes it. */
  appearance?: string;
  /** The part's material id, as `part(…).material(id)` takes it. */
  material?: string;
};

/** A starting pose for a generated part: where it stands in the generated assembly before its joints are solved. */
export type GeneratedPose = {
  /** Its origin, `[x, y, z]`, in the generator's unit. `[0, 0, 0]` when left out. */
  position?: readonly [number, number, number];
  /**
   * Its turn, `[x, y, z]` in degrees: about X, then Y, then Z, about the
   * part's origin — as `.rotate('x', a).rotate('y', b).rotate('z', c)`
   * turns an inserted part. None when left out.
   */
  rotation?: readonly [number, number, number];
};

/**
 * The base of a generator: a class that makes an insertable sub-assembly by
 * code — its parts, their connectors, their starting poses, and the joints
 * between them — from one object of values. `defineAssembly()` makes it
 * insertable.
 *
 * ```js
 * class Cabinet extends Generator.with({
 *   width: { type: 'length', default: 600, min: 300 },
 *   doorAngle: { type: 'angle', default: 110, min: 90, max: 170 },
 * }) {
 *   static id = 'cabinet';
 *   layout(g) {                                   // plain JavaScript
 *     const { width, doorAngle } = this.values;
 *     const carcass = g.part('carcass', { name: 'Carcass', inputs: { width },
 *       connectors: { hinge: { origin: [0, 0, 0], z: [0, 0, 1] } } }).grounded();
 *     const door = g.part('door', { name: 'Door', inputs: { width },
 *       connectors: { hinge: { origin: [0, 0, 0], z: [0, 0, 1] } } });
 *     g.mate('revolute', carcass.connectors.hinge, door.connectors.hinge).limits(0, doorAngle);
 *     return { carcass, door };                    // occurrence.parts
 *   }
 *   static build(type, inputs, ctx) {              // OpenCascade, one part
 *     return type === 'carcass' ? carcassBodies(ctx, inputs) : doorBodies(ctx, inputs);
 *   }
 * }
 * ```
 *
 * Two phases:
 * - **`layout(g)`** runs for every insert, at module evaluation. It reads
 *   `this.values` — the insert's values by id, checked and defaulted — and
 *   declares the parts with `g.part()`, the joints with `g.mate()` and
 *   `g.relation()`. Its return value is `occurrence.parts`. A throw from it
 *   is the insert's build error, and leaves nothing of the layout behind.
 * - **`static build(type, inputs, ctx)`** runs at render time, once for
 *   each part template (see {@link GeneratorLayout.part}), and returns the
 *   part's shapes. Being static it reads only its type and inputs, so
 *   whatever changes a part's geometry has to be in its inputs. A throw from
 *   it is the build error of that part's row.
 *
 * Builds are kept across renders: a template the last render held, or one
 * an earlier render built and the engine still caches, is not built again.
 * What a build is kept by is the template's identity (type, inputs,
 * connectors, appearance, material), the units, `ctx.detail` — a render
 * still being dragged asks for `'preview'`, every other for `'full'`, and
 * each tier is built and kept apart — and the generator's code: an edit of
 * the class, or of a module its module imports, builds everything again.
 *
 * Every length a generator writes — values, inputs, connector frames, poses,
 * mate offsets, slider limits, rack ratios — is in its defining module's
 * unit; the engine converts them all into the unit of the assembly that
 * inserts it.
 */
export abstract class Generator<V extends FeatureValues = FeatureValues> {

  /**
   * The generator's id (`'cabinet'`): dot-separated names of letters,
   * digits, `-` and `_`, each starting with a letter. With the package
   * that defines it, it names the generated assembly's definition, and so
   * every part template it declares.
   */
  static id: string;

  /** Each class `Generator.with()` made, with its checked values. */
  private static readonly schemas = new WeakMap<Function, ValueSchema>();

  /**
   * Each class `Generator.with()` made, with where the code that called it
   * comes from: the stamp of the installed package whose module was
   * evaluating (`FeatureNamespaces.currentStamp`), else `workspace`.
   */
  private static readonly origins = new WeakMap<Function, string>();

  /** Each generator class's code base, made on first ask (see {@link codeBaseOf}). */
  private static readonly codeBases = new WeakMap<Function, string>();

  private static readonly ID_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;

  /**
   * A base for a generator class that declares its values: the class
   * extends it, and `this.values` is typed from `params`. The values are
   * declared as a feature's are (`Feature.with()`): types, defaults,
   * ranges, options with pictures, `visibleWhen`, groups. A generator takes
   * typed-in values only — a picked value (`picker`) is refused, naming
   * it: the parts a generator makes are placed by its layout and mated by
   * whoever inserts it.
   *
   * The declarations are checked here, so a bad one fails where the module
   * loads.
   */
  static with<const P extends GeneratorParams>(params: P): GeneratorWith<P> {
    if (!FeatureCall.isPlainObject(params)) {
      throw new Error("Generator.with() takes the generator's values by name, such as { width: { type: 'length', default: 600 } }");
    }
    const schema = ValueSchema.declare(params, 'Generator.with()');
    const picked = schema.pickerNames();
    if (picked.length > 0) {
      throw new Error(`Generator.with(): '${picked[0]}' is a picked value — a generator takes typed-in values only `
        + '(numbers, lengths, angles, booleans, selects, radios, texts): the assembly that inserts it mates its parts');
    }
    const frozen = SchemaValidator.frozenCopy(params) as P;
    abstract class GeneratorWithValues extends Generator {
      static readonly params = frozen;
    }
    Generator.schemas.set(GeneratorWithValues, schema);
    // Read while the class's module evaluates: `class X extends
    // Generator.with({ … })` runs here, in the module that holds X's code.
    Generator.origins.set(GeneratorWithValues, FeatureNamespaces.currentStamp() ?? 'workspace');
    return GeneratorWithValues as unknown as GeneratorWith<P>;
  }

  /**
   * @internal The fixed part of a generator class's code version (see
   * `GeneratedCode`): `<origin>:<digest>` — where its code comes from (an
   * installed package's stamp, else `workspace`) and a digest of the text of
   * every class of its chain, so an edit of its `layout` or `build` is a new
   * version whether or not it was saved.
   */
  static codeBaseOf(generatorClass: Function): string {
    const known = Generator.codeBases.get(generatorClass);
    if (known !== undefined) {
      return known;
    }
    let origin = 'workspace';
    const texts: string[] = [];
    for (let cls: unknown = generatorClass; typeof cls === 'function' && cls !== Function.prototype; cls = Object.getPrototypeOf(cls)) {
      const recorded = Generator.origins.get(cls);
      if (recorded !== undefined) {
        origin = recorded;
      }
      texts.push(Function.prototype.toString.call(cls));
    }
    const base = `${origin}:${TextDigest.of(texts.join('\n'))}`;
    Generator.codeBases.set(generatorClass, base);
    return base;
  }

  /**
   * @internal The checked values of a generator class: those the
   * `Generator.with()` it extends declared. Null for a class that extends
   * `Generator` directly.
   */
  static schemaOf(generatorClass: Function): ValueSchema | null {
    for (let cls: unknown = generatorClass; typeof cls === 'function' && cls !== Generator; cls = Object.getPrototypeOf(cls)) {
      const schema = Generator.schemas.get(cls);
      if (schema) {
        return schema;
      }
    }
    return null;
  }

  /** @internal The `static id` a generator class declares, refusing a missing or ill-formed one. */
  static plainIdOf(generatorClass: { id?: unknown; name?: string }): string {
    const id = generatorClass.id;
    const name = generatorClass.name || 'The generator';
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${name} needs a static id — the generator's type, such as 'cabinet'`);
    }
    if (!id.split('.').every(segment => Generator.ID_SEGMENT.test(segment))) {
      throw new Error(`the id '${id}' is not well formed — dot-separated names of letters, digits, '-' and '_', each starting with a letter, such as 'cabinet'`);
    }
    return id;
  }

  private readonly frozenValues: Readonly<V>;

  /** The engine constructs a generator from an insert's values, checked and defaulted; a subclass declares no constructor. */
  constructor(values: V) {
    this.frozenValues = SchemaValidator.frozenCopy({ ...values }) as Readonly<V>;
  }

  /** The insert's values by id, every declared value present, defaults filled, frozen. */
  get values(): Readonly<V> {
    return this.frozenValues;
  }

  /**
   * Declare the generated assembly: its parts (`g.part()`), their joints
   * (`g.mate()`, `g.relation()`). Plain JavaScript, synchronous; runs for
   * every insert. What it returns is `occurrence.parts` — return the
   * handles the inserting assembly may mate to: `return { carcass }`.
   */
  abstract layout(g: GeneratorLayout): unknown;

  /**
   * Build one part template: the shapes of a part of `type` made from
   * `inputs` (the plain JSON `g.part()` was given), in `ctx.unit`, at the
   * part's own origin. Runs at render time, once per template; must be
   * synchronous. Run raw OpenCascade code inside `ctx.occ(fn)`.
   */
  static build(type: string, _inputs: JsonValue, _ctx: GeneratorBuildContext): Shape[] {
    throw new Error(`${this.name || 'the generator'} implements no static build(type, inputs, ctx) — it builds every part type its layout declares, here '${type}'`);
  }
}

/** @internal What a layout run works with: the definition, where its records go, and the units. */
export type GeneratorLayoutRun = Readonly<{
  /** The definition's id (`cabinet`, `@acme/cabinets:cabinet`). */
  definition: string;
  /** The generator class, whose `static build` its templates run. */
  builder: TemplateBuilder;
  /** Where the run's records are located: the insert, or `defineAssembly()` when its own file renders. */
  location: SourceLocation | null;
  /** Where its parts are located: `defineAssembly()`. */
  templateLocation: SourceLocation | null;
  /**
   * What its templates' parts are built with: the unit the generator writes
   * in and the unit of the assembly it is inserted into, the scene's detail
   * tier, and the definition's code version.
   */
  build: TemplateBuild;
}>;

/**
 * What a generator's `layout(g)` is handed: the generated assembly being
 * declared. `g.part()` adds a part, `g.mate()` a joint between two of its
 * parts' connectors, `g.relation()` a coupling of two of its joints — the
 * same records `insert()`, `mate()` and `relation()` make, in the
 * occurrence's scope.
 *
 * The rules:
 * - **Templates are shared by identity.** Each `g.part()` is an instance
 *   of a template — its type, inputs, connectors, appearance and material.
 *   Two calls that agree on all five share one part, built once
 *   (`build` runs once for both doors of a pair); across the occurrences of
 *   one definition in a scene too. The name is each instance's own.
 * - **Lengths are the generator's.** Connector frames, poses, mate offsets,
 *   slider limits and rack ratios are in the generator's unit, as its
 *   values and inputs are; the engine converts them.
 * - `g` serves its layout only: it refuses every call once the layout has
 *   returned.
 */
export class GeneratorLayout {

  /** Templates this layout made that the scene doesn't hold yet, by slot, in first-use order. */
  private readonly pending = new Map<string, Part>();

  private open = true;

  /** How many parts the layout added (`g.part()` calls) — what a build report counts. */
  private instances = 0;

  /** @internal */
  constructor(private readonly scene: AssemblyScene, private readonly run: GeneratorLayoutRun) {}

  /**
   * Add a part of `type` to the generated assembly and return its handle:
   * `.grounded()` fixes it in the assembly's frame (a carcass needs no
   * joint), `.pose()` sets where it starts, `.name()` renames it, and
   * `.connectors.<name>` are its connectors, for `g.mate()` — and for the
   * inserting assembly's `mate()` when the layout returns the handle.
   *
   * `spec` (see {@link GeneratedPartSpec}): `inputs`, plain JSON, are what
   * `build(type, inputs, ctx)` is handed; `connectors` are frames in the
   * part's own coordinates; `appearance` and `material` are ids. Anything
   * else in the inputs — a function, a class's object, `undefined`, a number
   * that isn't finite — is refused, naming where it sits.
   */
  part(type: string, spec?: GeneratedPartSpec): GeneratedInstance {
    this.ensureOpen('g.part()');
    const { template, name } = GeneratedTemplate.declare(this.run.definition, this.run.builder, type, spec);
    const part = this.templateFor(template);
    const record = recordInstance(this.scene, part, this.run.location ?? undefined, { name });
    this.instances++;
    return new GeneratedInstance(record, this.factor());
  }

  /**
   * Join two of the assembly's parts, as `mate()` does: the same types,
   * the same sides (`handle.connectors.<name>`), the same builder —
   * `.limits()`, `.flip()`, `.rotate()`, `.offset()`, `.name()`. Offsets and
   * slider limits are lengths in the generator's unit.
   */
  mate(type: MateType, a: MateSide, b: MateSide): GeneratedMateBuilder {
    this.ensureOpen('g.mate()');
    const record = mate(type, a, b).getRecord();
    record.sourceLocation = this.run.location ?? undefined;
    return new GeneratedMateBuilder(record, this.scene, this.factor());
  }

  /**
   * Couple two of the assembly's joints, as `relation()` does: `'gear'`
   * (turns of B per turn of A) or `'rack-and-pinion'` (B's travel per turn
   * of A, a length in the generator's unit). Both mates are the layout's.
   */
  relation(type: RelationType, a: MateBuilder, b: MateBuilder, ratio: number): RelationBuilder {
    this.ensureOpen('g.relation()');
    const scaled = type === 'rack-and-pinion' && typeof ratio === 'number' ? ratio * this.factor() : ratio;
    const builder = relation(type, a, b, scaled);
    builder.getRecord().sourceLocation = this.run.location ?? undefined;
    return builder;
  }

  /** @internal The layout returned: the templates it made join the scene, and `g` closes. */
  commit(): void {
    this.open = false;
    for (const [slot, part] of this.pending) {
      GeneratedTemplates.adopt(this.scene, slot, part);
    }
    this.pending.clear();
  }

  /** @internal The layout threw: `g` closes, and the templates it made are dropped unbuilt. */
  discard(): void {
    this.open = false;
    this.pending.clear();
  }

  /** @internal How many parts the layout added. */
  instanceCount(): number {
    return this.instances;
  }

  /**
   * The part of `template` in this scene: the one the scene holds already
   * (an earlier occurrence declared it), the one this layout made already,
   * else a new one, made detached and kept until the layout returns.
   */
  private templateFor(template: GeneratedTemplate): Part {
    const slot = GeneratedTemplates.slotOf(template, this.run.build);
    const held = GeneratedTemplates.find(this.scene, slot) ?? this.pending.get(slot);
    if (held) {
      return held;
    }
    const part = GeneratedTemplates.materialize(template, this.run.build, this.run.templateLocation);
    this.pending.set(slot, part);
    return part;
  }

  /** Multiplier taking the generator's lengths into the inserting assembly's unit. */
  private factor(): number {
    return unitFactor(this.run.build.definition, this.run.build.target);
  }

  private ensureOpen(call: string): void {
    if (!this.open) {
      throw new Error(`${call}: the layout has returned — g declares parts and joints only while layout(g) runs`);
    }
  }
}

/**
 * The handle `g.part()` returns: an inserted part's handle (`Instance`) whose
 * lengths are the generator's — `.pose()`, `.translate()` and the axis of
 * `.rotate()` are converted into the inserting assembly's unit.
 */
export class GeneratedInstance extends Instance<unknown> {

  /** @internal */
  constructor(record: AssemblyInstance, private readonly factor: number) {
    super(record);
  }

  /**
   * Where the part starts, in the generated assembly's frame: its origin at
   * `position` and turned by `rotation` (see {@link GeneratedPose}). A
   * starting pose, never a constraint: the joints decide where a jointed
   * part goes, and a grounded part stays at it.
   */
  pose(pose: GeneratedPose): this {
    if (!FeatureCall.isPlainObject(pose)) {
      throw new Error(`.pose(): takes { position: [x, y, z], rotation: [x, y, z] } — got ${SchemaValidator.describe(pose)}`);
    }
    for (const field of Object.keys(pose)) {
      if (field !== 'position' && field !== 'rotation') {
        throw new Error(`.pose(): unknown field '${field}' — a pose holds position and rotation`);
      }
    }
    const position = pose.position === undefined ? [0, 0, 0] : GeneratedInstance.triple('position', pose.position);
    const rotation = pose.rotation === undefined ? [0, 0, 0] : GeneratedInstance.triple('rotation', pose.rotation);
    let turn = Quaternion.identity();
    const axes = [Vector3d.unitX(), Vector3d.unitY(), Vector3d.unitZ()];
    for (let i = 0; i < 3; i++) {
      if (rotation[i] !== 0) {
        turn = Quaternion.fromAxisAngle(axes[i], rad(rotation[i])).multiply(turn);
      }
    }
    this.record.quaternion = { x: turn.x, y: turn.y, z: turn.z, w: turn.w };
    this.record.position = { x: position[0] * this.factor, y: position[1] * this.factor, z: position[2] * this.factor };
    return this;
  }

  /** Move the part's starting pose, in the generator's unit. */
  override translate(x: number, y: number = 0, z: number = 0): this {
    return super.translate(x * this.factor, y * this.factor, z * this.factor);
  }

  /** Turn the part's starting pose about `axis` (its origin in the generator's unit) by `angleDegrees`. */
  override rotate(axis: AxisLike, angleDegrees: number): this {
    const resolved = toAxis(axis);
    return super.rotate(new Axis(resolved.origin.multiplyScalar(this.factor), resolved.direction), angleDegrees);
  }

  private static triple(field: string, value: unknown): [number, number, number] {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`.pose(): '${field}' must be [x, y, z], three finite numbers — got ${SchemaValidator.describe(value)}`);
    }
    return [value[0], value[1], value[2]];
  }
}

/**
 * The builder `g.mate()` returns: `mate()`'s, whose lengths are the
 * generator's — `.offset()` and a slider's `.limits()` are converted into
 * the inserting assembly's unit; angles stay as they are.
 */
export class GeneratedMateBuilder extends MateBuilder {

  /** @internal */
  constructor(record: AssemblyMate, scene: AssemblyScene, private readonly factor: number) {
    super(record, scene);
  }

  /** Shift the second side in the driver's frame, in the generator's unit. */
  override offset(x: number, y: number = 0, z: number = 0): this {
    return super.offset(x * this.factor, y * this.factor, z * this.factor);
  }

  /** The joint's travel: a revolute's in degrees, a slider's in the generator's unit. */
  override limits(min: number, max: number): this {
    if (this.getRecord().type === 'slider') {
      return super.limits(min * this.factor, max * this.factor);
    }
    return super.limits(min, max);
  }
}
