import { SceneObject } from "../common/scene-object.js";
import type { ISceneObject } from "../core/interfaces.js";

/** A scalar a feature takes: a number, a string or a boolean. */
export type FeatureScalar = number | string | boolean;

/**
 * One value a feature takes: a scalar, a list of scalars, a reference to a
 * scene object (a face selection, a sketch, a feature) or a list of them, or
 * nothing at all for a value left out.
 */
export type FeatureValue = FeatureScalar | FeatureScalar[] | ISceneObject | ISceneObject[] | null | undefined;

/** A feature's values, by name — what its constructor takes. */
export type FeatureValues = { [name: string]: FeatureValue };

/**
 * On a values object the metadata completed (`FeatureMetas.complete`): the
 * names the call gave, as a `Set<string>` — the rest it filled with
 * defaults. A feature tells a value the statement passed from one it left
 * out by it ({@link FeatureInputs.wasGiven}).
 */
export const GIVEN_VALUES: unique symbol = Symbol.for('fluidcad.feature-given-values');

/** A reference value as the serialized feature names it. */
export type FeatureReferenceSummary = { type: string; id: string };

type Scalar = FeatureScalar | FeatureScalar[] | null | undefined;
type Reference = SceneObject | SceneObject[];

/**
 * A feature's values, split by kind. Scalars — numbers, strings, booleans,
 * lists of those, or nothing — compare by value. References — scene objects
 * or lists of them — compare with their own `compareTo`, are what the
 * feature depends on, and are what a copy remaps. Anything else (a function,
 * a plain object, a list mixing the two kinds) is refused when the feature
 * is constructed: the cache, the copy and the editor could not tell two of
 * them apart.
 */
export class FeatureInputs {

  private constructor(
    /** The values as given, copied and frozen: later changes to the caller's object never reach the feature. */
    readonly values: Readonly<FeatureValues>,
    private readonly scalars: Map<string, Scalar>,
    private readonly refs: Map<string, Reference>,
    /** The names the call gave ({@link GIVEN_VALUES}); null when nothing said, so every value counts as given. */
    private readonly given: ReadonlySet<string> | null,
  ) {}

  /** Split `values` for the feature `id`, refusing any value that is neither kind. */
  static from(id: string, values: unknown): FeatureInputs {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error(`${id}: a feature is constructed from one object of named values`);
    }
    const copied: FeatureValues = {};
    const scalars = new Map<string, Scalar>();
    const refs = new Map<string, Reference>();
    for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
      const kind = FeatureInputs.kindOf(value);
      if (kind === null) {
        throw new Error(
          `${id}: value '${name}' is ${FeatureInputs.describe(value)} — a feature takes numbers, strings, `
          + 'booleans, lists of those, and scene objects or lists of them',
        );
      }
      const own = Array.isArray(value) ? Object.freeze([...value]) as unknown as FeatureValue : value as FeatureValue;
      copied[name] = own;
      if (kind === 'reference') {
        refs.set(name, own as unknown as Reference);
      } else {
        scalars.set(name, own as Scalar);
      }
    }
    const given = (values as { [GIVEN_VALUES]?: unknown })[GIVEN_VALUES];
    return new FeatureInputs(Object.freeze(copied), scalars, refs, given instanceof Set ? new Set(given as Set<string>) : null);
  }

  /** Whether the call gave the value itself, rather than the metadata filling its default. */
  wasGiven(name: string): boolean {
    return this.given === null ? name in this.values : this.given.has(name);
  }

  /** Every reference, lists flattened, in the order the values were given. */
  references(): SceneObject[] {
    return [...this.refs.values()].flat();
  }

  /** The same names, scalars equal by value and references by `compareTo`. */
  equals(other: FeatureInputs): boolean {
    const names = Object.keys(this.values);
    const otherNames = Object.keys(other.values);
    if (names.length !== otherNames.length || names.some(name => !(name in other.values))) {
      return false;
    }
    for (const [name, scalar] of this.scalars) {
      if (!other.scalars.has(name) || !FeatureInputs.scalarEquals(scalar, other.scalars.get(name))) {
        return false;
      }
    }
    for (const [name, ref] of this.refs) {
      if (!other.refs.has(name) || !FeatureInputs.referenceEquals(ref, other.refs.get(name)!)) {
        return false;
      }
    }
    return true;
  }

  /** The values with every reference the copy set holds swapped for its copy. */
  remapped(remap: Map<SceneObject, SceneObject>): FeatureValues {
    const out: FeatureValues = { ...this.values };
    for (const [name, ref] of this.refs) {
      out[name] = Array.isArray(ref)
        ? ref.map(entry => remap.get(entry) ?? entry)
        : remap.get(ref) ?? ref;
    }
    return out;
  }

  /** The scalars as they are, and each reference by its type and id. */
  serialize(): { values: Record<string, Scalar>; references: Record<string, FeatureReferenceSummary | FeatureReferenceSummary[]> } {
    const summary = (ref: SceneObject): FeatureReferenceSummary => ({ type: ref.getType(), id: ref.id });
    const references: Record<string, FeatureReferenceSummary | FeatureReferenceSummary[]> = {};
    for (const [name, ref] of this.refs) {
      references[name] = Array.isArray(ref) ? ref.map(summary) : summary(ref);
    }
    return { values: Object.fromEntries(this.scalars), references };
  }

  /** 'scalar', 'reference', or null for a value of neither kind. An empty list is a scalar list. */
  private static kindOf(value: unknown): 'scalar' | 'reference' | null {
    if (value === null || value === undefined || FeatureInputs.isScalar(value)) {
      return 'scalar';
    }
    if (value instanceof SceneObject) {
      return 'reference';
    }
    if (Array.isArray(value)) {
      if (value.every(entry => FeatureInputs.isScalar(entry))) {
        return 'scalar';
      }
      if (value.every(entry => entry instanceof SceneObject)) {
        return 'reference';
      }
    }
    return null;
  }

  private static isScalar(value: unknown): value is FeatureScalar {
    return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
  }

  private static describe(value: unknown): string {
    if (typeof value === 'function') {
      return 'a function';
    }
    if (Array.isArray(value)) {
      return 'a list mixing scene objects with other values';
    }
    return typeof value === 'object' ? 'a plain object' : `a ${typeof value}`;
  }

  /** Two scalars (or lists of them) equal by value, NaN to NaN. */
  static scalarEquals(a: Scalar, b: Scalar): boolean {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
      }
      return a.every((entry, i) => FeatureInputs.scalarEquals(entry, b[i]));
    }
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }

  private static referenceEquals(a: Reference, b: Reference): boolean {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
      }
      return a.every((entry, i) => entry.compareTo(b[i]));
    }
    return a.compareTo(b);
  }
}
