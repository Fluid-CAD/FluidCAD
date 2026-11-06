import { describe, it, expect } from 'vitest';
import { detectKind, isFeatureFile, isFluidScriptFile, isParamsFile, newFeatureFileContent, newFileContent, PARAMS_FILE_TEMPLATE } from '../src/file-kind.ts';
import { classifyFile, describeFile } from '../src/files/file-tree.ts';

describe('detectKind', () => {
  const cases: Array<{ input: string; expected: 'part' | 'assembly' | null }> = [
    { input: 'foo.part.js', expected: 'part' },
    { input: 'bar.assembly.js', expected: 'assembly' },
    { input: 'legacy.fluid.js', expected: 'part' },
    { input: '/abs/path/to/widget.part.js', expected: 'part' },
    { input: '/abs/path/to/robot.assembly.js', expected: 'assembly' },
    { input: 'C:\\Users\\me\\proj\\thing.fluid.js', expected: 'part' },
    { input: 'plain.js', expected: null },
    { input: 'project.params.js', expected: null },
    { input: 'init.js', expected: null },
    { input: 'README.md', expected: null },
    { input: 'something.assembly.ts', expected: null },
    { input: '', expected: null },
  ];

  for (const { input, expected } of cases) {
    it(`detectKind(${JSON.stringify(input)}) → ${expected}`, () => {
      expect(detectKind(input)).toBe(expected);
    });
  }
});

describe('newFileContent', () => {
  it('prefills an assembly file with an exported assembly() wrapper', () => {
    expect(newFileContent('gantry.assembly.js')).toBe([
      `import { assembly } from 'fluidcad/core';`,
      ``,
      `export const gantry = assembly('gantry', () => {`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('camel-cases a dashed name into the export and keeps it as the display name', () => {
    const content = newFileContent('parts/gantry-frame.assembly.js');
    expect(content).toContain(`export const gantryFrame = assembly('gantry-frame', () => {`);
  });

  it('falls back when the name is not a usable identifier', () => {
    expect(newFileContent('3d.assembly.js')).toContain(`export const mainAssembly = assembly('3d', () => {`);
    // `assembly` itself would shadow the import.
    expect(newFileContent('assembly.assembly.js')).toContain(`export const mainAssembly = assembly('assembly', () => {`);
  });

  it('prefills a part file with an exported empty part() named after the file', () => {
    expect(newFileContent('bracket.part.js')).toBe([
      `import { part } from 'fluidcad/core';`,
      ``,
      `export const bracket = part('bracket', () => {`,
      `});`,
      ``,
    ].join('\n'));
    expect(newFileContent('parts/base-plate.fluid.js')).toContain(`export const basePlate = part('base-plate', () => {`);
  });

  it('falls back when a part name is not a usable identifier', () => {
    expect(newFileContent('3d.part.js')).toContain(`export const mainPart = part('3d', () => {`);
    // `part` itself would shadow the import.
    expect(newFileContent('part.part.js')).toContain(`export const mainPart = part('part', () => {`);
  });

  it('leaves non-fluid files blank', () => {
    expect(newFileContent('helper.js')).toBe('');
  });

  it('prefills a params file with the param import and nothing else', () => {
    expect(newFileContent('project.params.js')).toBe(`import { param } from 'fluidcad/core';\n\n`);
    expect(newFileContent('/ws/sub/tolerances.params.js')).toBe(PARAMS_FILE_TEMPLATE);
  });

  it('prefills a feature file with a working feature named after the file', () => {
    const content = newFileContent('features/my-boss.feature.js');
    expect(content).toBe(newFeatureFileContent('features/my-boss.feature.js'));
    expect(content).toContain(`import { Feature, defineFeature } from 'fluidcad/sdk';`);
    expect(content).toContain(`export class MyBoss extends Feature.with({`);
    expect(content).toContain(`  static id = 'my-boss';`);
    expect(content).toContain(`  buildTool() {`);
    expect(content).toContain(`export const myBoss = defineFeature(MyBoss, {`);
    expect(content).toContain(`  label: 'My boss',`);
    expect(content).toContain(`  call: ['face', { diameter: 'diameter', height: 'height' }],`);
  });

  it('falls back when a feature name is not a usable identifier or would shadow an import', () => {
    expect(newFeatureFileContent('3d.feature.js')).toContain(`export class MyFeature extends Feature.with({`);
    expect(newFeatureFileContent('3d.feature.js')).toContain(`  static id = '3d';`);
    expect(newFeatureFileContent('3d.feature.js')).toContain(`export const myFeature = defineFeature(MyFeature, {`);
    // `Feature` is the class the template imports; `feature` capitalised would shadow it.
    expect(newFeatureFileContent('feature.feature.js')).toContain(`export class MyFeature extends Feature.with({`);
    expect(newFeatureFileContent('feature.feature.js')).toContain(`  label: 'Feature',`);
  });
});

describe('isFeatureFile', () => {
  it('matches the .feature.js suffix only, and is never a model', () => {
    expect(isFeatureFile('standoff.feature.js')).toBe(true);
    expect(isFeatureFile('/ws/features/standoff.feature.js')).toBe(true);
    expect(isFeatureFile('standoff.part.js')).toBe(false);
    expect(isFeatureFile('feature.js')).toBe(false);
    expect(isFluidScriptFile('standoff.feature.js')).toBe(false);
    expect(detectKind('standoff.feature.js')).toBeNull();
    expect(describeFile('standoff.feature.js')).toEqual({ kind: 'source' });
  });
});

describe('isParamsFile', () => {
  it('matches the .params.js suffix only', () => {
    expect(isParamsFile('project.params.js')).toBe(true);
    expect(isParamsFile('/abs/dir/a.params.js')).toBe(true);
    expect(isParamsFile('a.part.js')).toBe(false);
    expect(isParamsFile('params.js')).toBe(false);
    expect(isParamsFile('a.params.ts')).toBe(false);
  });

  it('is never a model', () => {
    expect(isFluidScriptFile('a.params.js')).toBe(false);
    expect(detectKind('a.params.js')).toBeNull();
  });

  it('lists as a source file flagged params, so the editor opens it like any module', () => {
    expect(classifyFile('project.params.js')).toBe('source');
    expect(describeFile('project.params.js')).toEqual({ kind: 'source', params: true });
    expect(describeFile('helper.js')).toEqual({ kind: 'source' });
    expect(describeFile('a.part.js')).toEqual({ kind: 'model' });
  });
});

describe('isFluidScriptFile', () => {
  it('matches all three suffixes', () => {
    expect(isFluidScriptFile('a.part.js')).toBe(true);
    expect(isFluidScriptFile('a.assembly.js')).toBe(true);
    expect(isFluidScriptFile('a.fluid.js')).toBe(true);
  });

  it('rejects unrelated files', () => {
    expect(isFluidScriptFile('a.js')).toBe(false);
    expect(isFluidScriptFile('a.part.ts')).toBe(false);
  });
});
