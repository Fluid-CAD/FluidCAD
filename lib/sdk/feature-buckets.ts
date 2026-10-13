import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { BucketDefs, type BucketDef, type SubShapeKind } from "../common/bucket-defs.js";
import type { FaceFilterBuilder } from "../filters/face/face-filter.js";
import type { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import type { ISelection } from "../core/interfaces.js";
import { FeatureCall } from "./call-shape.js";

type FaceArgs = (number | FaceFilterBuilder)[];
type EdgeArgs = (number | EdgeFilterBuilder)[];

/** The standard face buckets, by accessor name. */
export type FaceBucketName = 'startFaces' | 'endFaces' | 'sideFaces' | 'internalFaces' | 'capFaces';

/** The standard edge buckets, by accessor name. */
export type EdgeBucketName = 'startEdges' | 'endEdges' | 'sideEdges' | 'internalEdges' | 'capEdges';

/**
 * One bucket a feature class declares (`Feature.with(params, { buckets })`).
 * Its name is its accessor and says what it holds: `tipFaces` holds faces,
 * `tipEdges` edges.
 */
export type FeatureBucketSpec = {
  /** What the editor's menus call it; left out, the name made readable (`tipEdges` → "Tip Edges"). */
  label?: string;
};

/** A feature class's bucket declarations, by name. */
export type FeatureBucketSpecs = Record<string, FeatureBucketSpec>;

/**
 * The accessor methods a declaration adds, one per custom bucket:
 * `tipFaces(...indicesOrFilters)` and `tipEdges(...)`, read like `endFaces()`.
 * Standard names declared to relabel them add nothing — they are methods
 * already.
 */
export type BucketAccessors<B> = {
  [K in keyof B & string as K extends FaceBucketName | EdgeBucketName ? never
    : K extends `${string}Faces` | `${string}Edges` ? K : never]:
    K extends `${string}Faces` ? (...args: FaceArgs) => ISelection : (...args: EdgeArgs) => ISelection;
};

/** The buckets a feature names in `setBuckets()` beyond the standard ones: faces in a `…Faces` bucket, edges in an `…Edges` one. */
export type NamedBuckets<N extends string> = {
  [K in N]?: K extends `${string}Faces` ? Face[] : Edge[];
};

declare const BUCKET_SPECS: unique symbol;

/**
 * Type only, never set: the bucket declarations a `Feature.with()` class
 * carries on its instances, so a type that holds a feature (a repeat of it)
 * can name its accessors.
 */
export type FeatureBucketBrand<B> = { readonly [BUCKET_SPECS]?: B };

/** The bucket declarations a feature type carries (see {@link FeatureBucketBrand}); `{}` for one that declares none. */
export type BucketSpecsOf<T> = T extends { readonly [BUCKET_SPECS]?: infer B } ? (B extends FeatureBucketSpecs ? B : {}) : {};

/** One declared bucket, checked. */
type DeclaredBucket = {
  name: string;
  kind: SubShapeKind;
  /** Where the feature's state keeps it: a standard bucket's kebab key, `bucket:<name>` for a custom one. */
  key: string;
  label: string;
  /** One of the standard buckets (`endFaces`), declared to relabel it: it makes no accessor of its own. */
  standard: boolean;
};

/** What an installed accessor calls: the base's own selection paths (`Feature`'s private `faceSelection` / `edgeSelection`). */
type BucketReader = {
  faceSelection(key: string, args: FaceArgs): ISelection;
  edgeSelection(key: string, args: EdgeArgs): ISelection;
};

/**
 * A feature class's declared buckets: the one place a declaration is checked
 * and turned into accessors, and what the feature and the editor's index
 * ask about them.
 *
 * A class declares its buckets with `Feature.with(params, { buckets })` — or,
 * the plain-subclass way, `static buckets = { … }`. A name ends in `Faces`
 * or `Edges`, which gives the bucket's kind; each custom name gets one
 * accessor method on the declaring class's prototype, read through the
 * base's own selection paths, so indices, filters, a repeat's transform and
 * the cache's unique name behave exactly as `endFaces()` does. Custom
 * buckets live in the state at `bucket:<name>`, where no internal key can
 * clash with them. A standard name may be declared too, to relabel it.
 *
 * A declaration holds no description: what a bucket holds is documented in
 * the package's `docs/` pages.
 */
export class FeatureBucketSet {

  /** A bucket's name: a lowercase letter, letters and digits, then `Faces` or `Edges`. */
  static readonly PATTERN = /^[a-z][A-Za-z0-9]*(Faces|Edges)$/;

  /** The longest bucket name, in characters. */
  static readonly MAX_NAME_LENGTH = 48;

  /** The most buckets one class declares. */
  static readonly MAX_BUCKETS = 32;

  /** The standard face buckets: each accessor and its state key, in the order the edge buckets derive from them. */
  static readonly STANDARD_FACES: readonly (readonly [FaceBucketName, string])[] = [
    ['startFaces', 'start-faces'], ['endFaces', 'end-faces'], ['sideFaces', 'side-faces'],
    ['internalFaces', 'internal-faces'], ['capFaces', 'cap-faces'],
  ];

  /** The standard edge buckets: each accessor and its state key. */
  static readonly STANDARD_EDGES: readonly (readonly [EdgeBucketName, string])[] = [
    ['startEdges', 'start-edges'], ['endEdges', 'end-edges'], ['sideEdges', 'side-edges'],
    ['internalEdges', 'internal-edges'], ['capEdges', 'cap-edges'],
  ];

  /** A set with no declarations: a class that declares no buckets. */
  static readonly EMPTY = new FeatureBucketSet([]);

  private static readonly FIELDS = ['label'];

  private static readonly STANDARD_KEYS = new Map<string, string>([
    ...FeatureBucketSet.STANDARD_FACES, ...FeatureBucketSet.STANDARD_EDGES,
  ]);

  /**
   * Marks an accessor a set installed. A registry symbol, so a second kernel
   * reading the same class (a server snapshotting a workspace feature)
   * recognises it rather than taking it for a hand-written method.
   */
  private static readonly INSTALLED: symbol = Symbol.for('fluidcad.bucket-accessor');

  /** Each class's checked set, by the class asked about — a subclass and the class declaring its buckets alike. */
  private static readonly sets = new WeakMap<Function, FeatureBucketSet>();

  private constructor(private readonly buckets: readonly DeclaredBucket[]) {}

  /**
   * The checked set of a feature class: the buckets declared by the nearest
   * class in its chain that declares any, their accessors installed on that
   * class's prototype the first time it is asked — so a bad declaration
   * fails where the module loads (`Feature.with()`, `registerBuilder`).
   * `where` names the declaring class in refusals; by default its id or name.
   */
  static of(featureClass: Function, where?: string): FeatureBucketSet {
    const known = FeatureBucketSet.sets.get(featureClass);
    if (known) {
      return known;
    }
    const owner = FeatureBucketSet.ownerOf(featureClass);
    let set = FeatureBucketSet.EMPTY;
    if (owner === featureClass) {
      set = FeatureBucketSet.declare(owner, where ?? FeatureBucketSet.whereOf(owner));
    } else if (owner) {
      set = FeatureBucketSet.of(owner);
    }
    if (owner) {
      set.refuseHandWritten(featureClass, owner);
    }
    FeatureBucketSet.sets.set(featureClass, set);
    return set;
  }

  /** The state key a custom bucket lives at: `tipFaces` → `bucket:tipFaces`. */
  static keyOf(name: string): string {
    return `bucket:${name}`;
  }

  /** Whether `name` is one of the standard buckets' accessors (`endFaces`, `sideEdges`). */
  static isStandard(name: string): boolean {
    return FeatureBucketSet.STANDARD_KEYS.has(name);
  }

  /** Whether no bucket is declared. */
  isEmpty(): boolean {
    return this.buckets.length === 0;
  }

  /** The custom buckets' names, in declaration order: the ones with an accessor of their own. */
  customNames(): string[] {
    return this.custom().map(bucket => bucket.name);
  }

  /** Whether `name` is declared, standard or custom. */
  has(name: string): boolean {
    return this.buckets.some(bucket => bucket.name === name);
  }

  /** What `name` holds, read off its ending: faces for `…Faces`, edges for `…Edges`. */
  static kindOf(name: string): SubShapeKind {
    return name.endsWith('Faces') ? 'face' : 'edge';
  }

  /** What the editor's menus call a bucket: its declared label, else the name made readable (`tipEdges` → "Tip Edges"). */
  labelOf(name: string): string {
    return this.buckets.find(bucket => bucket.name === name)?.label ?? BucketDefs.labelOf(name);
  }

  /**
   * The custom buckets as the editor's index addresses them, in declaration
   * order — of one kind, or both. A custom edge bucket whose face sibling is
   * declared (`tipEdges` beside `tipFaces`) derives from it.
   */
  defs(kind?: SubShapeKind): BucketDef[] {
    return this.custom()
      .filter(bucket => kind === undefined || bucket.kind === kind)
      .map(bucket => ({
        key: bucket.key,
        accessor: bucket.name,
        kind: bucket.kind,
        label: bucket.label,
        deriveFromFaceKey: bucket.kind === 'edge' ? this.faceSiblingKeyOf(bucket.name) : null,
      }));
  }

  /**
   * Refuse what `setBuckets()` is handed that it would otherwise lose
   * silently: a name that is no bucket of the feature (the closest one
   * suggested), a value that is not a list, a member of the wrong kind — an
   * edge in a `…Faces` bucket — and a `startPlane` that is not a plane. A
   * value left `undefined` names nothing. `type` is the feature's type,
   * which every refusal leads with.
   */
  checkFilled(buckets: unknown, type: string, callee: string): void {
    const fail = (message: string): never => {
      throw new Error(`${type}: setBuckets() ${message}`);
    };
    if (!FeatureCall.isPlainObject(buckets)) {
      fail(`takes the buckets by name, such as { endFaces: [face] } — got ${FeatureBucketSet.describe(buckets)}`);
    }
    for (const [name, value] of Object.entries(buckets as Record<string, unknown>)) {
      if (value === undefined) {
        continue;
      }
      if (name === 'startPlane') {
        if (!(value instanceof Plane)) {
          fail(`startPlane must be a plane, got ${FeatureBucketSet.describe(value)}`);
        }
        continue;
      }
      if (!FeatureBucketSet.isStandard(name) && !this.has(name)) {
        fail(this.unknownName(name, callee));
      }
      const kind = FeatureBucketSet.kindOf(name);
      if (!Array.isArray(value)) {
        fail(`${name} must be a list of ${kind}s, got ${FeatureBucketSet.describe(value)}`);
      }
      (value as unknown[]).forEach((member, i) => {
        if (!(kind === 'face' ? member instanceof Face : member instanceof Edge)) {
          fail(`${name}[${i}] is ${FeatureBucketSet.describe(member)}, not ${kind === 'face' ? 'a face' : 'an edge'} — ${name} holds ${kind}s`);
        }
      });
    }
  }

  /** The closest bucket name to `name` the feature has — declared or standard — within two edits, or null. */
  suggest(name: string): string | null {
    let best: string | null = null;
    let bestDistance = 3;
    const candidates = [...this.buckets.map(bucket => bucket.name), ...FeatureBucketSet.STANDARD_KEYS.keys()];
    for (const candidate of candidates) {
      const distance = FeatureBucketSet.editDistance(name, candidate);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  private custom(): DeclaredBucket[] {
    return this.buckets.filter(bucket => !bucket.standard);
  }

  /** The state key of `edgeName`'s face sibling (`tipEdges` → `bucket:tipFaces`) when it is declared, else null. */
  private faceSiblingKeyOf(edgeName: string): string | null {
    const sibling = this.buckets.find(bucket => bucket.name === `${edgeName.slice(0, -'Edges'.length)}Faces`);
    return sibling ? sibling.key : null;
  }

  private unknownName(name: string, callee: string): string {
    const suggestion = this.suggest(name);
    if (suggestion) {
      return `'${name}' is not a bucket of ${callee} — did you mean ${suggestion}?`;
    }
    const custom = this.customNames();
    const own = custom.length > 0 ? `, and its own: ${custom.join(', ')}` : '';
    return `'${name}' is not a bucket of ${callee} — its buckets are the standard ones (startFaces, endFaces, sideFaces, internalFaces, capFaces and their Edges)${own}; `
      + 'declare another with Feature.with(params, { buckets })';
  }

  /** The nearest class in `featureClass`'s chain that declares `buckets` of its own, or null. */
  private static ownerOf(featureClass: Function): Function | null {
    for (let cls: unknown = featureClass; typeof cls === 'function' && cls !== Function.prototype; cls = Object.getPrototypeOf(cls)) {
      if (Object.prototype.hasOwnProperty.call(cls, 'buckets')) {
        return cls as Function;
      }
    }
    return null;
  }

  /** Check `owner`'s declarations and install their accessors on its prototype. */
  private static declare(owner: Function, where: string): FeatureBucketSet {
    const fail = (message: string): never => {
      throw new Error(`${where}: ${message}`);
    };
    const specs = (owner as { buckets?: unknown }).buckets;
    if (!FeatureCall.isPlainObject(specs)) {
      fail(`'buckets' must be an object of the feature's buckets by name, such as { tipFaces: {}, boreEdges: { label: 'Bore Rims' } } — got ${FeatureBucketSet.describe(specs)}`);
    }
    const names = Object.keys(specs as object);
    if (names.length > FeatureBucketSet.MAX_BUCKETS) {
      fail(`declares ${names.length} buckets — a feature declares at most ${FeatureBucketSet.MAX_BUCKETS}`);
    }
    const buckets = names.map(name => FeatureBucketSet.checked(name, (specs as Record<string, unknown>)[name], fail));
    const set = new FeatureBucketSet(buckets);
    set.refuseCollisions(owner, fail);
    set.install(owner);
    return set;
  }

  /** One declaration, checked: its name (CB2), then its fields (CB3). */
  private static checked(name: string, spec: unknown, fail: (message: string) => never): DeclaredBucket {
    const refusal = FeatureBucketSet.nameRefusal(name);
    if (refusal) {
      fail(refusal);
    }
    if (!FeatureCall.isPlainObject(spec)) {
      fail(`bucket '${name}' is declared with an object — {} or { label } — got ${FeatureBucketSet.describe(spec)}`);
    }
    const declared = spec as Record<string, unknown>;
    for (const field of Object.keys(declared)) {
      if (field === 'kind') {
        fail(`bucket '${name}': leave 'kind' out — the name's ending gives it: a …Faces bucket holds faces, an …Edges bucket edges`);
      }
      if (field === 'description') {
        fail(`bucket '${name}': leave 'description' out — describe what the feature's buckets hold in the package's docs/ pages`);
      }
      if (!FeatureBucketSet.FIELDS.includes(field)) {
        fail(`bucket '${name}': unknown field '${field}' — a bucket declares only its ${FeatureBucketSet.FIELDS.join(' and ')}`);
      }
    }
    const { label } = declared;
    if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
      fail(`bucket '${name}': 'label' must be text that says something, got ${FeatureBucketSet.describe(label)}`);
    }
    const standard = FeatureBucketSet.isStandard(name);
    return {
      name,
      kind: FeatureBucketSet.kindOf(name),
      key: standard ? FeatureBucketSet.STANDARD_KEYS.get(name)! : FeatureBucketSet.keyOf(name),
      label: (label as string | undefined) ?? BucketDefs.labelOf(name),
      standard,
    };
  }

  /** Why `name` can't name a bucket, with the name it may have meant, or null. */
  private static nameRefusal(name: string): string | null {
    if (FeatureBucketSet.PATTERN.test(name)) {
      return name.length > FeatureBucketSet.MAX_NAME_LENGTH
        ? `the bucket name '${name}' is longer than ${FeatureBucketSet.MAX_NAME_LENGTH} characters`
        : null;
    }
    if (name === 'Faces' || name === 'Edges') {
      return `'${name}' needs a name before ${name}, such as tip${name}`;
    }
    const suggestion = FeatureBucketSet.suggestedName(name);
    const hint = suggestion ? ` (${suggestion}?)` : '';
    if (!/(Faces|Edges)$/.test(name)) {
      return `'${name}' needs to end in Faces or Edges${hint}`;
    }
    return `'${name}' is not a bucket name — a lowercase letter, then letters and digits, ending in Faces or Edges${hint}`;
  }

  /** What a name that breaks the pattern may have meant: `teeth` → `teethFaces`, `tip-edge` → `tipEdges`. */
  private static suggestedName(name: string): string | null {
    const words = name.split(/[^A-Za-z0-9]+/).filter(word => word !== '');
    if (words.length === 0) {
      return null;
    }
    const camel = words
      .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
      .join('');
    const ending = /(faces?|edges?)$/i.exec(camel);
    const base = ending ? camel.slice(0, -ending[1].length) : camel;
    const kind = ending && ending[1].toLowerCase().startsWith('edge') ? 'Edges' : 'Faces';
    const candidate = `${base}${kind}`;
    return candidate !== name && FeatureBucketSet.PATTERN.test(candidate) && candidate.length <= FeatureBucketSet.MAX_NAME_LENGTH
      ? candidate
      : null;
  }

  /**
   * Refuse a custom name the class already answers: a member anywhere up the
   * chain — `getAddedFaces()` and its kin end in `Faces` too — or a method
   * the declaring class writes itself. An accessor another set installed for
   * the same name is no clash: it reads the same bucket.
   */
  private refuseCollisions(owner: Function, fail: (message: string) => never): void {
    const prototype = owner.prototype as object;
    for (const bucket of this.custom()) {
      const own = Object.getOwnPropertyDescriptor(prototype, bucket.name);
      if (own && !FeatureBucketSet.isInstalled(own)) {
        fail(`${owner.name || 'the class'} writes ${bucket.name}() itself — the declared bucket makes that accessor; remove the method or rename the bucket`);
      }
      const inherited = FeatureBucketSet.memberOf(Object.getPrototypeOf(prototype), bucket.name);
      if (inherited && !FeatureBucketSet.isInstalled(inherited.descriptor)) {
        fail(`'${bucket.name}' is already a member of ${inherited.owner} — give the bucket another name`);
      }
    }
  }

  /** Refuse a method a subclass writes over one of the accessors it inherits from the declaring class. */
  private refuseHandWritten(featureClass: Function, owner: Function): void {
    const custom = this.customNames();
    if (custom.length === 0) {
      return;
    }
    for (let prototype = featureClass.prototype as object | null; prototype && prototype !== owner.prototype; prototype = Object.getPrototypeOf(prototype)) {
      for (const name of custom) {
        const own = Object.getOwnPropertyDescriptor(prototype, name);
        if (own && !FeatureBucketSet.isInstalled(own)) {
          const cls = (prototype as { constructor?: Function }).constructor;
          throw new Error(`${FeatureBucketSet.whereOf(cls ?? featureClass)}: ${cls?.name || 'the class'} writes ${name}() itself — `
            + 'the declared bucket makes that accessor; remove the method or rename the bucket');
        }
      }
    }
  }

  /** One accessor per custom bucket, on the declaring class's prototype, defined once. */
  private install(owner: Function): void {
    const prototype = owner.prototype as object;
    for (const bucket of this.custom()) {
      if (Object.prototype.hasOwnProperty.call(prototype, bucket.name)) {
        continue;
      }
      Object.defineProperty(prototype, bucket.name, { value: FeatureBucketSet.accessorFor(bucket), writable: true, configurable: true });
    }
  }

  /** `tipFaces(...args)`: the bucket at `bucket:tipFaces`, read through the base's own face path. */
  private static accessorFor(bucket: DeclaredBucket): Function {
    const key = bucket.key;
    const accessor = bucket.kind === 'face'
      ? function (this: BucketReader, ...args: FaceArgs): ISelection {
        return this.faceSelection(key, args);
      }
      : function (this: BucketReader, ...args: EdgeArgs): ISelection {
        return this.edgeSelection(key, args);
      };
    Object.defineProperty(accessor, 'name', { value: bucket.name });
    Object.defineProperty(accessor, FeatureBucketSet.INSTALLED, { value: bucket.name });
    return accessor;
  }

  private static isInstalled(descriptor: PropertyDescriptor): boolean {
    return typeof descriptor.value === 'function' && (descriptor.value as unknown as Record<symbol, unknown>)[FeatureBucketSet.INSTALLED] !== undefined;
  }

  /** The first definition of `name` up a prototype chain, read without calling a getter, with the class that has it. */
  private static memberOf(prototype: object | null, name: string): { descriptor: PropertyDescriptor; owner: string } | null {
    for (let at = prototype; at; at = Object.getPrototypeOf(at)) {
      const descriptor = Object.getOwnPropertyDescriptor(at, name);
      if (descriptor) {
        return { descriptor, owner: (at as { constructor?: Function }).constructor?.name || 'the class it extends' };
      }
    }
    return null;
  }

  /** Who a refusal names: the feature by its id, else the class by its name. */
  private static whereOf(featureClass: Function): string {
    const id = (featureClass as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') {
      return `feature '${id}'`;
    }
    return featureClass.name || 'a feature class';
  }

  /** The edits (insert, delete, replace) that turn `a` into `b`. */
  private static editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return row[b.length];
  }

  /** What a refusal says a value is: `a face`, `an edge`, `a list`, `null`, `'tip'`. */
  private static describe(value: unknown): string {
    if (value === undefined) {
      return 'nothing';
    }
    if (value === null) {
      return 'null';
    }
    if (value instanceof Shape) {
      const type = value.getType();
      return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
    }
    if (value instanceof Plane) {
      return 'a plane';
    }
    if (Array.isArray(value)) {
      return 'a list';
    }
    if (typeof value === 'string') {
      return `'${value}'`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return typeof value === 'function' ? 'a function' : 'an object';
  }
}
