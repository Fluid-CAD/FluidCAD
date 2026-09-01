import { describe, it, expect } from 'vitest';
import { detectKind, isFluidScriptFile, newFileContent } from '../src/file-kind.ts';

describe('detectKind', () => {
  const cases: Array<{ input: string; expected: 'part' | 'assembly' | null }> = [
    { input: 'foo.part.js', expected: 'part' },
    { input: 'bar.assembly.js', expected: 'assembly' },
    { input: 'legacy.fluid.js', expected: 'part' },
    { input: '/abs/path/to/widget.part.js', expected: 'part' },
    { input: '/abs/path/to/robot.assembly.js', expected: 'assembly' },
    { input: 'C:\\Users\\me\\proj\\thing.fluid.js', expected: 'part' },
    { input: 'plain.js', expected: null },
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

  it('leaves part files and non-fluid files blank', () => {
    expect(newFileContent('bracket.part.js')).toBe('');
    expect(newFileContent('legacy.fluid.js')).toBe('');
    expect(newFileContent('helper.js')).toBe('');
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
