// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorPanel, DEFAULT_COLOR } from '../src/interactive/create-feature/color-panel';
import type { VariableInfo } from '../src/ui/expression-core';
import './dom-reset';

// The Color dialog's value field takes an expression under its ƒ toggle the
// way a schema dialog's text does: a statement holding one (`color(tint, e)`)
// opens the field in that mode with the colour it comes to beside it, the
// well and the swatch ring following that colour when it is one and staying
// put otherwise; left alone the field writes the expression back as it was;
// ƒ off lands the field on the resolved colour; ƒ on seeds the input with
// the field's text as source; the well and the swatches choose a literal,
// leaving the mode.

const VARIABLES: VariableInfo[] = [
  { name: 'tint', initializer: "'tomato'", numeric: false, value: 'tomato' },
  { name: 'shade', initializer: "'nope'", numeric: false, value: 'nope' },
  { name: 'count', initializer: '7', numeric: true, value: 7 },
];

const opened: ColorPanel[] = [];

function openPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new ColorPanel(container);
  const changes = vi.fn();
  panel.onChange = changes;
  opened.push(panel);
  const q = <T extends HTMLElement>(role: string) => container.querySelector<T>(`[data-role="${role}"]`)!;
  const toggle = () => q<HTMLButtonElement>('expression-value');
  const input = () => q<HTMLInputElement>('expr-value');
  const resolved = () => {
    const note = q<HTMLElement>('expression-line-value').querySelector<HTMLElement>('[data-role="resolved"]')!;
    return note.hidden ? undefined : { text: note.textContent, warning: note.title || undefined };
  };
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const on = () => toggle().getAttribute('aria-pressed') === 'true';
  const field = () => q<HTMLInputElement>('value');
  const well = () => q<HTMLInputElement>('well');
  const ringed = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-swatch]')]
    .filter(button => button.className.includes('ring-2')).map(button => button.dataset.swatch);
  return { panel, container, changes, toggle, input, resolved, type, on, field, well, ringed };
}

afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
  document.body.innerHTML = '';
});

describe('Color panel — the value field takes an expression', () => {
  it('opens a statement\'s expression in expression mode with the colour it comes to; the well follows a colour and stays put otherwise', () => {
    const { panel, on, input, field, well, ringed, resolved, type, changes } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.showEdit('solids', { expr: 'tint' });
    expect(on()).toBe(true);
    expect(input().value).toBe('tint');
    expect(field().classList.contains('hidden')).toBe(true);
    expect(resolved()).toEqual({ text: "'tomato'", warning: undefined });
    expect(panel.readColor()).toEqual({ value: { expr: 'tint' } });
    expect(panel.colorValue).toBe('tomato');
    expect(well().value).toBe('#ff6347');
    expect(ringed()).toEqual(['tomato']);
    expect(changes).not.toHaveBeenCalled();
    // A value that is no colour: the expression still rides, the well keeps its last colour.
    type('shade');
    expect(panel.readColor()).toEqual({ value: { expr: 'shade' } });
    expect(panel.colorValue).toBe('nope');
    expect(well().value).toBe('#ff6347');
    expect(ringed()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(1);
    // A number is the row's warning, not a refusal; the field then stands on no colour.
    type('count');
    expect(resolved()).toEqual({ text: '7', warning: 'count is 7, which is not text.' });
    expect(panel.readColor()).toEqual({ value: { expr: 'count' } });
    expect(panel.colorValue).toBe('');
    type(' ');
    expect(panel.readColor()).toEqual({ error: 'Colour needs an expression.' });
  });

  it('ƒ off lands the field on the resolved colour, as a change; ƒ on seeds the field\'s text as source', () => {
    const { panel, on, toggle, input, field, resolved, changes } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.showEdit('solids', { expr: 'tint' });
    toggle().click();
    expect(on()).toBe(false);
    expect(field().classList.contains('hidden')).toBe(false);
    expect(field().value).toBe('tomato');
    expect(panel.readColor()).toEqual({ value: 'tomato' });
    expect(changes).toHaveBeenCalledTimes(1);
    toggle().click();
    expect(input().value).toBe("'tomato'");
    expect(resolved()).toEqual({ text: "'tomato'", warning: undefined });
    expect(panel.readColor()).toEqual({ value: { expr: "'tomato'" } });
  });

  it('the swatches and the well choose a literal, leaving the mode; a fresh dialog opens with the mode off', () => {
    const { panel, container, on, toggle, field, well } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.showEdit('solids', { expr: 'tint' });
    container.querySelector<HTMLButtonElement>('button[data-swatch="gold"]')!.click();
    expect(on()).toBe(false);
    expect(field().value).toBe('gold');
    expect(well().value).toBe('#ffd700');
    toggle().click();
    expect(on()).toBe(true);
    well().value = '#4682b4';
    well().dispatchEvent(new Event('input'));
    expect(on()).toBe(false);
    expect(panel.readColor()).toEqual({ value: '#4682b4' });
    toggle().click();
    panel.show();
    expect(on()).toBe(false);
    expect(field().value).toBe(DEFAULT_COLOR);
  });

  it('Enter in the expression input applies; the input counts as the field\'s focus', () => {
    const { panel, toggle, input } = openPanel();
    const apply = vi.fn();
    panel.onApply = apply;
    panel.show();
    toggle().click();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(panel.ownsFocus(input())).toBe(true);
  });
});
