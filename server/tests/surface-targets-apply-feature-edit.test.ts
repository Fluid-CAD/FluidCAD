import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  makeProducerBindable,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit/index.ts';

/**
 * `load()` brings surfaces and curves in from a STEP file and `helix()`
 * draws a curve. The tools that move, copy or paint whole shapes name them
 * the way they name a solid's feature: the statement is bound to a variable
 * and passed whole. Only a call that builds something to move qualifies —
 * a sketch is a profile, not a target.
 */
const CODE = [
  `import { load, helix, sketch, circle } from 'fluidcad/core'`,
  ``,
  `load('panel')`,
  `helix('z', { pitch: 2, height: 10, radius: 5 })`,
  `sketch('xy', () => { circle([0, 0], 10) })`,
  ``,
].join('\n');

const LOAD_LINE = 3;
const HELIX_LINE = 4;
const SKETCH_LINE = 5;

function spec(lines: number[], options: Partial<ApplyFeatureEditSpec>): ApplyFeatureEditSpec {
  return {
    feature: 'translate',
    filePath: '/ws/model.fluid.js',
    producers: lines.map(line => ({ line, column: 0, featureType: 'feature', nameHint: 'f', bind: true })),
    parts: [],
    imports: [],
    ...options,
  } as ApplyFeatureEditSpec;
}

const targets = (count: number) => Array.from({ length: count }, (_, producer) => ({ producer }));

describe('applyFeatureEdit — targets holding a surface or a curve', () => {
  it('moves a loaded surface and a helix', async () => {
    const result = await applyFeatureEdit(CODE, spec([LOAD_LINE, HELIX_LINE], {
      feature: 'translate',
      translate: { translation: [0, 0, 5], copy: false, targets: targets(2) },
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(lines).toContain(`const f = load('panel')`);
    expect(lines).toContain(`const f2 = helix('z', { pitch: 2, height: 10, radius: 5 })`);
    expect(result.newCode).toContain(`translate(0, 0, 5, f, f2)`);
  });

  it('turns and mirrors them', async () => {
    const turned = await applyFeatureEdit(CODE, spec([LOAD_LINE, HELIX_LINE], {
      feature: 'rotate',
      rotate: { axis: { kind: 'standard', axis: 'z' }, angle: 90, copy: false, targets: targets(2) },
    }));
    expect(turned.error).toBeUndefined();
    expect(turned.newCode).toContain(`rotate('z', 90, f, f2)`);

    const mirrored = await applyFeatureEdit(CODE, spec([LOAD_LINE, HELIX_LINE], {
      feature: 'mirror',
      mirror: { plane: { kind: 'standard', plane: 'yz' }, op: 'add', targets: targets(2) },
    }));
    expect(mirrored.error).toBeUndefined();
    expect(mirrored.newCode).toContain(`mirror('yz', f, f2)`);
  });

  it('copies a loaded surface', async () => {
    const result = await applyFeatureEdit(CODE, spec([LOAD_LINE], {
      feature: 'copy',
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
        targets: targets(1),
      } as never,
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`copy('linear', 'x', { count: 3, offset: 40 }, f)`);
  });

  it('paints a loaded surface', async () => {
    const result = await applyFeatureEdit(CODE, spec([LOAD_LINE], {
      feature: 'color',
      color: { value: 'red', targets: targets(1) },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`color('red', f)`);
  });

  it('refuses a sketch as a target', async () => {
    const result = await applyFeatureEdit(CODE, spec([SKETCH_LINE], {
      feature: 'translate',
      translate: { translation: [0, 0, 5], copy: false, targets: targets(1) },
    }));
    expect(result.error).toContain('the call at line 5 is sketch()');
  });

  it('probes a load and a helix as bindable targets, a sketch not', async () => {
    const bindable = await makeProducerBindable(CODE);
    expect(bindable({ line: LOAD_LINE, featureType: 'feature' })).toBe(true);
    expect(bindable({ line: HELIX_LINE, featureType: 'feature' })).toBe(true);
    expect(bindable({ line: SKETCH_LINE, featureType: 'feature' })).toBe(false);
  });
});
