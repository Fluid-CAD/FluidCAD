import { describe, it, expect, afterEach } from 'vitest';
import type { EvaluatedModuleNode, ModuleEvaluator, ModuleRunnerContext } from 'vite/module-runner';
import { PackageEvaluationScope } from '../src/host/package-evaluation-scope.ts';
import { FeatureNamespaces } from '../../lib/dist/sdk/feature-namespaces.js';

/**
 * How the scene host tells `FeatureNamespaces` which package's module is
 * evaluating (HD29), without reading a stack: its module runner's
 * evaluator holds each inlined module's owner in an async context around
 * the module's code. A fake base evaluator stands in for Vite's: its
 * "modules" are functions that record the owner they see, await, and
 * evaluate nested modules the way an import does.
 */

type FakeModule = (ctx: { evaluate: (file: string) => Promise<void> }) => Promise<void> | void;

class FakeEvaluator implements ModuleEvaluator {
  readonly startOffset = 3;
  readonly modules = new Map<string, FakeModule>();
  externals: string[] = [];
  outer: ModuleEvaluator | null = null;

  async runInlinedModule(_context: ModuleRunnerContext, code: string): Promise<any> {
    await this.modules.get(code)!({ evaluate: (file) => this.outer!.runInlinedModule({} as ModuleRunnerContext, file, FakeEvaluator.node(file)) });
  }

  async runExternalModule(file: string): Promise<any> {
    this.externals.push(`${file}:${PackageEvaluationScope.current()}`);
    return {};
  }

  static node(file: string): EvaluatedModuleNode {
    return { id: file, file, url: file } as unknown as EvaluatedModuleNode;
  }
}

const OWNERS: Record<string, string> = {
  '/library/@acme/kit/0.1.0/features/standoff.feature.js': '@acme/kit',
  '/library/@acme/kit/0.1.0/features/helpers/probe.js': '@acme/kit',
  '/library/@bea-tools/kit/0.1.0/index.js': '@bea-tools/kit',
};

function scoped(base: FakeEvaluator): ModuleEvaluator {
  const evaluator = PackageEvaluationScope.evaluator((file) => OWNERS[file] ?? null, base);
  base.outer = evaluator;
  return evaluator;
}

afterEach(() => {
  FeatureNamespaces.use(null);
});

describe('PackageEvaluationScope', () => {
  it('holds each module\'s owner while its code runs: a package file\'s package, null for a workspace file', async () => {
    const base = new FakeEvaluator();
    const seen: string[] = [];
    base.modules.set('/ws/model.part.js', async ({ evaluate }) => {
      seen.push(`model:${PackageEvaluationScope.current()}`);
      await evaluate('/library/@acme/kit/0.1.0/features/standoff.feature.js');
      seen.push(`model after import:${PackageEvaluationScope.current()}`);
      await evaluate('/library/@bea-tools/kit/0.1.0/index.js');
      seen.push(`model after second import:${PackageEvaluationScope.current()}`);
    });
    base.modules.set('/library/@acme/kit/0.1.0/features/standoff.feature.js', async ({ evaluate }) => {
      seen.push(`standoff:${PackageEvaluationScope.current()}`);
      // A helper beside it, imported: a package file too.
      await evaluate('/library/@acme/kit/0.1.0/features/helpers/probe.js');
      // A top-level await: the context survives it.
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(`standoff after await:${PackageEvaluationScope.current()}`);
    });
    base.modules.set('/library/@acme/kit/0.1.0/features/helpers/probe.js', () => {
      seen.push(`probe:${PackageEvaluationScope.current()}`);
    });
    base.modules.set('/library/@bea-tools/kit/0.1.0/index.js', () => {
      seen.push(`bea:${PackageEvaluationScope.current()}`);
    });

    await scoped(base).runInlinedModule({} as ModuleRunnerContext, '/ws/model.part.js', FakeEvaluator.node('/ws/model.part.js'));

    expect(seen).toEqual([
      'model:null',
      'standoff:@acme/kit',
      'probe:@acme/kit',
      'standoff after await:@acme/kit',
      'model after import:null',
      'bea:@bea-tools/kit',
      'model after second import:null',
    ]);
    expect(PackageEvaluationScope.current()).toBeNull();
  });

  it('keeps concurrent evaluations apart', async () => {
    const base = new FakeEvaluator();
    const seen: string[] = [];
    const slow = (label: string): FakeModule => async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      seen.push(`${label}:${PackageEvaluationScope.current()}`);
    };
    base.modules.set('/library/@acme/kit/0.1.0/features/standoff.feature.js', slow('acme'));
    base.modules.set('/library/@bea-tools/kit/0.1.0/index.js', slow('bea'));
    base.modules.set('/ws/other.js', slow('workspace'));
    const evaluator = scoped(base);
    await Promise.all(Object.keys(OWNERS).filter((f) => !f.includes('helpers')).concat('/ws/other.js')
      .map((file) => evaluator.runInlinedModule({} as ModuleRunnerContext, file, FakeEvaluator.node(file))));
    expect(seen.sort()).toEqual(['acme:@acme/kit', 'bea:@bea-tools/kit', 'workspace:null']);
  });

  it('evaluates modules it leaves to Node with no owner, and keeps the base evaluator\'s line offset', async () => {
    const base = new FakeEvaluator();
    base.modules.set('/library/@acme/kit/0.1.0/features/standoff.feature.js', async () => {
      await evaluator.runExternalModule('fluidcad/sdk');
    });
    const evaluator = scoped(base);
    expect(evaluator.startOffset).toBe(3);
    await evaluator.runInlinedModule({} as ModuleRunnerContext, '/library/@acme/kit/0.1.0/features/standoff.feature.js',
      FakeEvaluator.node('/library/@acme/kit/0.1.0/features/standoff.feature.js'));
    expect(base.externals).toEqual(['fluidcad/sdk:null']);
  });

  it('reads an owner lookup that throws, or a module with no file, as no package', async () => {
    const base = new FakeEvaluator();
    let seen: string | null = 'unset';
    base.modules.set('x', () => {
      seen = PackageEvaluationScope.current();
    });
    const evaluator = PackageEvaluationScope.evaluator(() => {
      throw new Error('no roots');
    }, base);
    await evaluator.runInlinedModule({} as ModuleRunnerContext, 'x', FakeEvaluator.node('/ws/x.js'));
    expect(seen).toBeNull();
    await PackageEvaluationScope.evaluator(() => '@acme/kit', base).runInlinedModule({} as ModuleRunnerContext, 'x', { id: '', file: null } as unknown as EvaluatedModuleNode);
    expect(seen).toBeNull();
  });

  it('is the source FeatureNamespaces reads, once installed', () => {
    PackageEvaluationScope.install();
    const Owned = class {};
    PackageEvaluationScope.run('@acme/kit', () => FeatureNamespaces.claim(Owned));
    expect(FeatureNamespaces.keyOf(Owned, 'standoff')).toBe('@acme/kit:standoff');
    const Plain = class {};
    FeatureNamespaces.claim(Plain);
    expect(FeatureNamespaces.keyOf(Plain, 'standoff')).toBe('standoff');
  });
});
