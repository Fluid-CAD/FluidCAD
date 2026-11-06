import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { PartDefinition } from "../features/part-definition.js";
import { Connector } from "../features/connector.js";
import type { Part } from "../features/part.js";
import type { Scene } from "../rendering/scene.js";
import type { SceneObject, SourceLocation } from "../common/scene-object.js";
import type { ParamOverrides, ParamVal } from "../param-registry.js";
import { getActiveUnit } from "../units/registry.js";
import { Feature } from "./feature.js";
import { FeatureBucketSet } from "./feature-buckets.js";
import { FeatureFrame, FeatureFrameSet } from "./feature-frames.js";
import { FeatureNamespaces } from "./feature-namespaces.js";
import type { FeatureParams } from "./feature-params.js";
import type { FeatureValues } from "./feature-inputs.js";
import type { FeatureOperation } from "./call-shape.js";
import type { ParamSpec } from "./meta.js";
import { FeatureLayouts, type FeatureLayout } from "./layout.js";
import { SchemaValidator, ValueSchema } from "./value-schema.js";
import {
  GeneratedMetaValidator, type GeneratedAssetBase, type GeneratedAssetModules, type GeneratedMarker, type GeneratedMeta,
  type GeneratedSchema, type ResolvedGeneratedMeta,
} from "./generated-schema.js";
import { ClassModules } from "./class-modules.js";
import { GeneratedCode } from "./generated-code.js";
import { canonicalVariantKey } from "../features/param-overrides.js";

/** A feature class `definePart()` takes: a tool that declares its values through `Feature.with()`. */
export type DefinablePartClass = (abstract new (values: any) => Feature<any, any, any>) & { readonly id: string; readonly params: FeatureParams };

/** The typed-in values a feature's specs `P` declare, by id: a generated part's interface. */
export type TypedInParams<P> = { [K in keyof P as P[K] extends { type: unknown } ? K : never]: P[K] };

/**
 * What `definePart()` is told about a generated part beside its feature
 * class: its label, description and icon, its dialog's `width` and `aside`
 * when they differ from the feature dialog's, and a layout over the part's
 * values — the feature's typed-in ones — so a misspelled or picked value is
 * an error in the editor.
 */
export type DefinePartMeta<P extends FeatureParams = FeatureParams> = Omit<GeneratedMeta, 'layout'> & {
  /**
   * The dialog's rows over the part's values (see `FeatureLayout`), images
   * relative to this module. Left out, the part borrows its feature
   * dialog's rows, less the picked values; else they are derived from the
   * values' `group` and `tab`.
   */
  layout?: FeatureLayout<TypedInParams<P>>;
};

/** A feature class's constructor, as the body of a generated part calls it. */
type FeatureConstructor = (new (values: FeatureValues) => Feature<any, any, any>) & { readonly id: string; readonly params: FeatureParams };

/**
 * An insertable part made by running a custom feature: what `definePart()`
 * returns. It is a part definition like one `part()` makes — `insert()`
 * takes it, the part catalog lists it, the assembly cache pairs its
 * parts by name and values — whose body is the feature, built as a new
 * solid with the insert's values, at the part's own origin, and whose
 * connectors are the feature's frames.
 *
 * The rules:
 * - **Values by id.** Its interface is the feature's typed-in values:
 *   `insert(gearPart, { teeth: 18 })` names them by id, not by label. Each
 *   is checked and defaulted as the feature's call checks it
 *   ({@link ValueSchema}); a picked value of the feature is left out, which
 *   is why each must be optional.
 * - **One template per values.** Inserts whose values, defaults filled, are
 *   equal share one part template per scene (`{}` and `{ teeth: 24 }` when
 *   24 is the default share one).
 * - **Bad values are the insert's build error.** A name the part doesn't
 *   take, a value its declaration refuses, or a configuration name (a
 *   generated part has none) makes the insert an empty part whose row says
 *   why, at the insert — the render goes on.
 * - **Connectors from frames.** Every frame the feature declares
 *   (`Feature.with(params, { frames })`) becomes a connector of its name,
 *   so `insert(gearPart).connectors.axis` exists without a part body.
 * - Lengths are in the defining module's unit, as a `part()` body's are.
 * - **Built once across renders too.** A variant a render's compare leaves
 *   unpaired goes to the template cache, keyed by its definition, values,
 *   units and code version (`Part.cacheKey`); a later render declaring it
 *   again takes it built. A save of this module, of the feature's, or of a
 *   module either imports, and any edit of the feature class's text, is new
 *   code: nothing the old code built is served again.
 */
export class GeneratedPartDefinition extends PartDefinition<void> {

