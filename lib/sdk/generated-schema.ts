import { FeatureCall } from "./call-shape.js";
import { FeatureLayouts, type FeatureDialogWidth, type FeatureLayout, type FeatureStaticItem } from "./layout.js";
import type { ChoiceOption, ParamSpec, ParamSpecSnapshot } from "./meta.js";
import { SchemaValidator } from "./value-schema.js";

/** What a generated definition inserts: one part (`definePart`) or a sub-assembly (`defineAssembly`). */
export type GeneratedKind = 'part' | 'assembly';

/**
 * Which module an image path of a generated definition's schema resolves
 * against: `definition`, the module that defines it (the one calling
 * `definePart`, a package's `parts/` file), or `class`, the module that
 * declares the class whose values are its interface (a feature module).
 */
export type GeneratedAssetBase = 'definition' | 'class';

/**
 * What marks a generated definition, read by duck typing across engine
 * copies (the server's catalog scan): its kind and its id — for a
 * generated part, the feature's catalog key.
 */
export type GeneratedMarker = Readonly<{ kind: GeneratedKind; id: string }>;

/**
 * A generated definition's schema as plain JSON — what the editor's catalog
 * sends the UI, which never runs its code, and what a package's manifest
 * carries: the interface (`params`, by id), its dialog (`layout`, `width`,
 * `aside`), its toolbar entry (`label`, `icon`, `description`) and the
 * connectors every insert gets.
 *
 * Image paths resolve against two modules (see {@link GeneratedAssetBase}):
 * `icon` against the definition's, the values' own pictures (options and
 * asides) and the dialog's `aside` against the class's, and `layout`
 * against the one `assetBase.layout` names — the definition's when its
 * author wrote the layout, the class's when it is the feature dialog's,
 * borrowed. {@link GeneratedSchemas.assetsOf} lists both.
 */
export type GeneratedSchema = {
  kind: GeneratedKind;
  definitionKind: 'generated';
  /**
   * The definition's id: for a generated part, its feature's catalog key
   * (`gear`, `@acme/gears:gear`); for a generated assembly, its generator's
   * (`wardrobe-unit`, `@acme/cabinets:wardrobe-unit`).
   */
  id: string;
  label: string;
  description?: string;
  icon?: string;
  /** The values an insert takes, by id, in declaration order: each declaration with its resolved default and its label. */
  params: Record<string, ParamSpecSnapshot>;
  /** The dialog's rows over `params`, always there. */
  layout: FeatureLayout;
  width?: FeatureDialogWidth;
  aside?: readonly FeatureStaticItem[];
  /**
   * The connectors every insert carries, by name, in declaration order (a
   * feature's frames). Empty for a generated assembly: its connectors are
   * its parts', reached through `occurrence.parts`.
   */
  connectors: string[];
  /** The module `layout`'s images resolve against. */
  assetBase: { layout: GeneratedAssetBase };
};

/**
 * Where a generated definition's two image bases are (see
 * {@link GeneratedAssetBase}), as absolute paths a host names files by:
 * `definition`, the module that called `definePart()` / `defineAssembly()`;
 * `class`, the module that declared the class's values (`Feature.with()`,
 * `Generator.with()`). Either is null when the engine could not tell (no
 * stack to read). Never part of the schema: a host resolves and serves the
 * images with it, and confines each to the package or workspace that owns
 * the module.
 */
export type GeneratedAssetModules = Readonly<Record<GeneratedAssetBase, string | null>>;

/** What `definePart` (and `defineAssembly`) is told about a generated definition, beside its class. */
export type GeneratedMeta = {
  /** What the toolbar and the Insert dialog call it; also the part's name unless `name` is given. */
  label: string;
  /** A sentence under the label. */
  description?: string;
  /**
   * An image by a path relative to the defining module, which may climb out
   * of its directory within the package: `'./icons/gear.svg'`,
   * `'../features/icons/gear.png'`.
   */
  icon?: string;
  /**
   * The dialog's rows over the definition's values (see `FeatureLayout`),
   * images relative to the defining module. Left out, a generated part
   * borrows its feature dialog's rows, less the picked values; else they
   * are derived from the values' `group` and `tab`.
   */
  layout?: FeatureLayout;
  /** The name each inserted part (or sub-assembly) is built with; `label` when left out. */
  name?: string;
};

/** A generated definition's metadata, checked: every field but `layout` resolved. */
export type ResolvedGeneratedMeta = Readonly<{
  label: string;
  name: string;
  description?: string;
  icon?: string;
  /** The author's layout, checked; undefined when left out (the definition then borrows or derives one). */
  layout?: FeatureLayout;
}>;

/**
 * Checks what a generated definition is told beside its class (see
 * {@link GeneratedMeta}), refusing a bad field with a message that leads
 * with `where` (`definePart(Gear)`). The layout is checked over the
 * definition's own values — the typed-in ones a generated part takes — so
 * it can't place a value the definition leaves out.
 */
export class GeneratedMetaValidator extends SchemaValidator {

  private static readonly FIELDS = ['label', 'description', 'icon', 'layout', 'name'];

