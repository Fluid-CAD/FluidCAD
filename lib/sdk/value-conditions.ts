/**
 * The `when` grammar of a feature's values, read wherever values are known:
 * a value's `visibleWhen`, an option's `when` and a conditional default's
 * `when` all speak it, and the engine, the server's call writer and the
 * dialog all read it here — so a condition holds in one place exactly when
 * it holds in the others.
 *
 * A condition is one object of clauses, every clause holding, or a list of
 * such objects of which any one holds:
 * - a clause on a typed-in value names it and the value it must equal, or a
 *   list of values it must equal one of — `{ style: ['counterbore', 'countersink'] }`;
 * - a clause on a picked value (a `visibleWhen` only) is a condition on what
 *   it holds — `{ at: { picked: true } }`, `{ faces: { count: 3 } }`,
 *   `{ at: { surface: 'cylinder' } }`, `{ at: { not: { … } } }` — read off
 *   the value's {@link PickState}.
 *
 * A value that is not there holds no clause; no clauses always hold.
 *
 * This module imports nothing so the ui can compile it in directly.
 */

/** A typed-in value a clause compares: what one row holds. */
export type ConditionScalar = string | number | boolean;

/** What a picked face is, as a pick condition tells picked faces apart. */
export type ConditionSurface = 'planar' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';

/** A condition on a picked value (see `PickCondition` in the feature metadata). */
export type ConditionOnPicks = {
  readonly picked?: boolean;
  readonly count?: number | readonly number[];
  readonly surface?: ConditionSurface | readonly ConditionSurface[];
  readonly not?: ConditionOnPicks;
};

/** One case: every named value equals the given one (or one of a list), every named picked value meets its condition. */
export type ConditionCase = { readonly [name: string]: ConditionScalar | readonly ConditionScalar[] | ConditionOnPicks };

/** A condition: one case, or a list of cases of which any one holds. */
export type Condition = ConditionCase | readonly ConditionCase[];

/** What a picked value holds, as a pick condition reads it: each pick's surface — null for a pick that is not a face, or not told apart yet. */
export type PickState = { readonly picks: readonly (ConditionSurface | null)[] };

/** One conditional default of a value: the value it takes while `when` holds. */
export type ConditionalDefault<T = unknown> = { readonly when: Condition; readonly value: T };

/** What a value declares about its default, as far as the conditions read it. */
export type DefaultsSpec = { readonly default?: unknown; readonly defaults?: readonly ConditionalDefault[] };

export class ValueConditions {

  /**
   * Whether `when` holds for `values` by name: every clause of one case, or
   * of any one case of a list. A typed-in clause holds when the value equals
   * the one given, or one of a list; a clause on a picked value reads the
   * value as its {@link PickState} (none: nothing picked). No condition
   * always holds.
   */
  static holds(when: Condition | undefined, values: Readonly<Record<string, unknown>>): boolean {
    if (Array.isArray(when)) {
      return ValueConditions.casesOf(when).some(each => ValueConditions.holds(each, values));
    }
    return Object.entries((when ?? {}) as ConditionCase).every(([name, expected]) => {
      const value = values[name];
      if (ValueConditions.isPickCondition(expected)) {
        const state = typeof value === 'object' && value !== null && Array.isArray((value as PickState).picks) ? value as PickState : undefined;
        return ValueConditions.pickHolds(expected, state?.picks ?? []);
      }
      return value !== undefined && (Array.isArray(expected) ? (expected as readonly unknown[]).includes(value) : expected === value);
    });
  }

  /** The cases of a condition: the one object, each of a list, or none. */
  static casesOf(when: Condition | undefined): readonly ConditionCase[] {
    return when === undefined ? [] : Array.isArray(when) ? when as readonly ConditionCase[] : [when as ConditionCase];
  }

  /** The values a condition names, each once, in the order the cases name them. */
  static namesOf(when: Condition | undefined): string[] {
    return [...new Set(ValueConditions.casesOf(when).flatMap(each => Object.keys(each)))];
  }

  /** Whether a clause's expected value is a picked value's condition (an object), not values to match. */
  static isPickCondition(expected: unknown): expected is ConditionOnPicks {
    return typeof expected === 'object' && expected !== null && !Array.isArray(expected);
  }

  /**
   * Whether a picked value meets its condition, given what it holds: how
   * many picks, and the surface of each (`null` for a pick that is not a
   * face, or not yet told apart).
   */
  static pickHolds(condition: ConditionOnPicks, picks: readonly (ConditionSurface | null)[]): boolean {
    if (condition.picked !== undefined && condition.picked !== picks.length > 0) {
      return false;
    }
    if (condition.count !== undefined) {
      const counts: readonly number[] = typeof condition.count === 'number' ? [condition.count] : condition.count;
      if (!counts.includes(picks.length)) {
        return false;
      }
    }
    if (condition.surface !== undefined) {
      const wanted: readonly ConditionSurface[] = typeof condition.surface === 'string' ? [condition.surface] : condition.surface;
      if (picks.length === 0 || !picks.every(surface => surface !== null && wanted.includes(surface))) {
        return false;
      }
    }
    return condition.not === undefined || !ValueConditions.pickHolds(condition.not, picks);
  }

  /**
   * The entry of a value's `defaults` that applies for `values`: the first
   * whose `when` holds; null when none does (its plain `default` applies),
   * or it declares none.
   */
  static matchingDefault<T>(spec: { readonly defaults?: readonly ConditionalDefault<T>[] }, values: Readonly<Record<string, unknown>>): ConditionalDefault<T> | null {
    return spec.defaults?.find(entry => ValueConditions.holds(entry.when, values)) ?? null;
  }

  /**
   * A value's effective default for `values`: the value of the first of its
   * `defaults` whose `when` holds, else `fallback` — its plain default, as
   * the caller resolved it (declared, or the one its control always shows).
   */
  static defaultIn<T>(spec: { readonly defaults?: readonly ConditionalDefault<T>[] }, values: Readonly<Record<string, unknown>>, fallback: T | undefined): T | undefined {
    const entry = ValueConditions.matchingDefault(spec, values);
    return entry ? entry.value : fallback;
  }

  /** Whether a value declares conditional defaults. */
  static hasDefaults(spec: DefaultsSpec | undefined): boolean {
    return Array.isArray(spec?.defaults) && spec.defaults.length > 0;
  }

  /** The values a value's `defaults` name, each once: what its effective default waits on. */
  static namedByDefaults(spec: DefaultsSpec | undefined): string[] {
    return [...new Set((spec?.defaults ?? []).flatMap(entry => ValueConditions.namesOf(entry.when)))];
  }

  /**
   * Whether two typed-in values are the same value: equal scalars, or lists
   * of the same entries in the same order.
   */
  static same(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((entry, index) => entry === b[index]);
    }
    return a === b;
  }
}
