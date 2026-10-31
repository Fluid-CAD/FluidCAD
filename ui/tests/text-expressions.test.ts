// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextPanel } from '../src/interactive/tools/text-panel';
import type { TextOptionValues } from '../src/api';
import type { VariableInfo } from '../src/ui/expression-core';
import './dom-reset';

// The Text dialog's typed-in rows take an expression the way a schema
// dialog's do: the string, the font, the weight, the flags and the alignment
// under their ƒ toggles, the numbers through their expression fields. A
// statement holding one (`` text(`rib-${n}`) ``, `.weight(bold ? 700 :
// 400)`) opens the row in that mode with what it comes to beside it; left
// alone the row writes the expression back as it was; ƒ off lands the control
// on the resolved value; ƒ on seeds the input with the control's own value as
// source; typing writes the text. The outline preview draws from what the
// rows resolve to, and nothing while one cannot be told.

const VARIABLES: VariableInfo[] = [
  { name: 'label', initializer: "'rib'", numeric: false, value: 'rib' },
  { name: 'count', initializer: '7', numeric: true, value: 7 },
  { name: 'bold', initializer: "param('Bold', true, 'checkbox')", numeric: true, value: true },
  { name: 'cap', initializer: '6', numeric: true, value: 6 },
  { name: 'family', initializer: "'Comic Sans'", numeric: false, value: 'Comic Sans' },
  { name: 'side', initializer: "'right'", numeric: false, value: 'right' },
];

const opened: TextPanel[] = [];

/** A plain anchored statement's options, the given rows as given. */
function options(overrides: Partial<TextOptionValues> = {}): TextOptionValues {
  return {
    text: 'Text', size: 10, font: null, weight: 400, italic: false, align: 'left', lineSpacing: 1, letterSpacing: 0,
    offset: 0, startAt: 0, flip: false, ...overrides,
  };
}

function openPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new TextPanel(container);
  const changes = vi.fn();
  panel.onChange = changes;
  panel.show();
  opened.push(panel);
  const q = <T extends HTMLElement>(role: string) => container.querySelector<T>(`[data-role="${role}"]`)!;
  /** The ƒ toggle, expression input and resolved note of the row named `name`. */
  const row = (name: string) => {
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
    const on = () => toggle().getAttribute('aria-pressed') === 'true';
    return { toggle, input, resolved, type, on };
  };
  const shown = (el: HTMLElement) => el.closest('.hidden') === null;
  /** Type into a number field as the user would. */
  const fill = (role: string, text: string) => {
    const input = q<HTMLInputElement>(role);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { panel, container, changes, q, row, shown, fill };
}

afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.destroy();
  }
  document.body.innerHTML = '';
});

