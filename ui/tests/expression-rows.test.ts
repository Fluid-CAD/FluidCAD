// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceControl } from '../src/interactive/create-feature/choice-control';
import { ExtrudePanel } from '../src/interactive/create-feature/extrude-panel';
import { TextControl } from '../src/interactive/create-feature/expression-rows';
import type { ChoiceItem } from '../src/ui/controls';
import type { VariableInfo } from '../src/ui/expression-core';
import './dom-reset';

// The built-in dialogs' typed-in rows take an expression the way a schema
// dialog's do: a checkbox, a text and a dropdown each wear the ƒ toggle; a
// statement holding an expression (`drill(flag)`) opens the row in that mode
// with what it comes to beside it; left alone the row writes the expression
// back as it was; ƒ off lands the control on the resolved value; ƒ on seeds
// the input with the control's own value as source; typing writes the text.

const VARIABLES: VariableInfo[] = [
  { name: 'flag', initializer: "param('Flag', false, 'checkbox')", numeric: true, value: false },
  { name: 'count', initializer: '7', numeric: true, value: 7 },
  { name: 'label', initializer: "'rib'", numeric: false, value: 'rib' },
  { name: 'fit', initializer: "'close'", numeric: false, value: 'close' },
];

const opened: { hide(): void }[] = [];
const destroyed: { destroy(): void }[] = [];

afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
  for (const control of destroyed.splice(0)) {
    control.destroy();
  }
  document.dispatchEvent(new Event('pointerdown'));
});

/** The ƒ toggle, expression input and resolved note of the row named `name`, wherever it was built. */
function rowOf(root: HTMLElement, name: string) {
  const q = <T extends HTMLElement>(role: string) => root.querySelector<T>(`[data-role="${role}"]`)!;
  const toggle = () => q<HTMLButtonElement>(`expression-${name}`);
  const input = () => q<HTMLInputElement>(`expr-${name}`);
  const resolved = () => {
    const note = q<HTMLElement>(`expression-line-${name}`).querySelector<HTMLElement>('[data-role="resolved"]')!;
    return note.hidden ? undefined : { text: note.textContent, warning: note.title || undefined };
  };
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const shown = (el: HTMLElement) => el.closest('.hidden') === null;
  return { q, toggle, input, resolved, type, shown };
}

