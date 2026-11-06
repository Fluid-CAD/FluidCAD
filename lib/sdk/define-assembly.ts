import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { Assembly } from "../features/assembly.js";
import { Part, type GeneratedValues } from "../features/part.js";
import { recordInstance } from "../features/insert-records.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import type { SourceLocation } from "../common/scene-object.js";
import { AssemblyScene, type AssemblyOccurrence } from "../rendering/assembly-scene.js";
import type { ParamOverrides, ParamScope, ParamVal } from "../param-registry.js";
import { getActiveUnit, getUnitRegistry } from "../units/registry.js";
import { FeatureNamespaces } from "./feature-namespaces.js";
import type { FeatureValues } from "./feature-inputs.js";
import type { ParamSpec } from "./meta.js";
import { FeatureLayouts, type FeatureLayout, type FeatureStaticItem } from "./layout.js";
import { SchemaValidator, ValueSchema } from "./value-schema.js";
import { Generator, GeneratorLayout, type GeneratorParams } from "./generator.js";
import { GeneratedCode } from "./generated-code.js";
import { GeneratedBuildReports } from "../rendering/generated-build-report.js";
import type { GeneratorBuildContext, TemplateBuild, TemplateBuilder, TemplateUnits } from "./generated-template.js";
import {
  GeneratedMetaValidator, type GeneratedAssetModules, type GeneratedMarker, type GeneratedMeta, type GeneratedSchema,
  type ResolvedGeneratedMeta,
} from "./generated-schema.js";
import { ClassModules } from "./class-modules.js";
import type { Shape } from "../common/shape.js";

/** A generator class `defineAssembly()` takes: one that extends `Generator.with({ … })`. */
export type DefinableGeneratorClass = (abstract new (values: any) => Generator<any>) & {
  readonly id: string;
  readonly params: GeneratorParams;
  build(type: string, inputs: any, ctx: GeneratorBuildContext): Shape[];
};

/** What a generator class's `layout(g)` returns: its generated assembly's `occurrence.parts`. */
export type LayoutResult<C> = C extends abstract new (values: any) => infer G
  ? G extends { layout(...args: any[]): infer R } ? R : unknown
  : unknown;

/**
 * What `defineAssembly()` is told about a generated assembly beside its
 * generator class: its label, description and icon, its dialog's `width`
 * and `aside`, and a layout over the generator's values, so a misspelled
 * value is an error in the editor.
 */
export type DefineAssemblyMeta<P extends GeneratorParams = GeneratorParams> = Omit<GeneratedMeta, 'layout'> & {
  /**
   * The dialog's rows over the generator's values (see `FeatureLayout`),
   * images relative to this module. Left out, they are derived from the
   * values' `group` and `tab`.
   */
  layout?: FeatureLayout<P>;
};

/** A generator class as the definition holds it: constructible from values, and its builds. */
type GeneratorConstructor = (new (values: FeatureValues) => Generator<FeatureValues>) & TemplateBuilder;

/**
 * An insertable sub-assembly made by code: what `defineAssembly()` returns.
 * It is an assembly definition like one `assembly()` makes — `insert()`
 * takes it, the part catalog lists it, `occurrence.parts` exposes what it
 * returns — whose body is its generator's `layout(g)`, run with the
 * insert's values.
 *
 * The rules:
 * - **Values by id.** `insert(cabinet, { width: 900 })` names the
 *   generator's values by id, not by label. Each is checked and defaulted
 *   as a feature's call checks it ({@link ValueSchema}).
 * - **Bad values and a failed layout are the insert's build error.** A name
 *   the generator doesn't take, a value its declaration refuses, a
 *   configuration name (a generated assembly has none), and a throw from
 *   `layout(g)` leave the occurrence one empty part whose row says why, at
 *   the insert — and nothing else of the layout. The render goes on.
 * - **Parts are engine-owned.** Each `g.part()` is an instance of a part
 *   template, built at render time by the generator's `static build`;
 *   templates with equal type, inputs, connectors, appearance and material
 *   share one part (see {@link GeneratorLayout}). No `part()` declares them,
 *   so the part rules don't apply to them.
 * - **Lengths are the definition's.** The generator writes in its defining
 *   module's unit; inserted into an assembly of another unit, its parts are
 *   rescaled and its poses, offsets and limits converted. The insert's
 *   values are not converted: they are the generator's numbers.
 * - Rendered on its own (the defining file), it runs at the assembly's root
 *   with every value at its default.
 */
export class GeneratedAssemblyDefinition<T = unknown> extends Assembly<T> {

  /** What marks the definition as generated, read by duck typing: an assembly, keyed by its generator's id. */
  readonly generated: GeneratedMarker;

  /** The schema, made on first ask. */
  private schemaSnapshot: GeneratedSchema | null = null;

