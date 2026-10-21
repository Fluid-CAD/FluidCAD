import { ParamKey, type ParamLabelResolution } from './param-key.js';
import type { ParamRegistry, ParamVal } from './param-registry.js';

/** One session override: the parameter it sets and the value. */
export type SessionParamOverride = { key: ParamKey; value: unknown };

/**
 * One rendering session's Parameters-panel values — the overrides a user
 * typed, which are never written to source — and the bookkeeping that keeps
 * them honest across renders. Shared by the desktop server (one per file
 * session) and `BrowserEngineHost` (its one implicit session), so both
 * resolve, retire and report overrides the same way.
 *
 * Everything is keyed by `ParamKey`: a part's `Width` and another part's
 * `Width` are two overrides. A reference by label alone (an older client, a
 * package manifest, an override set before the label rendered) resolves to
 * the one body declaring it in the last render ({@link keyFor}); when
 * several do it is refused rather than guessed. A label-only entry already
 * in the map stands for every body of that label until the next
 * {@link settle} splits it into one entry per body.
 */
export class SessionParamOverrides {

  /** `ParamKey.id` → the override value. */
  private readonly overrides = new Map<string, unknown>();
  /**
   * `ParamKey.id` → the literal each parameter was authored with as of the
   * last render. An override is a delta over that default, so when the file
   * re-declares it the override is stale and gets dropped instead of
   * shadowing the value the code now asks for.
   */
  private readonly baselines = new Map<string, ParamVal>();
  /** label → the bodies declaring it in the last settled render — what a label-only reference resolves against. */
  private holders = new Map<string, string[]>();

  /** How many overrides are set. */
  get size(): number {
    return this.overrides.size;
  }

  /**
   * The parameter `label` names: `body`'s when given, else the one body
   * declaring the label, else a refusal naming the bodies that do.
   */
  keyFor(label: string, body?: string | null): ParamLabelResolution {
    if (body !== undefined && body !== null) {
      return { key: ParamKey.of(body, label) };
    }
    return ParamKey.resolveLabel(label, this.holdersWithEntries());
  }

  set(key: ParamKey, value: unknown): void {
    this.overrides.set(key.id, value);
  }

  /** Drop every override; the baselines stay — they describe the source, not the session. */
  clear(): void {
    this.overrides.clear();
  }

  /** Forget a deleted parameter's override and the baseline behind it. */
  forget(key: ParamKey): void {
    this.overrides.delete(key.id);
    this.baselines.delete(key.id);
  }

  /**
   * Follow a label rename in the source: the override and the baseline it
   * was set against move to the new label of the same body. Only called
   * once the source edit landed, and that edit refuses a rename onto a label
   * the body already declares — so anything under the new key belonged to a
   * parameter that no longer exists.
   */
  rename(key: ParamKey, label: string): void {
    const to = key.withLabel(label);
    SessionParamOverrides.moveKey(this.overrides, key.id, to.id);
    SessionParamOverrides.moveKey(this.baselines, key.id, to.id);
  }

  /** Hand the overrides and their baselines to a render's fresh registry. */
  install(registry: ParamRegistry): void {
    if (this.overrides.size > 0) {
      registry.setOverrides(new Map(this.overrides), new Map(this.baselines));
    }
  }

  /**
   * Close the loop on a render's param bookkeeping: remember what each
   * `param()` declared so the next render can tell an edited default from an
   * unchanged one, give each body a label-only entry stood for its own
   * entry, forget the overrides this render found stale, and learn which
   * bodies declare which label.
   *
   * Baselines merge rather than replace — a param that didn't run this pass
   * (breakpoint, untaken branch) keeps the default it last declared, so an
   * edit to *its* literal is still recognized later. Absence alone never
   * drops an override for the same reason: not running is not un-declaring.
   */
  settle(registry: ParamRegistry): void {
    for (const [id, authored] of registry.getAuthoredDefaults()) {
      this.baselines.set(id, authored);
    }
    for (const [label, ids] of registry.getLabelOverrideUse()) {
      const value = this.overrides.get(label);
      this.overrides.delete(label);
      for (const id of ids) {
        if (!this.overrides.has(id)) {
          this.overrides.set(id, value);
        }
      }
      if (ids.length > 1) {
        console.warn(
          `Parameter override '${label}' names no part, and ${ids.map(id => `'${ParamKey.parse(id).body}'`).join(', ')} `
          + `all declare it — it was applied to each. Each part's '${label}' is now set on its own.`,
        );
      }
    }
    for (const id of registry.getDiscardedOverrides()) {
      this.overrides.delete(id);
    }
    this.holders = ParamKey.holdersOf(registry.getDefinitions());
  }

  /** Every override, keyed. */
  entries(): SessionParamOverride[] {
    return Array.from(this.overrides, ([id, value]) => ({ key: ParamKey.parse(id), value }));
  }

  /**
   * The overrides as a plain record, each under the shortest name that
   * still says which parameter it sets: its label while no other body
   * declares (or overrides) that label — so a single-part file's record is
   * exactly the label-keyed one it always was — else its `ParamKey.id`.
   * {@link restore} reads the record back.
   */
  toRecord(): Record<string, unknown> {
    const holders = this.holdersWithEntries();
    const record: Record<string, unknown> = {};
    for (const [id, value] of this.overrides) {
      const key = ParamKey.parse(id);
      const unique = (holders.get(key.label)?.length ?? 0) <= 1;
      record[unique ? key.label : id] = value;
    }
    return record;
  }

  /**
   * Replace the overrides with a record {@link toRecord} produced (or a
   * label-keyed one from before keys had a body): each name is parsed back,
   * and a bare label resolves to the one body declaring it when the last
   * render knows one — else it stays label-only for the next render.
   */
  restore(record: Record<string, unknown>): void {
    this.overrides.clear();
    for (const [name, value] of Object.entries(record)) {
      const parsed = ParamKey.parse(name);
      const resolved = parsed.labelOnly ? ParamKey.resolveLabel(parsed.label, this.holders) : null;
      const key = resolved && 'key' in resolved ? resolved.key : parsed;
      this.overrides.set(key.id, value);
    }
  }

  /** The overrides in a canonical, order-independent form — for a render cache key. */
  fingerprint(): [string, unknown][] {
    return Array.from(this.overrides.entries()).sort(([a], [b]) => a.localeCompare(b));
  }

  /** The last render's holders plus the body of every keyed override — a label two bodies override is shared too. */
  private holdersWithEntries(): Map<string, string[]> {
    const holders = new Map(Array.from(this.holders, ([label, bodies]) => [label, bodies.slice()]));
    for (const id of this.overrides.keys()) {
      const key = ParamKey.parse(id);
      if (key.body === null) {
        continue;
      }
      const bodies = holders.get(key.label) ?? [];
      if (!bodies.includes(key.body)) {
        bodies.push(key.body);
      }
      holders.set(key.label, bodies);
    }
    return holders;
  }

  private static moveKey<T>(map: Map<string, T>, from: string, to: string): void {
    if (!map.has(from)) {
      return;
    }
    map.set(to, map.get(from)!);
    map.delete(from);
  }
}