describe('a built-in panel checkbox — the extrude dialog\'s drill holes', () => {
  function openPanel() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ExtrudePanel(container);
    const changes = vi.fn();
    panel.onChange = changes;
    panel.setScopeVariables(VARIABLES);
    opened.push(panel);
    const row = rowOf(container, 'drill');
    const box = () => row.q<HTMLInputElement>('drill');
    const drill = () => {
      const values = panel.values();
      return 'error' in values ? values : values.drill;
    };
    return { panel, container, changes, box, drill, ...row };
  }

  /** The edit-mode seed of a plain one-direction extrude, the drill as given. */
  const edited = (drill: boolean | { expr: string }) => ({
    op: 'add' as const, distance: 25, distance2: null, symmetric: false, draft: null, endOffset: null, drill, thin: null,
    profileLabel: 's', toFaceLabel: null, toFaceKind: null,
  });

  it('opens a statement\'s expression in expression mode with what it comes to, and reads it back verbatim', () => {
    const { panel, toggle, input, box, resolved, shown, drill, changes } = openPanel();
    panel.showEdit(edited({ expr: '!flag' }));
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(input().value).toBe('!flag');
    expect(shown(input())).toBe(true);
    expect(shown(box())).toBe(false);
    expect(box().disabled).toBe(true);
    expect(resolved()).toEqual({ text: 'true', warning: undefined });
    expect(drill()).toEqual({ expr: '!flag' });
    expect(changes).not.toHaveBeenCalled();
  });

  it('warns of a value that is not true or false, and still reads the expression', () => {
    const { panel, resolved, drill } = openPanel();
    panel.showEdit(edited({ expr: 'count' }));
    expect(resolved()).toEqual({ text: '7', warning: 'count is 7, which is not true or false.' });
    expect(drill()).toEqual({ expr: 'count' });
  });

  it('ƒ off lands the box on the resolved value, as a change; ƒ on seeds the box\'s value as source', () => {
    const { panel, toggle, input, box, shown, drill, changes, resolved } = openPanel();
    panel.showEdit(edited({ expr: '!flag' }));
    toggle().click();
    expect(shown(box())).toBe(true);
    expect(box().disabled).toBe(false);
    expect(box().checked).toBe(true);
    expect(drill()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    box().checked = false;
    box().dispatchEvent(new Event('change'));
    expect(drill()).toBe(false);
    toggle().click();
    expect(shown(input())).toBe(true);
    expect(input().value).toBe('false');
    expect(resolved()).toEqual({ text: 'false', warning: undefined });
    expect(drill()).toEqual({ expr: 'false' });
  });

  it('typing an expression writes it as source; emptied, the row has nothing to write', () => {
    const { panel, toggle, type, drill, changes } = openPanel();
    panel.show([]);
    toggle().click();
    type('count > 4 && !flag');
    expect(drill()).toEqual({ expr: 'count > 4 && !flag' });
    expect(changes).toHaveBeenCalled();
    type('  ');
    expect(drill()).toEqual({ error: 'Drill holes needs an expression.' });
  });

  it('a click on the row\'s label text still ticks the box, not the ƒ toggle beside it', () => {
    const { panel, toggle, box, changes } = openPanel();
    panel.show([]);
    box().closest('label')!.querySelector('span')!.click();
    expect(box().checked).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('a fresh dialog and a plain statement open with the box, the mode off', () => {
    const { panel, toggle, box, shown, drill } = openPanel();
    panel.showEdit(edited({ expr: '!flag' }));
    panel.show([]);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(shown(box())).toBe(true);
    expect(box().checked).toBe(true);
    expect(drill()).toBe(true);
    panel.showEdit(edited(false));
    expect(box().checked).toBe(false);
    expect(drill()).toBe(false);
  });
});

describe('a built-in panel text row', () => {
  function mount() {
    const host = document.createElement('label');
    host.className = 'flex flex-col gap-1.5';
    host.innerHTML = `<span class="text-base-content/70">Text</span><input data-role="value" type="text" class="input" />`;
    document.body.appendChild(host);
    const field = host.querySelector<HTMLInputElement>('[data-role="value"]')!;
    const control = new TextControl(field, host.querySelector('span')!, { name: 'value', label: 'Text' });
    destroyed.push(control);
    const changes = vi.fn();
    control.onChange = changes;
    control.setVariables(VARIABLES);
    return { control, field, changes, ...rowOf(host, 'value') };
  }

  it('opens an expression with the text it comes to, reads it back, and ƒ off lands the input on that text', () => {
    const { control, field, toggle, resolved, shown, changes } = mount();
    control.setValue({ expr: '`${label}-${count}`' });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(shown(field)).toBe(false);
    expect(resolved()).toEqual({ text: "'rib-7'", warning: undefined });
    expect(control.text).toBe('rib-7');
    expect(control.read()).toEqual({ value: { expr: '`${label}-${count}`' } });
    expect(changes).not.toHaveBeenCalled();
    toggle().click();
    expect(shown(field)).toBe(true);
    expect(field.value).toBe('rib-7');
    expect(control.read()).toEqual({ value: 'rib-7' });
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('ƒ on seeds the input\'s text as source, and a typed expression is what it reads; a number warns', () => {
    const { control, field, input, toggle, resolved, type } = mount();
    control.setValue("it's");
    toggle().click();
    expect(field.value).toBe("it's");
    expect(input().value).toBe("'it\\'s'");
    expect(resolved()).toEqual({ text: "'it\\'s'", warning: undefined });
    type('count');
    expect(resolved()).toEqual({ text: '7', warning: 'count is 7, which is not text.' });
    expect(control.text).toBeUndefined();
    expect(control.read()).toEqual({ value: { expr: 'count' } });
  });
});

describe('a built-in panel dropdown — ChoiceControl', () => {
  const FITS: ChoiceItem<string>[] = [
    { value: 'close', label: 'Close' },
    { value: 'normal', label: 'Normal' },
    { value: 'loose', label: 'Loose' },
  ];

  function mount() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const control = new ChoiceControl<string>({ items: FITS, value: 'normal', label: 'Fastener fit', dataRole: 'fit' });
    destroyed.push(control);
    host.append(control.element);
    const label = document.createElement('div');
    label.append(control.toggle);
    host.prepend(label);
    const changes = vi.fn();
    control.onChange = changes;
    control.setVariables(VARIABLES);
    return { control, host, changes, ...rowOf(host, 'fit') };
  }

  it('opens an expression with the option it comes to, reads `{ expr }` with the option, and keeps the button for the way back', () => {
    const { control, toggle, input, resolved, shown, changes } = mount();
    control.setExpr("flag ? 'loose' : 'close'");
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(input().value).toBe("flag ? 'loose' : 'close'");
    expect(shown(control.element)).toBe(false);
    expect(resolved()).toEqual({ text: 'Close', warning: undefined });
    expect(control.value).toBe('close');
    expect(control.binding).toBeUndefined();
    expect(control.expression).toEqual({ expr: "flag ? 'loose' : 'close'" });
    expect(control.read()).toEqual({ expr: "flag ? 'loose' : 'close'", value: 'close' });
    expect(changes).not.toHaveBeenCalled();
    toggle().click();
    expect(shown(control.element)).toBe(true);
    expect(control.read()).toEqual({ value: 'close' });
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('warns of a value no option carries, reading the expression without one; emptied, it has nothing to write', () => {
    const { control, resolved, type } = mount();
    control.setExpr('count');
    expect(resolved()).toEqual({ text: '7', warning: 'count is 7, which is not one of the options.' });
    expect(control.value).toBeUndefined();
    expect(control.read()).toEqual({ expr: 'count' });
    type(' ');
    expect(control.read()).toEqual({ error: 'Fastener fit needs an expression.' });
  });

  it('ƒ on seeds the chosen option as source, or a bound variable\'s name, letting the binding go', () => {
    const { control, toggle, input, resolved } = mount();
    toggle().click();
    expect(input().value).toBe("'normal'");
    expect(resolved()).toEqual({ text: 'Normal', warning: undefined });
    expect(control.read()).toEqual({ expr: "'normal'", value: 'normal' });
    toggle().click();
    control.setRef('fit');
    expect(control.binding).toEqual({ ref: 'fit' });
    toggle().click();
    expect(input().value).toBe('fit');
    expect(control.binding).toBeUndefined();
    expect(resolved()).toEqual({ text: 'Close', warning: undefined });
    toggle().click();
    expect(control.read()).toEqual({ value: 'close' });
  });

  it('a value or a binding set from outside leaves the mode', () => {
    const { control, toggle } = mount();
    control.setExpr("'loose'");
    control.setValue('close');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(control.read()).toEqual({ value: 'close' });
    control.setExpr("'loose'");
    control.setRef('fit');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(control.read()).toMatchObject({ ref: 'fit' });
  });
});
