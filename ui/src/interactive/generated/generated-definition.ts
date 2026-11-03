import type {
  CatalogFileEntry, FeatureMetaSnapshot, FeatureScalarParam, GeneratedCatalogEntry, GeneratedSchema, InsertValue,
} from '../../api';
import type { InstanceParamValue } from '../../types';
import { DEFAULT_ICON_SRC } from '../../ui/object-icons';
import { FeatureSchema } from '../create-feature/schema/feature-schema';
import type { FieldValue } from '../create-feature/schema/schema-fields';

/** The value kinds a number row edits — whose row reads an expression as its text. */
const NUMBER_TYPES = new Set(['number', 'integer', 'length', 'angle']);

/**
 * One generated part or assembly (`definePart`, `defineAssembly`) the page
 * can insert, as the part catalog lists it: where it is defined, its schema
 * and its images — and how its schema becomes the custom-feature dialog
 * (values only: a generated definition takes no picks, has no operation and
 * draws no ghost; the preview is the real result, G4).
 *
 * Its images resolve against two modules (the catalog's `assetUrls`): its
 * icon and its own layout's pictures against the definition's, the values'
 * option pictures, the asides and a borrowed layout against the class's. A
 * path the dialog asks for is looked up under the class's module first, then
 * the definition's: one path string both modules declare (each for a file
 * of its own) reads as the class's.
 */
export class GeneratedDefinition {
  constructor(readonly entry: GeneratedCatalogEntry) {}

  /**
   * The definition behind a generated tile of the Insert dialog — its scan
   * entry and the file it came from; null for an entry that isn't one.
   */
  static fromScan(
    file: CatalogFileEntry,
    entry: { exportName: string; definitionKind?: 'generated'; schema?: GeneratedSchema; assetUrls?: GeneratedCatalogEntry['assetUrls'] },
    unit: GeneratedCatalogEntry['unit'],
  ): GeneratedDefinition | null {
    if (entry.definitionKind !== 'generated' || !entry.schema || !entry.assetUrls) {
      return null;
    }
    return new GeneratedDefinition({
      file: file.absPath,
      path: file.path,
      exportName: entry.exportName,
      kind: entry.schema.kind,
      schema: entry.schema,
      assetUrls: entry.assetUrls,
      unit,
      ...(file.package ? { package: file.package } : {}),
    });
  }

  /** The definition's id — what `generated.definition` names on what it made. */
  get id(): string {
    return this.entry.schema.id;
  }

  get kind(): 'part' | 'assembly' {
    return this.entry.schema.kind;
  }

  get label(): string {
    return this.entry.schema.label;
  }

  /** Its `file#export`: unique among the catalog's entries. */
  get key(): string {
    return `${this.entry.file}#${this.entry.exportName}`;
  }

  /** What changes here rebuilds its menu cell. */
  get signature(): string {
    return JSON.stringify(this.entry);
  }

  /** Its icon as served, or the generic one. */
  get iconSrc(): string {
    const icon = this.entry.schema.icon;
    return (icon !== undefined ? this.entry.assetUrls.definition[icon] : undefined) ?? DEFAULT_ICON_SRC;
  }

  /** What its cell's tooltip and aria label say: the label, and the description when it has one. */
  get tip(): string {
    const description = this.entry.schema.description;
    return description ? `${this.label} — ${description}` : this.label;
  }

  /** Where a path the schema declares is served (see the class comment); the path as given when it declares none such. */
  assetUrl(path: string): string {
    const urls = this.entry.assetUrls;
    return urls.class[path] ?? urls.definition[path] ?? path;
  }

  /** The dialog's schema: the custom-feature dialog's, over the definition's values. */
  featureSchema(): FeatureSchema {
    return new FeatureSchema(GeneratedDefinition.metaOf(this.entry.schema), { assetUrl: path => this.assetUrl(path) });
  }

  /** A generated schema as a custom feature's metadata: its values and dialog, no operations, no ghost, no picks. */
  static metaOf(schema: GeneratedSchema): FeatureMetaSnapshot {
    return {
      id: schema.id,
      label: schema.label,
      ...(schema.description !== undefined ? { description: schema.description } : {}),
      ...(schema.icon !== undefined ? { icon: schema.icon } : {}),
      group: 'create',
      kind: 'tool',
      operations: [],
      defaultOperation: null,
      params: schema.params,
      call: null,
      ghost: false,
      contexts: ['assembly'],
      layout: schema.layout,
      ...(schema.width !== undefined ? { width: schema.width } : {}),
      ...(schema.aside !== undefined ? { aside: schema.aside } : {}),
    };
  }

  /** The declaration of the value `id`, or null for one the definition doesn't take. */
  spec(id: string): FeatureScalarParam | null {
    return this.entry.schema.params[id] ?? null;
  }

  /**
   * A row's value as an insert writes it by id: a literal stays one; a
   * number row's expression or variable (its text) and a choice naming a
   * variable (`{ ref }`) become source text (`{ expr }`), written as they are.
   */
  insertValue(id: string, value: FieldValue): InsertValue {
    if (typeof value === 'string' && this.isNumber(id)) {
      return { expr: value };
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return { expr: 'ref' in value ? value.ref : value.expr };
    }
    return value;
  }

  /**
   * What a row opens on for an existing insert: the source text of the
   * value when the statement writes an expression (`expressions`, by id) —
   * a number row shows it as its text — else the value the engine built
   * with.
   */
  seedValue(id: string, value: InstanceParamValue | undefined, expression: string | undefined): FieldValue | undefined {
    if (expression !== undefined) {
      return this.isNumber(id) ? expression : { expr: expression };
    }
    return value;
  }

  private isNumber(id: string): boolean {
    const spec = this.spec(id);
    return spec !== null && NUMBER_TYPES.has(spec.type);
  }
}