  /** What marks the definition as generated, read by duck typing: a part, keyed by its feature's id. */
  readonly generated: GeneratedMarker;

  /** The schema, made on first ask: the feature's dialog may register after the definition. */
  private schemaSnapshot: GeneratedSchema | null = null;

  /** The fixed part of its variants' code version: the feature class's origin and text digest (`GeneratedCode.baseOf`). */
  private readonly codeBase: string;

  private constructor(
    private readonly featureClass: FeatureConstructor,
    /** Every value the feature declares: what its constructor is handed, picked values left out. */
    private readonly featureSchema: ValueSchema,
    /** The part's interface: the feature's typed-in values. */
    private readonly values: ValueSchema,
    /** The feature's frames, each a connector of its name. */
    private readonly frames: readonly string[],
    private readonly meta: ResolvedGeneratedMeta,
    location: SourceLocation | null,
  ) {
    super(meta.name, () => undefined, location);
    this.generated = Object.freeze({ kind: 'part', id: Feature.idOf(featureClass) });
    // The stamp where the definition is made stands in for a class whose
    // origin `Feature.with()` did not record (a plain subclass).
    this.codeBase = GeneratedCode.baseOf(featureClass, FeatureNamespaces.currentStamp());
    // Which modules hold its code: a change to this module, to its feature
    // class's, or to one either imports gives its variants a new code
    // version (GeneratedCode), so the template cache never serves them.
    GeneratedCode.noteDefinition(this.generated.id, location?.filePath);
    GeneratedCode.noteDefinition(this.generated.id, ClassModules.of(featureClass));
  }