describe('Text panel — the text row takes an expression', () => {
  it('opens a statement\'s template string in expression mode with the text it comes to, reads it back verbatim, and the outline draws that text', () => {
    const { panel, row, q, shown, changes } = openPanel();
    panel.setScopeVariables(VARIABLES);
    const text = row('text');
    panel.setValues(options({ text: { expr: '`${label}-${count}`' } }));
    expect(text.on()).toBe(true);
    expect(text.input().value).toBe('`${label}-${count}`');
    expect(shown(q('text'))).toBe(false);
    expect(text.resolved()).toEqual({ text: "'rib-7'", warning: undefined });
    expect(panel.values()).toMatchObject({ text: { expr: '`${label}-${count}`' } });
    expect(panel.previewOptions()?.text).toBe('rib-7');
    expect(changes).not.toHaveBeenCalled();
    // ƒ off lands the textarea on the text the expression came to, as a change.
    text.toggle().click();
    expect(shown(q('text'))).toBe(true);
    expect(q<HTMLTextAreaElement>('text').value).toBe('rib-7');
    expect(panel.values()).toMatchObject({ text: 'rib-7' });
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('typing writes the expression; emptied, the row has nothing to write; a blank literal is the statement\'s one refusal', () => {
    const { panel, row } = openPanel();
    panel.setScopeVariables(VARIABLES);
    const text = row('text');
    text.toggle().click();
    expect(text.input().value).toBe("'Text'");
    text.type('label');
    expect(panel.values()).toMatchObject({ text: { expr: 'label' } });
    expect(TextPanel.blankText({ expr: 'label' })).toBe(false);
    text.type('  ');
    expect(panel.values()).toEqual({ error: 'Text needs an expression.' });
    expect(TextPanel.blankText('  ')).toBe(true);
  });

  it('Enter in an expression input applies', () => {
    const { panel, row } = openPanel();
    const apply = vi.fn();
    panel.onApply = apply;
    const text = row('text');
    text.toggle().click();
    text.input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('Text panel — the weight dropdown, the flags, the alignment and the font take an expression', () => {
  it('a weight expression comes to a number the dropdown spells; ƒ off lands on it, ƒ on seeds the option bare', () => {
    const { panel, row, q, changes } = openPanel();
    panel.setScopeVariables(VARIABLES);
    const weight = row('weight');
    panel.setValues(options({ weight: { expr: 'bold ? 700 : 400' } }));
    expect(weight.on()).toBe(true);
    expect(weight.resolved()).toEqual({ text: 'Bold', warning: undefined });
    expect(panel.values()).toMatchObject({ weight: { expr: 'bold ? 700 : 400' } });
    expect(panel.previewOptions()?.options.weight).toBe(700);
    weight.toggle().click();
    expect(q<HTMLSelectElement>('weight').value).toBe('700');
    expect(panel.values()).toMatchObject({ weight: 700 });
    expect(changes).toHaveBeenCalledTimes(1);
    // The seed is the number itself — `.weight(700)`, never `.weight('700')`.
    weight.toggle().click();
    expect(weight.input().value).toBe('700');
    expect(weight.resolved()).toEqual({ text: 'Bold', warning: undefined });
    expect(panel.values()).toMatchObject({ weight: { expr: '700' } });
    // A number no weight spells is the row's warning, not a refusal.
    weight.type('count');
    expect(weight.resolved()).toEqual({ text: '7', warning: 'count is 7, which is not one of the options.' });
    expect(panel.values()).toMatchObject({ weight: { expr: 'count' } });
    expect(panel.previewOptions()).toBeNull();
  });

  it('the italic flag and the alignment open an expression; a variable named as the alignment opens as the expression of its name', () => {
    const { panel, row } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.setValues(options({ italic: { expr: 'bold' }, align: { expr: "bold ? 'center' : 'left'" } }));
    expect(row('italic').on()).toBe(true);
    expect(row('italic').resolved()).toEqual({ text: 'true', warning: undefined });
    expect(row('align').on()).toBe(true);
    expect(row('align').resolved()).toEqual({ text: 'Center', warning: undefined });
    expect(panel.values()).toMatchObject({ italic: { expr: 'bold' }, align: { expr: "bold ? 'center' : 'left'" } });
    expect(panel.previewOptions()?.options).toMatchObject({ italic: true, align: 'center' });
    panel.setValues(options({ align: { ref: 'side' } }));
    expect(row('align').input().value).toBe('side');
    expect(row('align').resolved()).toEqual({ text: 'Right', warning: undefined });
    expect(panel.values()).toMatchObject({ align: { expr: 'side' } });
    // ƒ off lands the tabs on the resolved alignment.
    row('align').toggle().click();
    expect(panel.values()).toMatchObject({ align: 'right' });
  });

  it('the path-only flip and distributed alignments ride only with a path; an expression there keeps its text', () => {
    const { panel, row } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.setPathMode(true);
    panel.setValues(options({ flip: { expr: '!bold' }, align: { expr: "bold ? 'space-between' : 'left'" }, offset: 'cap / 2' }));
    expect(row('flip').on()).toBe(true);
    expect(row('flip').resolved()).toEqual({ text: 'false', warning: undefined });
    expect(row('align').resolved()).toEqual({ text: 'Between', warning: undefined });
    expect(panel.values()).toMatchObject({ flip: { expr: '!bold' }, align: { expr: "bold ? 'space-between' : 'left'" }, offset: 'cap / 2' });
    expect(panel.previewOptions()?.options).toMatchObject({ flip: false, align: 'space-between', offset: 3 });
    // Without a path the path-only rows read as their defaults, whatever they hold.
    panel.setPathMode(false);
    expect(panel.values()).toMatchObject({ flip: false, offset: 0, startAt: 0 });
  });

  it('a font expression stays shown while the font list arrives late; a family the list lacks is a warning, not a refusal', () => {
    const { panel, row, q } = openPanel();
    panel.setScopeVariables(VARIABLES);
    const font = row('font');
    panel.setValues(options({ font: { expr: 'family' } }));
    expect(font.on()).toBe(true);
    expect(font.resolved()).toEqual({ text: "'Comic Sans'", warning: "family is 'Comic Sans', which is not one of the options." });
    expect(panel.values()).toMatchObject({ font: { expr: 'family' } });
    // The outline still lays out in that family — the build says whether it exists.
    expect(panel.previewOptions()?.options.font).toBe('Comic Sans');
    panel.setFonts(['Arial', 'Comic Sans']);
    expect(font.on()).toBe(true);
    expect(font.input().value).toBe('family');
    expect(font.resolved()).toEqual({ text: 'Comic Sans', warning: undefined });
    expect([...q<HTMLSelectElement>('font').options].map(o => o.value)).toEqual(['', 'Arial', 'Comic Sans']);
    // ƒ off lands the dropdown on the resolved family; the Default option reads as no font.
    font.toggle().click();
    expect(panel.values()).toMatchObject({ font: 'Comic Sans' });
    q<HTMLSelectElement>('font').value = '';
    expect(panel.values()).toMatchObject({ font: null });
  });
});

describe('Text panel — the number rows are expression fields', () => {
  it('a statement\'s bare expressions open as typed, read back as they are, and the outline resolves them once the variables arrive', () => {
    const { panel, q } = openPanel();
    panel.setValues(options({ size: 'cap * 2', letterSpacing: 'count / 10' }));
    expect(q<HTMLInputElement>('size').value).toBe('cap * 2');
    expect(panel.values()).toMatchObject({ size: 'cap * 2', letterSpacing: 'count / 10', lineSpacing: 1 });
    // Before the scope's variables arrive the numbers come to nothing: no outline, the statement preview stands alone.
    expect(panel.previewOptions()).toBeNull();
    panel.setScopeVariables(VARIABLES);
    expect(panel.previewOptions()?.options).toMatchObject({ size: 12, letterSpacing: 0.7 });
  });

  it('a literal keeps its range checks; an empty field is the row\'s own message', () => {
    const { panel, fill } = openPanel();
    fill('size', '0');
    expect(panel.values()).toEqual({ error: 'Enter a positive text size.' });
    fill('size', '  ');
    expect(panel.values()).toEqual({ error: 'Enter a positive text size.' });
    fill('size', 'cap');
    fill('line-spacing', '');
    expect(panel.values()).toEqual({ error: 'Enter a positive line spacing factor.' });
    fill('line-spacing', '1.2');
    expect(panel.values()).toMatchObject({ size: 'cap', lineSpacing: 1.2 });
  });

  it('a literal statement opens every row out of expression mode', () => {
    const { panel, row } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.setValues(options({ text: { expr: 'label' }, weight: { expr: '700' }, italic: { expr: 'bold' }, align: { expr: "'right'" } }));
    panel.setValues(options({ text: 'Hi', weight: 700, italic: true, align: 'center', size: 12 }));
    for (const name of ['text', 'font', 'weight', 'italic', 'align']) {
      expect(row(name).on(), name).toBe(false);
    }
    expect(panel.values()).toMatchObject({ text: 'Hi', weight: 700, italic: true, align: 'center', size: 12, font: null });
    expect(panel.previewOptions()).toEqual({
      text: 'Hi',
      options: { size: 12, font: null, weight: 700, italic: true, align: 'center', lineSpacing: 1, letterSpacing: 0, offset: 0, startAt: 0, flip: false },
    });
  });
});
