// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The "declare as param()" toggle is a session setting shared by every
// expression input: on by default, flipped in one input, honoured by the
// next — the sketcher's floating input and a dialog field alike.

import { ParamDeclareMode } from '../src/ui/expression-core';
import { ExpressionInput } from '../src/ui/expression-input';
import { ExpressionField } from '../src/ui/expression-field';

function mountInput() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const input = new ExpressionInput(container);
  const button = container.querySelector<HTMLButtonElement>('.expression-param-btn')!;
  const commits: { expression: string; newVariable?: { name: string; initializer: string } }[] = [];
  const open = () => input.show({
    label: 'L', value: '25', clientX: 0, clientY: 0, variables: [],
    onCommit: (result) => { commits.push(result); },
  });
  const type = (text: string) => {
    const el = container.querySelector<HTMLInputElement>('input')!;
    el.value = text;
    el.dispatchEvent(new Event('input'));
    return el;
  };
  const enter = () => {
    const el = container.querySelector<HTMLInputElement>('input')!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  };
  return { open, type, enter, button, commits };
}

function mountField() {
  const el = document.createElement('input');
  el.value = '25';
  document.body.appendChild(el);
  const field = new ExpressionField(el);
  const button = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'P')!;
  return { field, el, button };
}

beforeEach(() => {
  ParamDeclareMode.set(true);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the declare-as-param toggle', () => {
  it('is on by default, so naming a value declares a param()', () => {
    const { open, type, enter, button, commits } = mountInput();
    open();
    type('wall = 3');
    expect(button.classList.contains('hidden')).toBe(false);
    expect(button.classList.contains('text-primary')).toBe(true);
    enter();
    expect(commits).toEqual([
      { expression: 'wall', newVariable: { name: 'wall', initializer: 'param("wall", 3)' } },
    ]);
  });

  it('remembers a flip for the next input of the session, across hosts', () => {
    const { open, type, enter, button, commits } = mountInput();
    open();
    type('wall = 3');
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ParamDeclareMode.enabled).toBe(false);
    enter();
    expect(commits[0].newVariable).toEqual({ name: 'wall', initializer: '3' });

    // A dialog field opened afterwards reads the same setting.
    const { field, el } = mountField();
    el.value = 'depth = 40';
    el.dispatchEvent(new Event('input'));
    expect(field.read()).toEqual({ value: 'depth', newVariable: { name: 'depth', initializer: '40' } });

    // And re-opening the sketcher input keeps it off — no per-open reset.
    open();
    type('lip = 2');
    expect(button.classList.contains('text-primary')).toBe(false);
    enter();
    expect(commits[1].newVariable).toEqual({ name: 'lip', initializer: '2' });
  });

  it('never declares a prefilled source expression read back unchanged from a dialog field', () => {
    const { field, el } = mountField();
    // Edit-mode prefill: the statement already reads `wall`, whether or not
    // the scope read has landed with it.
    field.setValue('wall');
    expect(field.read()).toEqual({ value: 'wall' });
    el.value = 'wall / 2';
    el.dispatchEvent(new Event('input'));
    expect(field.read()).toEqual({ value: 'wall / 2' });
  });

  it('flips back on from a dialog field and the sketcher input follows', () => {
    ParamDeclareMode.set(false);
    const { field, el, button } = mountField();
    el.value = 'depth = 40';
    el.dispatchEvent(new Event('input'));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(field.read()).toEqual({
      value: 'depth', newVariable: { name: 'depth', initializer: 'param("depth", 40)' },
    });

    const { open, type, enter, commits } = mountInput();
    open();
    type('lip');
    enter();
    expect(commits[0].newVariable).toEqual({ name: 'lip', initializer: 'param("lip", 25)' });
  });
});