  /** Fields refused by name rather than as unknown, each with why it is left out, by the kind of definition. */
  private static readonly LEFT_OUT: Record<GeneratedKind, [string, string][]> = {
    part: [
      ['class', 'the class is the first argument'],
      ['params', "the values are the class's own — a generated part's are its feature's typed-in values"],
      ['call', 'a generated definition is inserted, not called: insert(def, { … }) takes its values by id'],
      ['operations', 'a generated part builds its feature as a new solid'],
      ['buckets', 'declare buckets on the class: Feature.with(params, { buckets })'],
      ['frames', 'declare frames on the class: Feature.with(params, { frames }) — each becomes a connector of its name'],
    ],
    assembly: [
      ['class', 'the class is the first argument'],
      ['params', "the values are the generator's own: declare them with Generator.with({ … })"],
      ['call', 'a generated definition is inserted, not called: insert(def, { … }) takes its values by id'],
      ['connectors', "a generated assembly's connectors are its parts': g.part(type, { connectors }) in layout(g)"],
    ],
  };

  constructor(where: string, private readonly meta: unknown, private readonly kind: GeneratedKind = 'part') {
    super(where);
  }

  /** The metadata, checked, with `params` the values its layout may place. */
  resolve(params: Record<string, ParamSpec>): ResolvedGeneratedMeta {
    if (!FeatureCall.isPlainObject(this.meta)) {
      this.fail(`the second argument describes it, such as { label: 'Gear', icon: './icons/gear.svg' } — got ${SchemaValidator.describe(this.meta)}`);
    }
    const meta = this.meta as Record<string, unknown>;
    this.leftOut(meta, GeneratedMetaValidator.LEFT_OUT[this.kind]);
    for (const field of Object.keys(meta)) {
      if (!GeneratedMetaValidator.FIELDS.includes(field)) {
        this.fail(`unknown field '${field}' — the fields are ${GeneratedMetaValidator.FIELDS.join(', ')}`);
      }
    }
    const label = this.text(meta.label, "'label'");
    const name = meta.name === undefined ? label : this.text(meta.name, "'name'");
    const description = meta.description === undefined ? undefined : this.text(meta.description, "'description'", true);
    const icon = meta.icon === undefined ? undefined : this.relativeImage(meta.icon, 'icon');
    const checks = this.layoutChecks(params, (value, where) => this.relativeImage(value, 'image', where));
    const layout = meta.layout === undefined ? undefined : FeatureLayouts.check(meta.layout, checks);
    return Object.freeze(SchemaValidator.defined({ label, name, description, icon, layout })) as ResolvedGeneratedMeta;
  }
}

/** Reading generated definitions and their schemas, from any engine copy. */
export class GeneratedSchemas {

  /**
   * Whether `value` is a generated definition: a part definition
   * (`getType() === 'part-definition'`) or an assembly definition
   * (`'assembly'`) that carries a {@link GeneratedMarker} as `generated`
   * and a `getSchema()`. Duck-typed, so a definition another copy of the
   * engine made is recognised too.
   */
  static isGenerated(value: unknown): value is { generated: GeneratedMarker; getSchema(): GeneratedSchema } {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as { getType?: unknown; generated?: unknown; getSchema?: unknown };
    try {
      const type = typeof candidate.getType === 'function' ? (candidate.getType as () => unknown)() : null;
      const marker = candidate.generated as Partial<GeneratedMarker> | undefined;
      return (type === 'part-definition' || type === 'assembly')
        && !!marker && typeof marker === 'object'
        && (marker.kind === 'part' || marker.kind === 'assembly') && typeof marker.id === 'string'
        && typeof candidate.getSchema === 'function';
    } catch {
      return false;
    }
  }

  /**
   * The modules a generated definition's images resolve against (see
   * {@link GeneratedAssetModules}), read by duck typing; null for a value
   * that is no generated definition, or one whose engine predates them.
   */
  static modulesOf(value: unknown): GeneratedAssetModules | null {
    if (!GeneratedSchemas.isGenerated(value)) {
      return null;
    }
    const reader = (value as { assetModules?: unknown }).assetModules;
    if (typeof reader !== 'function') {
      return null;
    }
    try {
      const modules = (reader as () => Partial<GeneratedAssetModules> | null).call(value);
      const path = (file: unknown) => (typeof file === 'string' && file !== '' ? file : null);
      return modules ? Object.freeze({ definition: path(modules.definition), class: path(modules.class) }) : null;
    } catch {
      return null;
    }
  }

  /**
   * Every image a schema declares, each once, by the module it resolves
   * against (see {@link GeneratedSchema}): the definition's — its icon, and
   * its layout's images when its author wrote the layout — and the class's
   * — the values' option pictures and asides, the dialog's aside, and the
   * layout's images when it is borrowed. It is the whole list of what may be
   * served for the definition.
   */
  static assetsOf(schema: GeneratedSchema): Record<GeneratedAssetBase, string[]> {
    const definition: unknown[] = [schema.icon];
    const owned: unknown[] = [];
    for (const spec of Object.values(schema.params)) {
      const options = 'options' in spec && Array.isArray(spec.options) ? spec.options as readonly ChoiceOption[] : [];
      owned.push(...options.map(option => option.image));
    }
    (schema.assetBase.layout === 'definition' ? definition : owned).push(...FeatureLayouts.images(schema.layout));
    owned.push(...FeatureLayouts.images(schema.aside));
    for (const spec of Object.values(schema.params)) {
      owned.push(...FeatureLayouts.images(spec.aside));
    }
    const distinct = (paths: unknown[]) => [...new Set(paths.filter((path): path is string => typeof path === 'string'))];
    return { definition: distinct(definition), class: distinct(owned) };
  }
}
