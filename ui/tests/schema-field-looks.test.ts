// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FeaturePickerParam, FeatureScalarParam } from '../src/api';
import { SchemaField } from '../src/interactive/create-feature/schema/schema-fields';
import { SchemaPicker } from '../src/interactive/create-feature/schema/schema-pickers';

// How a typed-in row looks beside its value: a slider, a stepper, a suffix,
// a checkbox, a text's lines and limits, a hint. None of it is the value:
// each row seeds without becoming the user's, and reads what it shows.

/** Every row a test builds — destroyed afterwards, so a popover left open keeps no document listener. */
const rows: SchemaField[] = [];

afterEach(() => {
  for (const row of rows.splice(0)) {
    row.destroy();
  }
  document.body.innerHTML = '';
});

function field(spec: FeatureScalarParam, seed?: number | string | boolean | (string | number)[]) {
  const row = SchemaField.create('v', spec);
  rows.push(row);
  document.body.append(row.row);
  let changes = 0;
  let submits = 0;
  row.onChange = () => changes++;
  row.onSubmit = () => submits++;
  row.seed(seed);
  const q = <T extends HTMLElement>(role: string) => row.row.querySelector<T>(`[data-role="${role}"]`)!;
  const type = (text: string) => {
    q<HTMLInputElement>('value-v').value = text;
    q('value-v').dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { row, q, type, changes: () => changes, submits: () => submits };
}

describe('a slider', () => {
  const DEPTH: FeatureScalarParam = { type: 'length', label: 'Depth', default: 10, min: 1, max: 50, display: 'slider', suffix: 'mm' };

  it('seeds the thumb with the input, without the row becoming the user\'s', () => {
    const { row, q } = field(DEPTH, 10);
    const track = q<HTMLInputElement>('track-v');
    expect(track.className).toContain('range range-xs range-primary');
    expect([track.min, track.max, track.step]).toEqual(['1', '50', '0.5']);
    expect(track.value).toBe('10');
    expect(track.dataset.unset).toBe('false');
    expect(row.dirty).toBe(false);
    expect(row.read()).toEqual({ value: 10 });
    expect(q('suffix-v').textContent).toBe('mm');
  });

  it('writes a drag into the input and dirties the row', () => {
    const { row, q, changes } = field(DEPTH, 10);
    q<HTMLInputElement>('track-v').value = '24';
    q('track-v').dispatchEvent(new Event('input'));
    expect(q<HTMLInputElement>('value-v').value).toBe('24');
    expect(row.read()).toEqual({ value: 24 });
    expect(row.dirty).toBe(true);
    expect(changes()).toBe(1);
  });

  it('follows a typed number, clamped, and claims no value over an expression', () => {
    const { row, q, type } = field(DEPTH, 10);
    type('30');
    expect(q<HTMLInputElement>('track-v').value).toBe('30');
    type('80');
    expect(q<HTMLInputElement>('track-v').value).toBe('50');
    expect(row.read()).toEqual({ error: expect.stringContaining('50') });
    type('gap * 2');
    expect(q('track-v').dataset.unset).toBe('true');
    expect(q('track-v').classList.contains('opacity-40')).toBe(true);
    expect(row.read()).toEqual({ value: 'gap * 2' });
    row.seed('gap');
    expect(q('track-v').dataset.unset).toBe('true');
    expect(row.dirty).toBe(false);
  });

  it('steps an integer by 1 and the rest by a hundredth of the range, unless a step is declared', () => {
    expect(field({ type: 'integer', label: 'N', min: 0, max: 40, display: 'slider' }).q<HTMLInputElement>('track-v').step).toBe('1');
    expect(field({ type: 'number', label: 'N', min: 0, max: 2, display: 'slider' }).q<HTMLInputElement>('track-v').step).toBe('0.02');
    expect(field({ type: 'angle', label: 'N', min: 0, max: 360, step: 15, display: 'slider' }).q<HTMLInputElement>('track-v').step).toBe('15');
  });
});

describe('a stepper', () => {
  const COUNT: FeatureScalarParam = { type: 'integer', label: 'Count', min: 1, max: 4, display: 'stepper' };

  it('steps the number shown, clamped to its range, and dirties the row', () => {
    const { row, q, changes } = field(COUNT, 3);
    expect(row.dirty).toBe(false);
    q('increment-v').click();
    expect(row.read()).toEqual({ value: 4 });
    expect(row.dirty).toBe(true);
    q('increment-v').click();
    expect(row.read()).toEqual({ value: 4 });
    for (let i = 0; i < 5; i++) {
      q('decrement-v').click();
    }
    expect(row.read()).toEqual({ value: 1 });
    expect(changes()).toBe(7);
  });

  it('keeps the number between its buttons whole: centred, its box as wide as the widest number of the range', () => {
    const input = (spec: FeatureScalarParam) => field(spec).q('value-v') as HTMLInputElement;
    const box = (spec: FeatureScalarParam) => input(spec).parentElement!;
    expect(input(COUNT).className).toContain('text-center');
    expect(box(COUNT).style.minWidth).toBe('calc(3ch + 0.875rem)');
    expect(box({ type: 'integer', label: 'Teeth', default: 24, min: 4, max: 1000, display: 'stepper' }).style.minWidth).toBe('calc(4ch + 0.875rem)');
    expect(box({ type: 'number', label: 'Gap', default: 2.125, step: 0.1, display: 'stepper' }).style.minWidth).toBe('calc(5ch + 0.875rem)');
    // A plain input has no floor of its own.
    expect(box({ type: 'integer', label: 'Plain', default: 24 }).style.minWidth).toBe('');
  });

  it('steps by the declared step, starts an empty row at its default, and stands still over an expression', () => {
    const { row, q, type } = field({ type: 'number', label: 'Gap', default: 2, step: 0.1, display: 'stepper' });
    expect(row.read()).toEqual({ empty: true });
    q('increment-v').click();
    expect(row.read()).toEqual({ value: 2.1 });
    q('increment-v').click();
    expect(row.read()).toEqual({ value: 2.2 });
    type('gap + 1');
    expect(q<HTMLButtonElement>('increment-v').disabled).toBe(true);
    expect(q<HTMLButtonElement>('decrement-v').disabled).toBe(true);
    type('5');
    expect(q<HTMLButtonElement>('increment-v').disabled).toBe(false);
  });
});

describe('a suffix, a checkbox and a hint', () => {
  it('shows a suffix in place of an angle\'s unit, and keeps the unit without one', () => {
    expect(field({ type: 'angle', label: 'Turn' }).row.row.querySelector('span')!.textContent).toBe('Turn (°)');
    const turns = field({ type: 'angle', label: 'Turn', suffix: 'deg' });
    expect(turns.row.row.querySelector('span')!.textContent).toBe('Turn');
    expect(turns.q('suffix-v').textContent).toBe('deg');
  });

  it('draws a boolean as a checkbox that seeds, reads and dirties as the toggle does', () => {
    expect(field({ type: 'boolean', label: 'Flush' }).q('value-v').className).toContain('toggle');
    const { row, q, changes } = field({ type: 'boolean', label: 'Flush', display: 'checkbox' }, true);
    expect(q('value-v').className).toBe('checkbox checkbox-sm checkbox-primary');
    expect(row.read()).toEqual({ value: true });
    expect(row.dirty).toBe(false);
    q('value-v').click();
    expect(row.read()).toEqual({ value: false });
    expect(row.dirty).toBe(true);
    expect(changes()).toBe(1);
  });

  it('puts a hint under a typed-in row and under a picker, and none where none is declared', () => {
    const hinted = field({ type: 'length', label: 'Depth', hint: 'Measured from the surface', description: 'How deep' });
    const hint = hinted.q('hint');
    expect(hint.textContent).toBe('Measured from the surface');
    expect(hint.className).toContain('text-[11px] text-base-content/50');
    expect(hinted.row.row.lastElementChild).toBe(hint);
    expect(hinted.row.row.title).toBe('How deep');
    expect(field({ type: 'boolean', label: 'Flush', hint: 'Level with the face' }).q('hint').textContent).toBe('Level with the face');
    expect(field({ type: 'length', label: 'Depth' }).row.row.querySelector('[data-role="hint"]')).toBeNull();
    const picker = new SchemaPicker('at', { picker: 'face', label: 'At', hint: 'The face it stands on' } as FeaturePickerParam);
    expect(picker.row.querySelector('[data-role="hint"]')!.textContent).toBe('The face it stands on');
    expect(new SchemaPicker('at', { picker: 'face', label: 'At' } as FeaturePickerParam).row.querySelector('[data-role="hint"]')).toBeNull();
  });
});

describe('a text\'s lines and limits', () => {
  const key = (el: HTMLElement, init: KeyboardEventInit) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));

  it('is a textarea when multiline: Enter is a new line, Ctrl or Cmd+Enter submits', () => {
    const { row, q, submits } = field({ type: 'text', label: 'Note', multiline: true, placeholder: 'A note' }, 'a\nb');
    const area = q<HTMLTextAreaElement>('value-v');
    expect(area.tagName).toBe('TEXTAREA');
    expect(area.className).toBe('textarea textarea-sm textarea-bordered w-full text-xs');
    expect(area.placeholder).toBe('A note');
    expect(row.read()).toEqual({ value: 'a\nb' });
    expect(row.dirty).toBe(false);
    expect(key(area, {})).toBe(true);
    expect(submits()).toBe(0);
    key(area, { ctrlKey: true });
    key(area, { metaKey: true });
    expect(submits()).toBe(2);
  });

  it('stays an input on one line, where Enter submits', () => {
    const { q, submits } = field({ type: 'text', label: 'Note', placeholder: 'A2-70' });
    expect(q('value-v').tagName).toBe('INPUT');
    expect(q<HTMLInputElement>('value-v').placeholder).toBe('A2-70');
    key(q('value-v'), {});
    expect(submits()).toBe(1);
  });

  it('reads a text over its maxLength or off its pattern as an error in the label\'s voice', () => {
    const { row, type } = field({ type: 'text', label: 'Marking', maxLength: 5, pattern: '[A-Z0-9-]*' });
    expect(row.read()).toEqual({ empty: true });
    type('A2-70');
    expect(row.read()).toEqual({ value: 'A2-70' });
    expect(row.dirty).toBe(true);
    type('A2-700');
    expect(row.read()).toEqual({ error: 'Marking is at most 5 characters.' });
    type('a2');
    expect(row.read()).toEqual({ error: 'Marking must match [A-Z0-9-]*.' });
    // The whole value is matched, not a part of it.
    type('A b');
    expect(row.read()).toEqual({ error: 'Marking must match [A-Z0-9-]*.' });
  });
});

