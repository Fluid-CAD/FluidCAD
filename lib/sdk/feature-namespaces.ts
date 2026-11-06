import { FeatureKey } from './feature-key.js';

/**
 * Answers which installed package's module the engine is evaluating at this
 * moment: its public name (`@acme/feature-tests`), or null for anything else
 * — a workspace module, the engine itself, or no module at all.
 */
export type FeatureNamespaceSource = () => string | null;

type NamespaceState = {
  source: FeatureNamespaceSource | null;
  /** The package each claimed class came from, null for one claimed outside any package. */
  claims: WeakMap<object, string | null>;
  /**
   * Answers the stamp of the package whose module is evaluating — see
   * {@link FeatureNamespaces.useStamp}. A field of its own, not a richer
   * answer from `source`: a kernel copy that predates it keeps reading
   * `source` as the package name.
   */
  stampSource?: FeatureNamespaceSource | null;
};

/**
 * Which installed package a feature class came from, so the engine can key
 * its features by the package (`@acme/feature-tests:standoff`) while their
 * source declares a plain id (`static id = 'standoff'`).
 *
 * The host says where it is evaluating: the server's scene host installs a
 * {@link FeatureNamespaceSource} that answers the package owning the module
 * whose code is running — it knows, because it evaluates every module
 * itself and holds that answer around each evaluation (an async context,
 * so awaits and nested imports keep it right). A class is claimed once,
 * when its metadata resolves (`defineFeature`, `registerBuilder({ feature
 * })`), and that happens while its module evaluates: a feature defined in
 * a package's file — a feature module or a helper beside it — is the
 * package's. No source installed (the browser host, the packer's in-process
 * engine, the tests) keys every feature by its plain id, as the author's
 * own workspace does.
 *
 * The state sits on a registry symbol, so a kernel copy other than the
 * server's own reads the same source and claims.
 */
export class FeatureNamespaces {
  private static readonly SLOT: unique symbol = Symbol.for('fluidcad.feature-namespaces') as never;

  /** Install the host's source (null removes it); answers the one it replaces. */
  static use(source: FeatureNamespaceSource | null): FeatureNamespaceSource | null {
    const state = FeatureNamespaces.state();
    const previous = state.source;
    state.source = source;
    return previous;
  }

  /**
   * Record the package `featureClass` came from, by asking the source now.
   * The first claim wins: a class registered twice keeps the package of its
   * first registration. Without a source nothing is recorded, so a class
   * claimed before the host installed one is still asked later.
   */
  static claim(featureClass: object): void {
    const state = FeatureNamespaces.state();
    if (state.source === null || state.claims.has(featureClass)) {
      return;
    }
    let owner: string | null = null;
    try {
      owner = state.source();
    } catch {
      owner = null;
    }
    state.claims.set(featureClass, typeof owner === 'string' && owner !== '' ? owner : null);
  }

  /**
   * Install the host's stamp source (null removes it); answers the one it
   * replaces. While an installed package's module evaluates, it answers
   * that package's stamp — its name, version and tree hash
   * (`@acme/cabinets@1.2.0#<integrity>`), which change exactly when its code
   * can — and null for anything else.
   */
  static useStamp(source: FeatureNamespaceSource | null): FeatureNamespaceSource | null {
    const state = FeatureNamespaces.state();
    const previous = state.stampSource ?? null;
    state.stampSource = source;
    return previous;
  }

  /**
   * The stamp of the installed package whose module is evaluating now (see
   * {@link useStamp}), or null: a workspace module, no module, or no
   * stamp source installed (the browser host, the tests).
   */
  static currentStamp(): string | null {
    const source = FeatureNamespaces.state().stampSource ?? null;
    if (source === null) {
      return null;
    }
    try {
      const stamp = source();
      return typeof stamp === 'string' && stamp !== '' ? stamp : null;
    } catch {
      return null;
    }
  }

  /** The public name of the package `featureClass` came from, or null. */
  static packageOf(featureClass: object): string | null {
    return FeatureNamespaces.state().claims.get(featureClass) ?? null;
  }

  /** The catalog key of `featureClass`, whose plain id is `id` (see {@link FeatureKey}). */
  static keyOf(featureClass: object, id: string): string {
    const owner = FeatureNamespaces.packageOf(featureClass);
    return owner === null ? id : FeatureKey.of(owner, id);
  }

  private static state(): NamespaceState {
    const holder = globalThis as unknown as Record<symbol, NamespaceState | undefined>;
    let state = holder[FeatureNamespaces.SLOT];
    if (!state) {
      state = { source: null, claims: new WeakMap() };
      holder[FeatureNamespaces.SLOT] = state;
    }
    return state;
  }
}
