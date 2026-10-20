import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  makeProducerBindable,
  makeProducerBoundProbe,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit/index.ts';

/**
 * Owner-scoped selectors: when a pick has a coincident twin on another solid,
 * synthesis names the feature owning the pick's solid — often a modifier
 * like fillet() — as `select(edge().from(f)…)`. The selector only passes the
 * variable whole, so the producer travels as the `'feature'` type: any
 * feature-producing call binds, not only those with selector accessors.
 */
const CODE = [
  `import { sketch, ellipse, extrude, fillet, select } from 'fluidcad/core'`,
  `import { edge } from 'fluidcad/filters'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `fillet(5, e.endEdges())`,
  ``,
].join('\n');

function ownerScopeSpec(featureType: string): ApplyFeatureEditSpec {
  return {
    feature: 'fillet',
    value: 2,
    filePath: '/ws/model.fluid.js',
    producers: [{ line: 6, column: 0, featureType, nameHint: 'f', bind: true }],
    parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: 'edge().from({{r0}}).line()', refs: [0] }],
    imports: ['select', 'edge'],
  };
}

describe('applyFeatureEdit — owner-scoped select()', () => {
  it('binds a modifier statement referenced whole through from()', async () => {
    const result = await applyFeatureEdit(CODE, ownerScopeSpec('feature'));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(lines).toContain(`const f = fillet(5, e.endEdges())`);
    expect(lines.some(l => l.startsWith(`fillet(2, select(edge().from(f).line()))`))).toBe(true);
  });

  it('refuses the same statement as an accessor producer', async () => {
    // fillet() has no selector accessors: binding it under its own type is
    // the guard against chaining e.g. `.endEdges()` onto it.
    const result = await applyFeatureEdit(CODE, ownerScopeSpec('fillet'));
    expect(result.error).toMatch(/expected a fillet\(\)-producing call/);
  });

  it('probes a modifier statement as bindable for whole-feature use only', async () => {
    const bindable = await makeProducerBindable(CODE);
    expect(bindable({ line: 6, featureType: 'feature' })).toBe(true);
    expect(bindable({ line: 6, featureType: 'fillet' })).toBe(false);

    const bound = await makeProducerBoundProbe(CODE.replace('fillet(5,', 'const f3 = fillet(5,'));
    expect(bound({ line: 6, featureType: 'feature' })).toBe(true);
  });
});