  /** The fixed part of its code version: the generator's origin and class digest (`Generator.codeBaseOf`). */
  private readonly codeBase: string;

  private constructor(
    private readonly generatorClass: GeneratorConstructor,
    /** The generator's values: the interface an insert takes by id. */
    private readonly values: ValueSchema,
    private readonly meta: ResolvedGeneratedMeta,
    location: SourceLocation | null,
  ) {
    super(meta.name, () => undefined as T, location);
    this.generated = Object.freeze({ kind: 'assembly', id: FeatureNamespaces.keyOf(generatorClass, Generator.plainIdOf(generatorClass)) });
    this.codeBase = Generator.codeBaseOf(generatorClass);
    // Which module defines it: a change to that module, or to one it
    // imports, gives its templates a new code version (GeneratedCode).
    GeneratedCode.noteDefinition(this.generated.id, location?.filePath);
  }

  /**
   * Check `generatorClass` and `meta` and make the definition, refusing —
   * with a message that names `defineAssembly(<class>)` and the field —
   * anything a generated assembly can't be made from: a class that doesn't
   * extend `Generator.with({ … })`, a missing or ill-formed `static id`, no
   * `layout(g)`, no `static build`, and bad metadata.
   */
  static define(generatorClass: unknown, meta: unknown, location: SourceLocation | null): GeneratedAssemblyDefinition {
    if (typeof generatorClass !== 'function' || generatorClass === Generator || !(generatorClass.prototype instanceof Generator)) {
      throw new Error(`defineAssembly(): the first argument is the generator's class, one that extends Generator.with({ … }), got ${SchemaValidator.describe(generatorClass)}`);
    }
    const name = generatorClass.name || 'the class';
    const where = generatorClass.name ? `defineAssembly(${generatorClass.name})` : 'defineAssembly()';
    const values = Generator.schemaOf(generatorClass);
    if (values === null) {
      throw new Error(`${where}: ${name} declares no values — declare them with Generator.with({ … }): class ${name} extends Generator.with({ width: { type: 'length', default: 600 } })`);
    }
    try {
      Generator.plainIdOf(generatorClass as { id?: unknown; name?: string });
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
    if (typeof (generatorClass.prototype as { layout?: unknown }).layout !== 'function') {
      throw new Error(`${where}: ${name} implements no layout(g) — it declares the assembly's parts and joints: layout(g) { const carcass = g.part('carcass', { … }); … }`);
    }
    if ((generatorClass as unknown as TemplateBuilder).build === Generator.build) {
      throw new Error(`${where}: ${name} implements no static build(type, inputs, ctx) — it builds each part its layout declares: static build(type, inputs, ctx) { return [solid]; }`);
    }
    // Claimed while its module evaluates: a class an installed package
    // defines is keyed by the package, as a feature class is.
    FeatureNamespaces.claim(generatorClass);
    const resolved = new GeneratedMetaValidator(where, meta, 'assembly').resolve(values.params as Record<string, ParamSpec>);
    return new GeneratedAssemblyDefinition(generatorClass as unknown as GeneratorConstructor, values, resolved, location);
  }

  /**
   * The definition's schema as plain JSON (see {@link GeneratedSchema}): the
   * values an insert takes, by id; the dialog's rows — the author's
   * `layout`, else derived from the values' `group` and `tab` — and its
   * width and aside, as the metadata gives them; the label, description and
   * icon. A generated assembly carries no connectors of its own. A fresh
   * copy on each call.
   */
  getSchema(): GeneratedSchema {
    if (this.schemaSnapshot === null) {
      this.schemaSnapshot = this.snapshot();
    }
    return JSON.parse(JSON.stringify(this.schemaSnapshot)) as GeneratedSchema;
  }

  /**
   * @internal Where the schema's images resolve (see `GeneratedAssetModules`):
   * this definition's module — where its `defineAssembly()` call is — and
   * the module that declared its class's values. Read with
   * `GeneratedSchemas.modulesOf` by a host that serves or packs the images.
   */
  assetModules(): GeneratedAssetModules {
    const definition = this.getSourceLocation()?.filePath ?? null;
    return Object.freeze({ definition, class: ClassModules.of(this.generatorClass) });
  }

  /**
   * The defining file's render: the layout at the assembly's root, every
   * value at its default. A value without a default, or a layout that
   * throws, leaves one empty part saying so, at `defineAssembly()`.
   */
  override run(): T {
    return this.runGenerated({}, undefined, this.getSourceLocation()).parts;
  }

  /**
   * The layout for an insert, with no occurrence record to fill (see
   * {@link runOccurrence}, the insert path): `scope` is empty — a generated
   * assembly has no `param()` interface.
   */
  override runScoped(overrides: ParamOverrides, configuration?: string): { parts: T; scope: ParamScope } {
    const { parts } = this.runGenerated(overrides, configuration, null);
    return { parts, scope: { overrides: new Map(), collected: new Map(), consumed: new Set() } };
  }

  /**
   * The insert path, inside the occurrence's scope: the values checked by
   * id and completed, the generator's layout run with them, and its parts
   * added to the scene once it returned. The record learns the definition
   * and the values (`record.generated`). A refusal — a bad value, a
   * configuration name, a throw from the layout — leaves the occurrence one
   * empty part whose build error is reported at the insert.
   */
  override runOccurrence(record: AssemblyOccurrence, overrides: ParamOverrides, configuration?: string): T {
    const { parts, generated } = this.runGenerated(overrides, configuration, record.sourceLocation ?? null);
    record.generated = generated;
    return parts;
  }

  /**
   * Run the layout for `read` — the values by id — in the current scope of
   * the current assembly scene. Records and refusals are located at
   * `location`. Its time, values check included, goes on the scene's build
   * report (`GeneratedBuildReports`).
   */
  private runGenerated(
    read: Readonly<Record<string, unknown>>,
    configuration: string | undefined,
    location: SourceLocation | null,
  ): { parts: T; generated: GeneratedValues } {
    this.hasRun = true;
    const scene = getCurrentScene();
    if (!(scene instanceof AssemblyScene)) {
      throw new Error(`${this.subject()}: a generated assembly is inserted into an assembly — insert(def, { … }) in an *.assembly.js file`);
    }
    const start = performance.now();
    const timed = (parts: number, refused: boolean): void => {
      GeneratedBuildReports.recordLayout(scene, {
        definition: this.generated.id,
        assembly: this.assemblyName,
        ...(location ? { sourceLocation: { ...location } } : {}),
        ms: performance.now() - start,
        parts,
        refused,
      });
    };
    const build = this.build(scene);
    let values: FeatureValues;
    let given: Record<string, ParamVal>;
    try {
      if (configuration !== undefined) {
        throw new Error(`${this.subject()}: '${configuration}' names a configuration, and a generated assembly has none — insert it with its values, such as insert(def, { … })`);
      }
      ({ values, given } = this.valuesOf(read));
    } catch (error) {
      this.refuseInto(scene, (error as Error).message, location, build);
      timed(0, true);
      return { parts: {} as T, generated: { definition: this.generated.id, values: { ...read } as Record<string, ParamVal> } };
    }
    const generated: GeneratedValues = { definition: this.generated.id, values: given };
    const mark = scene.markRecords();
    const layout = new GeneratorLayout(scene, {
      definition: this.generated.id,
      builder: this.generatorClass,
      location,
      templateLocation: this.getSourceLocation(),
      build,
    });
    try {
      const generator = new this.generatorClass(values);
      const parts = generator.layout(layout);
      if (parts !== null && typeof parts === 'object' && typeof (parts as { then?: unknown }).then === 'function') {
        throw new Error('layout(g) runs synchronously — it must not be async');
      }
      layout.commit();
      timed(layout.instanceCount(), false);
      return { parts: parts as T, generated };
    } catch (error) {
      // Nothing of a failed layout stays: its records go, and its parts —
      // detached until it returned — are dropped unbuilt.
      layout.discard();
      scene.discardRecordsSince(mark);
      if (error instanceof BreakpointHit) {
        throw error;
      }
      this.refuseInto(scene, `${this.subject()}: ${error instanceof Error ? error.message : String(error)}`, location, build);
      timed(0, true);
      return { parts: {} as T, generated };
    }
  }

  /**
   * The values an insert passes, by id, checked and completed — every
   * declared value that holds one, defaults filled, in declaration order:
   * what an occurrence record carries and what a host reports it rendered.
   * Throws the insert path's refusal for a name the generator doesn't take
   * and a value its declaration refuses.
   */
  completedValues(read: Readonly<Record<string, unknown>>): Record<string, ParamVal> {
    return this.valuesOf(read).given;
  }

  /**
   * The values an insert passed, by id, checked and completed: `values`
   * every declared value present, defaults filled — what the generator is
   * constructed from — and `given` those that hold a value, in declaration
   * order — what the record carries. Refuses a name the generator doesn't
   * take and a value its declaration refuses. The one place the values are
   * checked: {@link completedValues} reads them here too.
   */
  private valuesOf(read: Readonly<Record<string, unknown>>): { values: FeatureValues; given: Record<string, ParamVal> } {
    const subject = this.subject();
    this.values.refuseUnknown(subject, read);
    const completed = this.values.complete(subject, read);
    const given: Record<string, ParamVal> = {};
    for (const name of this.values.names()) {
      const value = completed[name];
      if (value !== undefined && value !== null) {
        given[name] = value as ParamVal;
      }
    }
    return { values: { ...completed }, given };
  }

  /**
   * A refused occurrence: one empty part, named after the assembly, whose
   * build error is `message`, reported at `location` — the insert — in the
   * current scope.
   */
  private refuseInto(scene: AssemblyScene, message: string, location: SourceLocation | null, units: TemplateUnits): void {
    const refused = new Part(this.assemblyName);
    if (location) {
      refused.setSourceLocation(location);
    }
    refused.setUnit(units.definition);
    refused.setTargetUnit(units.target);
    refused.refuse(message);
    scene.runTopLevel(() => {
      scene.startProgressiveContainer(refused);
      scene.endProgressiveContainer();
    });
    recordInstance(scene, refused, location ?? undefined, { name: this.assemblyName });
  }

  /**
   * What the layout's templates are built with: the unit the generator
   * writes in — its defining module's: that file's `unit()`, else its
   * project's — and the unit it is read in, the active one (the inserting
   * assembly's); the scene's detail tier; and the definition's code
   * version, read now (`GeneratedCode.versionOf`).
   */
  private build(scene: AssemblyScene): TemplateBuild {
    return Object.freeze({
      definition: getUnitRegistry().resolve(this.getSourceLocation()?.filePath),
      target: getActiveUnit(),
      detail: scene.detail,
      code: GeneratedCode.versionOf(this.generated.id, this.codeBase),
    });
  }

  /** Who the insert's refusals name: the assembly. */
  private subject(): string {
    return `assembly '${this.assemblyName}'`;
  }

  private snapshot(): GeneratedSchema {
    const layout = this.meta.layout ?? FeatureLayouts.derive(this.values.params);
    const aside = this.meta.aside;
    return SchemaValidator.defined({
      kind: 'assembly',
      definitionKind: 'generated',
      id: this.generated.id,
      label: this.meta.label,
      description: this.meta.description,
      icon: this.meta.icon,
      params: this.values.snapshot(),
      layout: JSON.parse(JSON.stringify(layout)) as FeatureLayout,
      width: this.meta.width,
      aside: aside === undefined ? undefined : JSON.parse(JSON.stringify(aside)) as FeatureStaticItem[],
      connectors: [],
      assetBase: aside === undefined ? { layout: 'definition' } : { layout: 'definition', aside: 'definition' },
    }) as GeneratedSchema;
  }
}

/**
 * Make an insertable sub-assembly from a generator: an assembly definition
 * whose body is the generator's `layout(g)`, run with the values an
 * `insert()` passes by id — its parts, their connectors and the joints
 * between them made by code. The generator's values are the assembly's
 * interface: the same values, defaults, ranges, options and pictures a
 * feature declares, checked the same way.
 *
 * ```js
 * // assemblies/cabinet.assembly.js
 * import { defineAssembly } from 'fluidcad/sdk';
 * import { Cabinet } from '../features/lib/cabinet.js';
 *
 * export const cabinet = defineAssembly(Cabinet, { label: 'Cabinet', icon: '../features/icons/cabinet.png' });
 *
 * // an assembly
 * const unit = insert(cabinet, { width: 900, drawers: 3 }).grounded();
 * mate('fastened', plinth.connectors.top, unit.parts.carcass.connectors.base);
 * ```
 *
 * The rules:
 * - The class extends `Generator.with({ … })` (typed-in values only),
 *   declares a `static id`, and implements `layout(g)` and `static
 *   build(type, inputs, ctx)` (see {@link Generator}).
 * - `meta.label` names the assembly (and its toolbar entry) unless
 *   `meta.name` does; `icon`, `layout` and `aside` images are relative to
 *   this module and may climb into the package (`'../features/icons/x.png'`).
 *   Left out, the dialog's rows are derived from the values; `width:
 *   'wide'` and an `aside` (a size diagram beside the rows) dress the dialog
 *   as a feature's metadata does.
 * - A name the generator doesn't take, a value its declaration refuses, and
 *   a throw from its layout are a build error on the insert's row; a throw
 *   from its build is one on that part's row. The render goes on.
 * - Export it from an `*.assembly.js` module (a package's `assemblies/`).
 */
export function defineAssembly<C extends DefinableGeneratorClass>(
  generatorClass: C,
  meta: DefineAssemblyMeta<C['params']>,
): GeneratedAssemblyDefinition<LayoutResult<C>> {
  const definition = GeneratedAssemblyDefinition.define(generatorClass, meta, captureSourceLocation());
  // Tracked as assembly() is: an entry render left empty names it.
  const scene = getCurrentScene();
  if (scene instanceof AssemblyScene) {
    scene.trackDefinition(definition);
  }
  return definition as GeneratedAssemblyDefinition<LayoutResult<C>>;
}
