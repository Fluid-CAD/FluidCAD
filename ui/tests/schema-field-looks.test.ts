// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FeaturePickerParam, FeatureScalarParam } from '../src/api';
import { SchemaField } from '../src/interactive/create-feature/schema/schema-fields';
import { SchemaPicker } from '../src/interactive/create-feature/schema/schema-pickers';

// How a typed-in row looks beside its value: a slider, a stepper, a suffix,
// a checkbox, a text's lines and limits, a hint. None of it is the value:
// each row seeds without becoming the user's, and reads what it shows.

afterEach(() => {
  document.body.innerHTML = '';
});

function field(spec: FeatureScalarParam, seed?: number | string | boolean) {
  const row = SchemaField.create('v', spec);
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
