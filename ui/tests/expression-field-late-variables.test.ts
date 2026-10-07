// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExpressionField } from '../src/ui/expression-field';
import type { VariableInfo } from '../src/ui/expression-core';

// A dialog's scope read often lands after the user has started typing: it
// queues behind the recompute a parameter edit just triggered. The field
// must refilter with the list when it arrives rather than offer nothing
// until the next keystroke.

const VARS: VariableInfo[] = [{ name: 'width', initializer: 'param("width", 40)' }];

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  document.body.innerHTML = '';
});

function mountField(value = '25') {
  const el = document.createElement('input');
  el.value = value;
  document.body.appendChild(el);
  const field = new ExpressionField(el);
  const type = (text: string) => {
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // The rows of an open dropdown — a closed one keeps its last markup hidden.
  const rows = () => Array.from(document.body.querySelectorAll('[data-idx]'))
    .filter((r) => !r.parentElement?.classList.contains('hidden'))
    .map((r) => r.textContent ?? '');
  return { field, el, type, rows };
}

describe('ExpressionField late variable list', () => {
  it('refilters the dropdown for a name typed before the variables arrived', () => {
    const { field, type, rows } = mountField();
    type('wi');
    expect(rows().some((r) => r.includes('width'))).toBe(false);

    field.setVariables(VARS);

    expect(rows().some((r) => r.includes('width'))).toBe(true);
  });

  it('leaves a field alone that was focused but not typed into', () => {
    const { field, el, rows } = mountField();
    field.setValue('width');
    el.focus();

    field.setVariables(VARS);

    expect(rows()).toHaveLength(0);
  });

  it('leaves an unfocused field alone', () => {
    const { field, el, type, rows } = mountField();
    type('wi');
    el.blur();

    field.setVariables(VARS);

    expect(rows()).toHaveLength(0);
  });
});