describe('a select of several', () => {
  const OPTIONS = [{ label: 'Deburr', value: 'deburr' }, { label: 'Chamfer', value: 'chamfer' }, { label: 'Polish', value: 'polish' }, { label: 'Anodise', value: 'anodise' }];
  const FINISHES: FeatureScalarParam = { type: 'select', multiple: true, label: 'Finishes', options: OPTIONS, default: ['deburr'] };
  const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
  const popup = () => document.body.querySelector<HTMLElement>('[role="listbox"]');

  it('is the button and its popover even over plain options, seeded without becoming the user\'s', () => {
    const { row, q } = field(FINISHES, ['deburr']);
    expect(q('value-v').tagName).toBe('BUTTON');
    expect(q('value-v').textContent).toBe('Deburr');
    expect(row.row.textContent).toContain('Finishes');
    expect(row.dirty).toBe(false);
    expect(row.read()).toEqual({ value: ['deburr'] });

    q('value-v').click();
    expect(popup()!.getAttribute('aria-multiselectable')).toBe('true');
    expect(options().map(o => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    // Four plain options: a list, with the search box a parameter's name is typed in.
    expect(popup()!.parentElement!.querySelector('input[type="search"]')).not.toBeNull();
    expect(popup()!.parentElement!.dataset.mode).toBe('list');
  });

  it('feeds no visibleWhen: its current value is undefined whatever it holds', () => {
    expect(field(FINISHES, ['deburr', 'polish']).row.current()).toBeUndefined();
    expect(field(FINISHES, []).row.current()).toBeUndefined();
  });

  it('a toggle keeps the popover open, updates the trigger and dirties the row; the list keeps the options\' order', () => {
    const { row, q, changes } = field(FINISHES, ['deburr']);
    q('value-v').click();
    options()[2].click();
    expect(q('value-v').textContent).toBe('Deburr, Polish');
    expect(popup()).not.toBeNull();
    expect(row.dirty).toBe(true);
    expect(changes()).toBe(1);

    options()[0].click();
    options()[1].click();
    expect(q('value-v').textContent).toBe('Chamfer, Polish');
    options()[0].click();
    expect(row.read()).toEqual({ value: ['deburr', 'chamfer', 'polish'] });
    expect(q('value-v').textContent).toBe('3 selected');
    expect(changes()).toBe(4);
    expect(popup()).not.toBeNull();
  });

  it('reads an empty list, never a value left out, and shows "None"', () => {
    const { row, q } = field(FINISHES, ['deburr']);
    q('value-v').click();
    options()[0].click();
    expect(q('value-v').textContent).toBe('None');
    expect(row.read()).toEqual({ value: [] });

    // No list to seed, or values no option carries: nothing chosen.
    const bare = field(FINISHES);
    expect(bare.q('value-v').textContent).toBe('None');
    expect(bare.row.read()).toEqual({ value: [] });
    expect(field(FINISHES, ['knurl']).row.read()).toEqual({ value: [] });
    expect(field(FINISHES, 'deburr').row.read()).toEqual({ value: [] });
  });

  it('holds the list to min and max, saying which', () => {
    const bounded: FeatureScalarParam = { ...FINISHES, min: 1, max: 2 } as FeatureScalarParam;
    const { row, q } = field(bounded, ['deburr']);
    expect(row.read()).toEqual({ value: ['deburr'] });
    q('value-v').click();
    options()[0].click();
    expect(row.read()).toEqual({ error: 'Finishes takes at least 1.' });
    options()[0].click();
    options()[1].click();
    expect(row.read()).toEqual({ value: ['deburr', 'chamfer'] });
    options()[3].click();
    expect(row.read()).toEqual({ error: 'Finishes takes at most 2.' });
  });

  it('a seed over the user\'s list is the row\'s own again, and closes the popover', () => {
    const { row, q } = field(FINISHES, ['deburr']);
    q('value-v').click();
    options()[1].click();
    expect(row.dirty).toBe(true);

    row.seed(['polish', 'anodise', 'chamfer']);
    expect(row.dirty).toBe(false);
    expect(popup()).toBeNull();
    expect(q('value-v').textContent).toBe('3 selected');
    expect(row.read()).toEqual({ value: ['chamfer', 'polish', 'anodise'] });
  });

  it('honours a grid and its columns, and drops the search box only when told to', () => {
    const grid = field({ ...FINISHES, display: 'grid', columns: 2 } as FeatureScalarParam, []);
    grid.q('value-v').click();
    expect(popup()!.parentElement!.dataset.mode).toBe('grid');
    expect(popup()!.parentElement!.dataset.columns).toBe('2');
    grid.row.dismiss();
    expect(popup()).toBeNull();

    const many = Array.from({ length: 13 }, (_, i) => ({ label: `Step ${i}`, value: i }));
    const searched = field({ type: 'select', multiple: true, label: 'Steps', options: many, default: [] }, []);
    searched.q('value-v').click();
    expect(popup()!.parentElement!.querySelector('input[type="search"]')).not.toBeNull();
    options()[4].click();
    options()[1].click();
    expect(searched.row.read()).toEqual({ value: [1, 4] });
    searched.row.setVisible(false);
    expect(popup()).toBeNull();

    const unsearched = field({ type: 'select', multiple: true, label: 'Steps', options: many, default: [], search: false }, []);
    unsearched.q('value-v').click();
    expect(popup()!.parentElement!.querySelector('input')).toBeNull();
    unsearched.row.destroy();
    expect(popup()).toBeNull();
  });

  it('carries a hint under the row, as any value does', () => {
    const { q } = field({ ...FINISHES, hint: 'Applied in this order.' } as FeatureScalarParam, []);
    expect(q('hint').textContent).toBe('Applied in this order.');
  });
});
