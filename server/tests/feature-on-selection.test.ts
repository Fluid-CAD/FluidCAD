import { describe, it, expect } from 'vitest';
import { FeatureOnSelection } from '../src/feature-on-selection.ts';

describe('FeatureOnSelection.baseNameFor', () => {
  it('maps feature families to readable bases', () => {
    expect(FeatureOnSelection.baseNameFor('extrude-by-distance')).toBe('e');
    expect(FeatureOnSelection.baseNameFor('extrude-symmetric')).toBe('e');
    expect(FeatureOnSelection.baseNameFor('cut')).toBe('c');
    expect(FeatureOnSelection.baseNameFor('revolve')).toBe('rev');
    expect(FeatureOnSelection.baseNameFor('sweep')).toBe('sw');
    expect(FeatureOnSelection.baseNameFor('mystery-op')).toBe('m');
  });
});

describe('FeatureOnSelection.buildFeatureEdit', () => {
  it('binds an anonymous extrude and appends a fillet on an end edge', async () => {
    const code = [
      `import { sketch, extrude } from 'fluidcad/core';`,
      `sketch(XY, () => { circle(50) })`,
      `extrude(10)`,
      ``,
    ].join('\n');

    const result = await FeatureOnSelection.buildFeatureEdit(code, {
      producerLine: 3,
      featureType: 'extrude-by-distance',
      accessor: 'endEdges',
      index: 0,
      feature: 'fillet',
      amount: 5,
    });

    expect(result.variableName).toBe('e');
    expect(result.selector).toBe('e.endEdges(0)');
    expect(result.newCode).toBe([
      `import {fillet, sketch, extrude } from 'fluidcad/core';`,
      `sketch(XY, () => { circle(50) })`,
      `const e = extrude(10)`,
      `fillet(5, e.endEdges(0))`,
      ``,
    ].join('\n'));
  });

  it('reuses an existing binding', async () => {
    const code = [
      `import { extrude, chamfer } from 'fluidcad/core';`,
      `const body = extrude(10)`,
      ``,
    ].join('\n');

    const result = await FeatureOnSelection.buildFeatureEdit(code, {
      producerLine: 2,
      featureType: 'extrude-by-distance',
      accessor: 'sideEdges',
      index: 2,
      feature: 'chamfer',
      amount: 1.5,
    });

    expect(result.selector).toBe('body.sideEdges(2)');
    expect(result.newCode).toContain('chamfer(1.5, body.sideEdges(2))');
  });
});