  /**
   * Check `featureClass` and `meta` and make the definition, refusing — with
   * a message that names `definePart(<class>)` and the field — anything a
   * generated part can't be built from: a class that is not a `Feature`
   * tool declaring its values, a picked value the feature requires, a
   * feature that only removes material, and bad metadata.
   */
  static define(featureClass: unknown, meta: unknown, location: SourceLocation | null): GeneratedPartDefinition {
    if (typeof featureClass !== 'function' || featureClass === Feature || !(featureClass.prototype instanceof Feature)) {
      throw new Error(`definePart(): the first argument is the feature's class, one that extends Feature.with({ … }), got ${SchemaValidator.describe(featureClass)}`);
    }
    const name = featureClass.name || 'the class';
    const where = featureClass.name ? `definePart(${featureClass.name})` : 'definePart()';
    const params = (featureClass as { params?: unknown }).params;
    if (params === undefined) {
      throw new Error(`${where}: ${name} declares no values — declare them with Feature.with({ … }): class ${name} extends Feature.with({ teeth: { type: 'integer', default: 24 } })`);
    }
    const prototype = featureClass.prototype as Feature;
    if (prototype.build !== Feature.prototype.build) {
      throw new Error(`${where}: ${name} overrides build() — it changes solids it is handed, so it makes no part on its own; a generated part runs a tool, one that implements buildTool()`);
    }
    if (prototype.buildTool === Feature.prototype.buildTool) {
      throw new Error(`${where}: ${name} implements no buildTool() — a generated part runs a tool, one that returns its solids from buildTool(ctx)`);
    }
    let plainId: string;
    try {
      plainId = Feature.plainIdOf(featureClass);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
    // Claimed while its module evaluates, as defineFeature claims it: a
    // class an installed package defines is keyed by the package.
    FeatureNamespaces.claim(featureClass);
    const featureSchema = ValueSchema.declare(params, `feature '${plainId}'`);
    FeatureBucketSet.of(featureClass);
    const frames = FeatureFrameSet.of(featureClass).names();
    for (const picked of featureSchema.pickerNames()) {
      if ((featureSchema.spec(picked) as { optional?: boolean }).optional !== true) {
        throw new Error(`${where}: '${picked}' is a picked value the feature requires — a generated part takes typed-in values only, `
          + `so each picked value must be optional (optional: true); the part leaves it out`);
      }
    }
    if (GeneratedPartDefinition.operationOf(featureClass) === null) {
      throw new Error(`${where}: ${GeneratedPartDefinition.operationRefusal(featureClass)}`);
    }
    const values = featureSchema.typedIn();
    const resolved = new GeneratedMetaValidator(where, meta).resolve(values.params as Record<string, ParamSpec>);
    return new GeneratedPartDefinition(featureClass as unknown as FeatureConstructor, featureSchema, values, frames, resolved, location);
  }

  /**
   * The definition's schema as plain JSON (see {@link GeneratedSchema}): the
   * values an insert takes, by id; the dialog's rows — the author's
   * `layout`, else the feature dialog's less its picked values, else
   * derived from the values' `group` and `tab`; the dialog's width and
   * aside — the author's, else the feature dialog's; the label, description
   * and icon; the connectors. A fresh copy on each call.
   */
  getSchema(): GeneratedSchema {
    if (this.schemaSnapshot === null) {
      this.schemaSnapshot = this.snapshot();
    }
    return JSON.parse(JSON.stringify(this.schemaSnapshot)) as GeneratedSchema;
  }

  /**
   * @internal Where the schema's images resolve (see `GeneratedAssetModules`):
   * this definition's module — where its `definePart()` call is — and
   * the module that declared its class's values. Read with
   * `GeneratedSchemas.modulesOf` by a host that serves or packs the images.
   */
  assetModules(): GeneratedAssetModules {
    const definition = this.getSourceLocation()?.filePath ?? null;
    return Object.freeze({ definition, class: ClassModules.of(this.featureClass) });
  }

  /**
   * The insert path: the values checked by id and completed, then the
   * variant of those values — built once per scene. A value the part
   * refuses, or a configuration name, gives an empty part instead, whose
   * build error is reported at the insert.
   */
  override materializeVariant(scene: Scene, extra?: ParamOverrides, configuration?: string): Part {
    let values: Map<string, ParamVal>;
    try {
      if (configuration !== undefined) {
        throw new Error(`${this.subject()}: '${configuration}' names a configuration, and a generated part has none — insert it with its values, such as insert(def, { … })`);
      }
      values = this.variantValues(extra ?? {});
    } catch (error) {
      return this.refusedVariant(scene, (error as Error).message, captureSourceLocation());
    }
    return this.buildVariant(scene, values, false);
  }

  /**
   * The entry-file path (the defining file rendered on its own): the
   * variant of `values` — what a host set for the export, by id
   * (`BrowserEngineHost.setGeneratedValues`) — else the default variant,
   * every value at its default. A value the part refuses, or one with no
   * default, gives one empty part saying so, at `definePart()`, registered
   * as the definition's variant in `scene` so the leftover pass
   * (`Scene.materializeLeftoverDefinitions`) builds no defaults beside it —
   * unlike {@link materializeVariant}'s refusal, which is the insert's row.
   */
  override materializeInto(scene: Scene, values: Readonly<Record<string, unknown>> = {}): Part {
    let completed: Map<string, ParamVal>;
    try {
      completed = this.variantValues(values);
    } catch (error) {
      return this.refusedVariant(scene, (error as Error).message, this.getSourceLocation(), GeneratedPartDefinition.ENTRY_REFUSED);
    }
    return this.buildVariant(scene, completed, false);
  }

  /** The cache key of the entry path's refused variant (a value with no default, a host's value refused): one per scene, however often it is asked for. */
  private static readonly ENTRY_REFUSED = '\u0000generated:entry-refused';

  /**
   * The body: the feature, constructed from the variant's values and built
   * as a new solid, then one connector per frame, on the frame. Every
   * statement is located at `definePart()`, in the definition's unit.
   *
   * The variant is marked for the template cache (`Part.generatedVariant`):
   * its values, how the feature is built, and the definition's code version
   * read now. A later render that declares the same variant again — a value
   * dragged back, an undo, a preview cancelled — takes its build from the
   * cache instead of building the feature (`GeneratedTemplateCache`).
   */
  protected override runBody(scene: Scene, part: Part, overrides: ReadonlyMap<string, ParamVal>): void {
    const values = Object.fromEntries(overrides) as Record<string, ParamVal>;
    // The variant's values by id: the assembly cache pairs parts by them,
    // and the wire carries them.
    part.paramValues = { ...values };
    part.generated = { definition: this.generated.id, values: { ...values } };
    let feature: Feature<any, any, any>;
    try {
      feature = new this.featureClass(this.featureSchema.complete(this.subject(), values));
    } catch (error) {
      part.refuse(`${this.subject()}: ${(error as Error).message}`);
      return;
    }
    const operation = GeneratedPartDefinition.operationOf(this.featureClass);
    if (operation === 'add') {
      feature.add();
    } else {
      feature.new();
    }
    if (operation === null) {
      feature.refuse(`${this.subject()}: ${GeneratedPartDefinition.operationRefusal(this.featureClass)}`);
    } else {
      part.generatedVariant = Object.freeze({
        definition: this.generated.id,
        values: canonicalVariantKey(overrides),
        operation,
        code: GeneratedCode.versionOf(this.generated.id, this.codeBase),
      });
    }
    this.place(scene, feature);
    for (const name of this.frames) {
      const frame = feature.frame(name as never) as unknown as FeatureFrame;
      this.place(scene, frame);
      this.place(scene, new Connector(name, frame));
    }
  }

  /**
   * The values an insert passes, by id, checked and completed — every
   * typed-in value present, defaults filled — in declaration order: the
   * variant's identity, what `part.paramValues` carries and what a host
   * reports it rendered. Throws the insert path's refusal for a name the
   * part doesn't take (a picked value of the feature named as such) and a
   * value its declaration refuses; a value with no default is left out.
   */
  completedValues(read: Readonly<Record<string, unknown>>): Record<string, ParamVal> {
    const subject = this.subject();
    this.values.refuseUnknown(subject, read, name => (this.featureSchema.has(name)
      ? 'is a picked value of the feature — a generated part takes its typed-in values only, and leaves the picked ones out'
      : null));
    const completed = this.values.complete(subject, read);
    const values: Record<string, ParamVal> = {};
    for (const name of this.values.names()) {
      const value = completed[name];
      if (value !== undefined && value !== null) {
        values[name] = value as ParamVal;
      }
    }
    return values;
  }

  /** {@link completedValues} as the variant's key: a map in declaration order. */
  private variantValues(read: Readonly<Record<string, unknown>>): Map<string, ParamVal> {
    return new Map(Object.entries(this.completedValues(read)));
  }

  /** Add one statement of the body to the scene, located at `definePart()` and in the active unit (the definition's). */
  private place(scene: Scene, obj: SceneObject): void {
    const location = this.getSourceLocation();
    if (location && !obj.getSourceLocation()) {
      obj.setSourceLocation(location);
    }
    if (!obj.hasUnit()) {
      obj.setUnit(getActiveUnit());
    }
    scene.addSceneObject(obj);
  }

  /** Who the insert's refusals name: the part, as `part()` refusals do. */
  private subject(): string {
    return `part '${this.partName}'`;
  }

  private snapshot(): GeneratedSchema {
    const dialog = Feature.registrationOf(this.featureClass)?.dialog;
    let layout: FeatureLayout;
    let base: GeneratedAssetBase;
    if (this.meta.layout !== undefined) {
      layout = this.meta.layout;
      base = 'definition';
    } else if (dialog) {
      layout = GeneratedPartDefinition.withoutPicked(dialog.layout, new Set(this.featureSchema.pickerNames()));
      base = 'class';
    } else {
      layout = FeatureLayouts.derive(this.values.params);
      base = 'definition';
    }
    // The author's aside, else the feature dialog's — each read against the
    // module that wrote it.
    const aside = this.meta.aside ?? dialog?.aside;
    const asideBase: GeneratedAssetBase = this.meta.aside !== undefined ? 'definition' : 'class';
    const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    return SchemaValidator.defined({
      kind: 'part',
      definitionKind: 'generated',
      id: this.generated.id,
      label: this.meta.label,
      description: this.meta.description,
      icon: this.meta.icon,
      params: this.values.snapshot(),
      layout: json(layout),
      width: this.meta.width ?? dialog?.width,
      aside: aside === undefined ? undefined : json(aside),
      connectors: [...this.frames],
      assetBase: aside === undefined ? { layout: base } : { layout: base, aside: asideBase },
    }) as GeneratedSchema;
  }

  /**
   * How the body builds the feature: as a new solid — `.new()` when its
   * metadata offers it or lists no operations (or no builder registered
   * it), else `.add()`, the same solid in a part that holds nothing else.
   * Null for a feature that offers neither: it only removes material.
   */
  private static operationOf(featureClass: Function): FeatureOperation | null {
    const operations = Feature.registrationOf(featureClass)?.operations ?? [];
    if (operations.length === 0 || operations.includes('new')) {
      return 'new';
    }
    return operations.includes('add') ? 'add' : null;
  }

  private static operationRefusal(featureClass: Function): string {
    const operations = Feature.registrationOf(featureClass)?.operations ?? [];
    return `the feature only offers ${operations.map(operation => `'${operation}'`).join(' and ')} — a generated part builds it as a solid of its own, so it must offer 'new' or 'add'`;
  }

  /**
   * A feature dialog's rows, less its picked values: a picked value's row
   * goes, and so does a section or a tab that held one and holds no value
   * now — what it held was about the pick. Notes, images and dividers stay
   * where they stand. A `visibleWhen` naming a picked value is kept: the
   * dialog reads a value it doesn't have as nothing picked, as the feature's
   * dialog does before a pick.
   */
  private static withoutPicked(layout: FeatureLayout, picked: ReadonlySet<string>): FeatureLayout {
    return GeneratedPartDefinition.prune(layout, picked).items as FeatureLayout;
  }

  /** `items` without the picked values' rows; `dropped` says whether any went. */
  private static prune(items: readonly unknown[], picked: ReadonlySet<string>): { items: unknown[]; dropped: boolean } {
    const out: unknown[] = [];
    let dropped = false;
    const keeps = (inner: { items: unknown[]; dropped: boolean }) => inner.items.length > 0
      && (!inner.dropped || GeneratedPartDefinition.holdsValue(inner.items));
    for (const item of items) {
      if (typeof item === 'string') {
        if (picked.has(item)) {
          dropped = true;
        } else {
          out.push(item);
        }
        continue;
      }
      const entry = item as Record<string, unknown>;
      if (Array.isArray(entry.items) && 'section' in entry) {
        const inner = GeneratedPartDefinition.prune(entry.items, picked);
        dropped = dropped || inner.dropped;
        if (keeps(inner)) {
          out.push({ ...entry, items: inner.items });
        }
        continue;
      }
      if (Array.isArray(entry.tabs)) {
        const tabs: unknown[] = [];
        for (const tab of entry.tabs as Record<string, unknown>[]) {
          const inner = GeneratedPartDefinition.prune(tab.items as unknown[], picked);
          dropped = dropped || inner.dropped;
          if (keeps(inner)) {
            tabs.push({ ...tab, items: inner.items });
          }
        }
        if (tabs.length > 0) {
          out.push({ ...entry, tabs });
        }
        continue;
      }
      // A row (a picked value never sits in one), a note, an image, a divider.
      out.push(item);
    }
    return { items: out, dropped };
  }

  /** Whether `items` place any value: a value's row, or a row or a section that holds one. */
  private static holdsValue(items: readonly unknown[]): boolean {
    return items.some(item => {
      if (typeof item === 'string') {
        return true;
      }
      const entry = item as Record<string, unknown>;
      if (Array.isArray(entry.row)) {
        return entry.row.some(cell => typeof cell === 'string');
      }
      return Array.isArray(entry.items) && GeneratedPartDefinition.holdsValue(entry.items);
    });
  }
}

/**
 * Make an insertable part from a custom feature: a part definition whose
 * body runs the feature — built as a new solid, at the part's own origin —
 * with the values an `insert()` passes, and whose connectors are the
 * feature's frames. The feature's schema is the part's interface: the same
 * values, defaults, ranges, options and pictures, checked the same way.
 *
 * ```js
 * // parts/gear.part.js
 * import { definePart } from 'fluidcad/sdk';
 * import { Gear } from '../features/gear.feature.js';
 *
 * export const gearPart = definePart(Gear, { label: 'Gear', icon: '../features/icons/gear.png' });
 *
 * // an assembly
 * const pinion = insert(gearPart, { teeth: 18, width: 12 });
 * mate('revolute', shaft.connectors.end, pinion.connectors.axis);
 * ```
 *
 * The rules:
 * - The class is a tool that declares its values with `Feature.with()`.
 *   Its typed-in values are the part's, passed by id; every picked value
 *   must be optional (`optional: true`) and is left out. A feature that
 *   only removes material makes no part.
 * - Each frame the class declares (`Feature.with(params, { frames: { axis:
 *   {} } })`) and its build sets (`this.setFrames({ axis: plane })`) is a
 *   connector of the part, of the frame's name.
 * - `meta.label` names the part (and its toolbar entry) unless `meta.name`
 *   does; `icon`, `layout` and `aside` images are relative to this module
 *   and may climb into the package (`'../features/icons/gear.png'`). Left
 *   out, the dialog borrows the feature's rows, less its picked values, and
 *   the feature dialog's `width` and `aside`.
 * - Equal values, defaults filled, share one template per scene. A name
 *   the part doesn't take or a value its declaration refuses is a build
 *   error on the insert's row; the render goes on.
 * - It is a part: export it from the top level of a `*.part.js` module (a
 *   package's `parts/`), one name per file, as `part()` requires.
 */
export function definePart<C extends DefinablePartClass>(featureClass: C, meta: DefinePartMeta<C['params']>): GeneratedPartDefinition {
  const definition = GeneratedPartDefinition.define(featureClass, meta, captureSourceLocation());
  const scene = getCurrentScene();
  // Tracked and checked as part() is: the open file renders it, and it
  // follows the part rules (exported, one name per file).
  scene?.trackPartDefinition(definition);
  definition.checkDeclaration(scene);
  return definition;
}
