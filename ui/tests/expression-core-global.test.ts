import { describe, expect, it } from 'vitest';
import {
  filterSuggestions, resolveExpressionValue, suggestionItemHtml, suggestionKind, suggestionValueHint,
  type VariableInfo,
} from '../src/ui/expression-core';

// Project parameters in the expression dropdown: the server appends them to
// a file's variables with `global` set and the literal as `initializer`, so
// they get the G chip, show `value unit`, and evaluate in previews like any
// other variable.

const WALL: VariableInfo = {
  name: 'wall', initializer: '3',
  global: { file: 'project.params.js', label: 'Wall thickness', unit: 'mm', imported: false },
};
const ALIASED: VariableInfo = {
  name: 'w', initializer: '3',
  global: { file: 'project.params.js', label: 'Wall thickness', unit: 'mm', imported: true, alias: 'w' },
};
const FINISH: VariableInfo = {
  name: 'finish', initializer: "'matte'", numeric: false,
  global: { file: 'project.params.js', label: 'Finish', imported: false },
};
const COUNT: VariableInfo = {
  name: 'holes', initializer: '4',
  global: { file: 'project.params.js', label: 'Hole count', imported: false },
};
const LOCAL: VariableInfo = { name: 'height', initializer: '30' };

describe('expression-core — project parameters', () => {
  it('kinds a global as global whatever its initializer looks like', () => {
    expect(suggestionKind(WALL, false)).toBe('global');
    expect(suggestionKind(ALIASED, true)).toBe('global');
    expect(suggestionKind(LOCAL, false)).toBe('variable');
    // The new-variable offer is never a global.
    expect(suggestionKind({ name: 'wall', initializer: '3', isNew: true }, true)).toBe('param');
  });

  it('hints a numeric global with its value in the project unit', () => {
    expect(suggestionValueHint(WALL)).toBe('3 mm');
    expect(suggestionValueHint(ALIASED)).toBe('3 mm');
    // No unit sent (a count, an angle): the bare value.
    expect(suggestionValueHint(COUNT)).toBe('4');
    // Not a number: nothing to hint.
    expect(suggestionValueHint(FINISH)).toBeNull();
    expect(suggestionValueHint(LOCAL)).toBeNull();
  });

  it('draws the G chip, the label and the hint on the row', () => {
    const html = suggestionItemHtml(WALL, 0, false, true);
    expect(html).toContain('>G</span>');
    expect(html).toContain('Project parameter');
    expect(html).toContain('>wall</span>');
    expect(html).toContain('Wall thickness');
    expect(html).toContain('>3 mm</span>');
    // A local row is untouched: no label, no hint, its own chip.
    const local = suggestionItemHtml(LOCAL, 0, false, true);
    expect(local).toContain('>V</span>');
    expect(local).not.toContain('ml-auto');
  });

  it('offers globals alongside the file\'s variables, and under their alias', () => {
    const names = filterSuggestions('w', [LOCAL, WALL, ALIASED], 'w', '').map((s) => s.name);
    expect(names).toEqual(['w', 'wall']);
    // A text global is hidden like any non-numeric variable.
    expect(filterSuggestions('fin', [FINISH], 'fin', '').map((s) => s.name)).toEqual([]);
  });

  it('evaluates a preview through the global\'s literal', () => {
    expect(resolveExpressionValue('wall * 2 + height', [LOCAL, WALL])).toBe(36);
    expect(resolveExpressionValue('w / 2', [ALIASED])).toBe(1.5);
  });
});
