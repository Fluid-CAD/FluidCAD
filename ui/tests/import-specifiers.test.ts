import { describe, it, expect } from 'vitest';
import { replaceSpecifiers } from '../src/editor/import-specifiers';

describe('replaceSpecifiers', () => {
  it('swaps quoted module paths and leaves everything else', () => {
    const text = [
      "import { a } from './bracket.part.js';",
      'export * from "./bracket.part.js";',
      "const s = './bracket.part.js/notreally';",
      "// typed meanwhile",
    ].join('\n');
    expect(replaceSpecifiers(text, [{ from: './bracket.part.js', to: './arm.part.js' }])).toBe([
      "import { a } from './arm.part.js';",
      'export * from "./arm.part.js";',
      "const s = './bracket.part.js/notreally';",
      "// typed meanwhile",
    ].join('\n'));
  });

  it('is a no-op without replacements', () => {
    expect(replaceSpecifiers('x', [])).toBe('x');
  });
});
