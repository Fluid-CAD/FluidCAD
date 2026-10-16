// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The "declare as param()" toggle is a session setting shared by every
// expression input: on by default, flipped in one input, honoured by the
// next — the sketcher's floating input and a dialog field alike.

import { ParamDeclareMode, VariableInfo } from '../src/ui/expression-core';
import { ExpressionInput } from '../src/ui/expression-input';
import { ExpressionField } from '../src/ui/expression-field';

function mountInput() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const input = new ExpressionInput(container);
  const button = container.querySelector<HTMLButtonElement>('.expression-param-btn')!;
  const commits: { expression: string; newVariable?: { name: string; initializer: string } }[] = [];
  const open = (variables: VariableInfo[] = []) => input.show({
    label: 'L', value: '25', clientX: 0, clientY: 0, variables,
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
  return { open, type, enter, button, commits, container };
}

function mountField() {
  const el = document.createElement('input');
  el.value = '25';
  document.body.appendChild(el);
  const field = new ExpressionField(el);
  const button = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'P')!;
  return { field, el, button };
}

// jsdom does not implement scrollIntoView; the dropdown calls it when a
// suggestion is highlighted.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  ParamDeclareMode.set(true);
});

/** The kind-chip letter of every open dropdown row under `root`. */
function chips(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('[data-idx]'))
    .map((row) => row.firstElementChild?.textContent ?? '');
}

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
      { expression: 'wall', newVariable: { name: 'wall', initializer: "param('wall', 3)" } },
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
      value: 'depth', newVariable: { name: 'depth', initializer: "param('depth', 40)" },
    });

    const { open, type, enter, commits } = mountInput();
    open();
    type('lip');
    enter();
    expect(commits[0].newVariable).toEqual({ name: 'lip', initializer: "param('lip', 25)" });
  });
});

describe('the suggestion chips', () => {
  // One of each kind, all matching `wall`, so the fresh name `wall` also
  // draws the new-variable offer last.
  const KINDS: VariableInfo[] = [
    { name: 'wallParam', initializer: "param('wallParam', 3)" },
    { name: 'wallVar', initializer: '3' },
    { name: 'wallExpr', initializer: 'wallVar * 2' },
  ];

  it('mark each sketcher suggestion by kind', () => {
    const { open, type, container } = mountInput();
    open(KINDS);
    type('wall');
    expect(chips(container)).toEqual(['P', 'V', 'E', 'P']);
  });

  it('mark each dialog-field suggestion by kind', () => {
    const { field, el } = mountField();
    field.setVariables(KINDS);
    el.value = 'wall';
    el.dispatchEvent(new Event('input'));
    expect(chips(document.body)).toEqual(['P', 'V', 'E', 'P']);
    // The open dropdown holds document/window listeners; the suite shares one jsdom.
    field.destroy();
  });

  it('re-chip the sketcher offer when the toggle flips', () => {
    const { open, type, button, container } = mountInput();
    open(KINDS);
    type('lip');
    expect(chips(container)).toEqual(['P']);

    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(chips(container)).toEqual(['V']);
  });

  it('re-chip the dialog-field offer once the toggle flips', () => {
    const { field, el, button } = mountField();
    field.setVariables(KINDS);
    el.value = 'lip';
    el.dispatchEvent(new Event('input'));
    expect(chips(document.body)).toEqual(['P']);

    // The P click lands outside the dropdown, which closes it; the next
    // keystroke reopens it with the offer re-chipped.
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new Event('input'));
    expect(chips(document.body)).toEqual(['V']);
    field.destroy();
  });
});

describe('the P toggle beside a matched name', () => {
  // `te` is a fresh name, but the dropdown also offers `testVar` for it.
  const VARS: VariableInfo[] = [{ name: 'testVar', initializer: '3' }];

  it('hides in the sketcher input while the dropdown matches the bare name', () => {
    const { open, type, button } = mountInput();
    open(VARS);
    type('te');
    expect(button.classList.contains('hidden')).toBe(true);

    // No match left: the name is plainly new.
    type('tex');
    expect(button.classList.contains('hidden')).toBe(false);

    // An explicit declaration keeps it, whatever its value matches.
    type('te = tes');
    expect(button.classList.contains('hidden')).toBe(false);
  });

  it('still declares a param when the offer is committed with the toggle hidden', () => {
    const { open, type, commits } = mountInput();
    open(VARS);
    const el = type('te');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(commits).toEqual([
      { expression: 'te', newVariable: { name: 'te', initializer: "param('te', 25)" } },
    ]);
  });

  it('hides beside a dialog field until picking the new-variable offer closes the list', () => {
    const { field, el, button } = mountField();
    field.setVariables(VARS);
    el.value = 'te';
    el.dispatchEvent(new Event('input'));
    expect(button.classList.contains('hidden')).toBe(true);

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(el.value).toBe('te');
    expect(button.classList.contains('hidden')).toBe(false);
    expect(field.read()).toEqual({
      value: 'te', newVariable: { name: 'te', initializer: "param('te', 25)" },
    });
    field.destroy();
  });

  it('comes back beside a dialog field when Escape dismisses the matches', () => {
    const { field, el, button } = mountField();
    field.setVariables(VARS);
    el.value = 'te';
    el.dispatchEvent(new Event('input'));
    expect(button.classList.contains('hidden')).toBe(true);

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(button.classList.contains('hidden')).toBe(false);
    field.destroy();
  });
});
