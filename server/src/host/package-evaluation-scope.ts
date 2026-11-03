import { AsyncLocalStorage } from 'node:async_hooks';
import { ESModulesEvaluator, type EvaluatedModuleNode, type ModuleEvaluator, type ModuleRunnerContext } from 'vite/module-runner';
import { FeatureNamespaces } from '../../../lib/dist/sdk/feature-namespaces.js';

/**
 * An installed package that owns a module file: its public name, and its
 * stamp — `<name>@<version>#<tree hash>`, what changes exactly when the
 * package's code can — when the host knows it.
 */
export type ModuleOwnerInfo = { name: string; stamp: string | null };

/** The installed package that owns a module file — by its public name, or with its stamp — or null. */
export type ModuleOwner = (file: string) => string | ModuleOwnerInfo | null;

/**
 * Which installed package's module the engine is evaluating right now — how
 * `FeatureNamespaces` keys a package's features by the package
 * (`@acme/feature-tests:standoff`) without reading a stack.
 *
 * The scene host evaluates every module of a model itself, through its
 * module runner, and knows each module's file before its code runs. The
 * evaluator {@link evaluator} hands the runner holds the module's owner in
 * an async context around the module's evaluation: the package for a file
 * under an installed package's root (`PackageRoots.owner`, location plus
 * marker), null for anything else. `defineFeature()` and `registerBuilder({
 * feature })` run while their module evaluates, so they read the module
 * that defines the class, whatever helper `.js` it sits in.
 *
 * An async context rather than a variable set and reset around the call:
 * a module awaits its imports, and each import evaluates inside the
 * importer's evaluation. The context gives every nested evaluation its own
 * owner and hands the importer back its own after the await, a top-level
 * await included. Modules the runner leaves to Node (the engine, built-ins)
 * evaluate with no owner, so a kernel first imported by a package's module
 * claims nothing.
 *
 * The context is one per process: every host's evaluator writes the owner
 * by its own project's package roots, and the one source installed in
 * `FeatureNamespaces` reads whichever evaluation is running.
 *
 * The owner carries the package's stamp beside its name when the host knows
 * it: a generator class defined in a package takes it into its code
 * version (`FeatureNamespaces.currentStamp`), so a package's generated
 * parts are rebuilt exactly when another version or tree of it loads, with
 * no module graph walk.
 */
export class PackageEvaluationScope {
  private static readonly evaluating = new AsyncLocalStorage<ModuleOwnerInfo | null>();

  /** The public name of the package whose module is evaluating now, or null. */
  static current(): string | null {
    return PackageEvaluationScope.evaluating.getStore()?.name ?? null;
  }

  /** The stamp of the package whose module is evaluating now, or null (none, or not known). */
  static currentStamp(): string | null {
    return PackageEvaluationScope.evaluating.getStore()?.stamp ?? null;
  }

  /**
   * Make {@link current} the engine's `FeatureNamespaces` source and
   * {@link currentStamp} its stamp source. Idempotent.
   */
  static install(): void {
    FeatureNamespaces.use(PackageEvaluationScope.current);
    FeatureNamespaces.useStamp(PackageEvaluationScope.currentStamp);
  }

  /** Run `body` as the evaluation of a module `owner` owns (null: no package). */
  static run<T>(owner: string | ModuleOwnerInfo | null, body: () => T): T {
    return PackageEvaluationScope.evaluating.run(PackageEvaluationScope.infoOf(owner), body);
  }

  /** The module evaluator a host's runner uses: Vite's own, inside each module's owner. */
  static evaluator(ownerOf: ModuleOwner, base: ModuleEvaluator = new ESModulesEvaluator()): ModuleEvaluator {
    return new ScopedModuleEvaluator(ownerOf, base);
  }

  /** An owner as the context holds it: a bare name has no stamp. */
  static infoOf(owner: string | ModuleOwnerInfo | null): ModuleOwnerInfo | null {
    if (owner === null) {
      return null;
    }
    return typeof owner === 'string' ? { name: owner, stamp: null } : owner;
  }
}

/** Vite's evaluator, each inlined module run inside its owner (see {@link PackageEvaluationScope}). */
class ScopedModuleEvaluator implements ModuleEvaluator {
  /** The lines Vite's evaluator prefixes: source locations are read through it. */
  readonly startOffset: number | undefined;

  constructor(
    private readonly ownerOf: ModuleOwner,
    private readonly base: ModuleEvaluator,
  ) {
    this.startOffset = base.startOffset;
  }

  runInlinedModule(context: ModuleRunnerContext, code: string, module: Readonly<EvaluatedModuleNode>): Promise<any> {
    const owner = ScopedModuleEvaluator.ownerOrNull(this.ownerOf, module.file ?? module.id);
    return PackageEvaluationScope.run(owner, () => this.base.runInlinedModule(context, code, module));
  }

  runExternalModule(file: string): Promise<any> {
    return PackageEvaluationScope.run(null, () => this.base.runExternalModule(file));
  }

  private static ownerOrNull(ownerOf: ModuleOwner, file: string | null | undefined): string | ModuleOwnerInfo | null {
    if (!file) {
      return null;
    }
    try {
      return ownerOf(file);
    } catch {
      return null;
    }
  }
}
