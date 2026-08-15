import { describe, it, expect } from 'vitest';
import { detectKind, isFluidScriptFile } from '../src/file-kind.ts';

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
