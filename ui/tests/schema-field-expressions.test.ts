// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureScalarParam } from '../src/api';
import { SchemaField } from '../src/interactive/create-feature/schema/schema-fields';
import { SchemaFeaturePanel } from '../src/interactive/create-feature/schema/schema-feature-panel';
import { FeatureSchema } from '../src/interactive/create-feature/schema/feature-schema';
import type { VariableInfo } from '../src/ui/expression-core';
import { DerivedLayout, type BareFeatureMeta } from './fixtures/derived-layout';

// Any typed-in row may hold a source expression in place of its literal:
// a statement computing a value (`panel: left ? 'left' : 'right'`) opens
// in the dialog with the expression shown and the value it comes to muted
// beside it; left alone, the row writes the expression back as it was;
// an option chosen, a box ticked, text typed replaces it; and the ƒ toggle
// turns any row into an expression input, and back.

const rows: SchemaField[] = [];

afterEach(() => {
  for (const row of rows.splice(0)) {
    row.destroy();
  }
  document.body.innerHTML = '';
});

const VARIABLES: VariableInfo[] = [
  { name: 'left', initializer: "param('Left panel', false, 'checkbox')", numeric: true, value: false },
  { name: 'ribs', initializer: '7', numeric: true, value: 7 },
  { name: 'kind', initializer: "'round'", numeric: false, value: 'round' },
  { name: 'steps', initializer: "['deburr']", numeric: false, value: ['deburr'] },
];

const PANEL: FeatureScalarParam = { type: 'select', label: 'Panel', default: 'right', options: [{ label: 'Right', value: 'right' }, { label: 'Left', value: 'left' }, { label: 'Both', value: 'both' }] };
const STYLE: FeatureScalarParam = { type: 'radio', label: 'Style', default: 'flat', options: [{ label: 'Flat', value: 'flat' }, { label: 'Round', value: 'round' }] };
const FLIP: FeatureScalarParam = { type: 'boolean', label: 'Flip', default: false };
const TAG: FeatureScalarParam = { type: 'text', label: 'Tag', default: 'rib' };
const FINISHES: FeatureScalarParam = { type: 'select', multiple: true, label: 'Finishes', default: [], options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Polish', value: 'polish' }] };

function field(spec: FeatureScalarParam, seed?: Parameters<SchemaField['seed']>[0], variables: VariableInfo[] | null = VARIABLES) {
  const row = SchemaField.create('v', spec);
  rows.push(row);
  document.body.append(row.row);
  let changes = 0;
  row.onChange = () => changes++;
  if (variables) {
    row.setVariables(variables);
  }
  row.seed(seed);
  const q = <T extends HTMLElement>(role: string) => row.row.querySelector<T>(`[data-role="${role}"]`);
  const toggle = () => q<HTMLButtonElement>('expression-v')!;
  const input = () => q<HTMLInputElement>('expr-v')!;
  const control = () => q<HTMLElement>('value-v')!;
  const resolved = () => {
    const note = q<HTMLElement>('resolved');
    return note && !note.hidden ? { text: note.textContent, warning: note.title || undefined } : undefined;
  };
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const shown = (el: HTMLElement) => el.closest('.hidden') === null;
  return { row, q, toggle, input, control, resolved, type, shown, changes: () => changes };
}

const chooseOption = (control: HTMLElement, label: string): void => {
  control.click();
  [...document.querySelectorAll<HTMLElement>('[role="option"]:not([data-parameter])')].find(o => o.querySelector('.truncate')!.textContent === label)!.click();
};

describe('a select holding an expression', () => {
  it('opens on the expression, clean, with the option it comes to beside it, and reads it back as it was', () => {
    const { row, toggle, input, control, resolved, shown } = field(PANEL, { expr: "left ? 'left' : 'right'" });
    expect(input().value).toBe("left ? 'left' : 'right'");
    expect(shown(input())).toBe(true);
    expect(shown(control())).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(resolved()).toEqual({ text: 'Right', warning: undefined });
    expect(row.read()).toEqual({ value: { expr: "left ? 'left' : 'right'" } });
    expect(row.current()).toBe('right');
    expect(row.dirty).toBe(false);
  });

  it('resolves once the variables arrive, and again when they change — still clean', () => {
    const { row, resolved } = field(PANEL, { expr: "left ? 'left' : 'right'" }, null);
    expect(resolved()).toBeUndefined();
    expect(row.current()).toBeUndefined();
    row.setVariables(VARIABLES);
    expect(resolved()).toEqual({ text: 'Right', warning: undefined });
    expect(row.current()).toBe('right');
    row.setVariables([{ ...VARIABLES[0], value: true }]);
    expect(resolved()).toEqual({ text: 'Left', warning: undefined });
    expect(row.current()).toBe('left');
    expect(row.dirty).toBe(false);
  });

  it('warns of a value no option carries, and feeds visibleWhen nothing for it', () => {
    const { row, resolved } = field(PANEL, { expr: "left ? 'left' : 'top'" });
    expect(resolved()).toEqual({ text: "'top'", warning: "left ? 'left' : 'top' is 'top', which is not one of the options." });
    expect(row.current()).toBeUndefined();
    // The row still reads: the file checks what the expression comes to when the feature runs.
    expect(row.read()).toEqual({ value: { expr: "left ? 'left' : 'top'" } });
    const flag = field(PANEL, { expr: '!left' });
    expect(flag.resolved()).toEqual({ text: 'true', warning: '!left is true, which is not one of the options.' });
  });

  it('typing replaces the expression and dirties the row; emptied, it has nothing to write', () => {
    const { row, type, resolved, changes } = field(PANEL, { expr: "left ? 'left' : 'right'" });
    type("ribs > 5 ? 'both' : 'right'");
    expect(changes()).toBe(1);
    expect(row.dirty).toBe(true);
    expect(resolved()).toEqual({ text: 'Both', warning: undefined });
    expect(row.read()).toEqual({ value: { expr: "ribs > 5 ? 'both' : 'right'" } });
    type('   ');
    expect(row.read()).toEqual({ error: 'Panel needs an expression.' });
    expect(resolved()).toBeUndefined();
  });

  it('the ƒ toggle leaves the expression for the option it came to, as a change; an option chosen there is the row\'s own', () => {
    const { row, toggle, control, input, shown, changes } = field(PANEL, { expr: "left ? 'left' : 'right'" });
    toggle().click();
    expect(shown(control())).toBe(true);
    expect(shown(input())).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(control().textContent).toBe('Right');
    expect(row.read()).toEqual({ value: 'right' });
    expect(changes()).toBe(1);
    expect(row.dirty).toBe(true);
    chooseOption(control(), 'Both');
    expect(row.read()).toEqual({ value: 'both' });
    expect(changes()).toBe(2);
  });

  it('the ƒ toggle turns a plain row into an expression over the option as source, clean until typed; back again is no change', () => {
    const { row, toggle, input, control, resolved, type, shown, changes } = field(PANEL, 'left');
    toggle().click();
    expect(shown(input())).toBe(true);
    expect(shown(control())).toBe(false);
    expect(input().value).toBe("'left'");
    expect(resolved()).toEqual({ text: 'Left', warning: undefined });
    expect(row.read()).toEqual({ value: { expr: "'left'" } });
    expect(row.dirty).toBe(false);
    expect(changes()).toBe(0);
    toggle().click();
    expect(row.read()).toEqual({ value: 'left' });
    expect(row.dirty).toBe(false);
    toggle().click();
    type("ribs > 5 ? 'both' : 'left'");
    expect(row.read()).toEqual({ value: { expr: "ribs > 5 ? 'both' : 'left'" } });
    expect(row.dirty).toBe(true);
    expect(row.current()).toBe('both');
  });

  it('a seed of an option after an expression is the plain row again, and a seed of an expression after an option the expression', () => {
    const { row, toggle, input, control, shown } = field(PANEL, { expr: 'kind' });
    row.seed('both');
    expect(shown(control())).toBe(true);
    expect(shown(input())).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(row.read()).toEqual({ value: 'both' });
    row.seed({ expr: "left ? 'left' : 'right'" });
    expect(shown(input())).toBe(true);
    expect(row.read()).toEqual({ value: { expr: "left ? 'left' : 'right'" } });
    expect(row.dirty).toBe(false);
  });
});

describe('a radio, a boolean, a text and a select of several holding an expression', () => {
  it('a radio shows the expression over its group, and takes one by the toggle like a select', () => {
    const { row, toggle, input, control, resolved, shown } = field(STYLE, { expr: 'kind' });
    expect(shown(input())).toBe(true);
    expect(shown(control())).toBe(false);
    expect(resolved()).toEqual({ text: 'Round', warning: undefined });
    expect(row.current()).toBe('round');
    expect(row.read()).toEqual({ value: { expr: 'kind' } });
    toggle().click();
    expect([...control().querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(r => r.checked)).toEqual([false, true]);
    expect(row.read()).toEqual({ value: 'round' });
    expect(row.dirty).toBe(true);
  });

  it('a boolean shows true or false, warns of anything else, and goes back to the switch on what it came to', () => {
    const { row, toggle, input, control, resolved, type, shown, changes } = field(FLIP, { expr: 'ribs > 5' });
    expect(shown(input())).toBe(true);
    expect(shown(control())).toBe(false);
    expect(resolved()).toEqual({ text: 'true', warning: undefined });
    expect(row.current()).toBe(true);
    expect(row.read()).toEqual({ value: { expr: 'ribs > 5' } });
    type('kind');
    expect(resolved()).toEqual({ text: "'round'", warning: "kind is 'round', which is not true or false." });
    expect(row.current()).toBeUndefined();
    type('!left && ribs > 5');
    toggle().click();
    expect(shown(control())).toBe(true);
    expect((control() as HTMLInputElement).checked).toBe(true);
    expect(row.read()).toEqual({ value: true });
    expect(changes()).toBe(3);
    // From the switch: the expression starts from its state.
    toggle().click();
    expect(input().value).toBe('true');
    expect(row.read()).toEqual({ value: { expr: 'true' } });
  });

  it('a text shows the string it comes to, quoted, and starts an expression from its text', () => {
    const { row, toggle, input, control, resolved, type, shown } = field(TAG, { expr: '`rib-${ribs}`' });
    expect(shown(input())).toBe(true);
    expect(shown(control())).toBe(false);
    expect(resolved()).toEqual({ text: "'rib-7'", warning: undefined });
    expect(row.current()).toBe('rib-7');
    expect(row.read()).toEqual({ value: { expr: '`rib-${ribs}`' } });
    type('ribs');
    expect(resolved()).toEqual({ text: '7', warning: 'ribs is 7, which is not text.' });
    toggle().click();
    expect((control() as HTMLInputElement).value).toBe('rib-7');
    expect(row.read()).toEqual({ value: 'rib-7' });
    (control() as HTMLInputElement).value = "it's";
    control().dispatchEvent(new Event('input', { bubbles: true }));
    toggle().click();
    expect(input().value).toBe("'it\\'s'");
    expect(resolved()).toEqual({ text: "'it\\'s'", warning: undefined });
  });

  it('a select of several shows the list it comes to, holds it underneath, and warns of a value that is no list', () => {
    const { row, toggle, input, control, resolved, type, shown } = field(FINISHES, { expr: "left ? [] : steps" });
    expect(shown(input())).toBe(true);
    expect(shown(control())).toBe(false);
    expect(resolved()).toEqual({ text: 'Deburr', warning: undefined });
    expect(row.read()).toEqual({ value: { expr: "left ? [] : steps" } });
    type("['deburr', 'polish']");
    expect(resolved()).toEqual({ text: 'Deburr, Polish', warning: undefined });
    type('kind');
    expect(resolved()).toEqual({ text: "'round'", warning: "kind is 'round', which is not one of the options." });
    type('[]');
    expect(resolved()).toEqual({ text: 'None', warning: undefined });
    type("['polish']");
    toggle().click();
    expect(shown(control())).toBe(true);
    expect(row.read()).toEqual({ value: ['polish'] });
    toggle().click();
    expect(input().value).toBe("['polish']");
  });
});

describe('expressions in a schema dialog', () => {
  const WING: BareFeatureMeta = {
    id: 'acme.wing',
    label: 'Wing',
    group: 'create',
    kind: 'tool',
    operations: [],
    defaultOperation: 'add',
    params: {
      panel: PANEL,
      ribs: { type: 'integer', label: 'Ribs', default: 7 },
      aileron: FLIP,
      hinge: { type: 'length', label: 'Hinge', default: 76, visibleWhen: { aileron: true } },
      tip: { type: 'length', label: 'Tip', default: 10, visibleWhen: { panel: 'left' } },
    },
    call: [],
    ghost: true,
    contexts: ['part'],
  };
  const panels: SchemaFeaturePanel[] = [];

  afterEach(() => {
    panels.splice(0).forEach(panel => panel.destroy());
  });

  function mount() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new SchemaFeaturePanel(container, new FeatureSchema(DerivedLayout.snapshot(WING)), 'icon.svg');
    panels.push(panel);
    panel.show();
    const root = container.querySelector<HTMLElement>('#fluidcad-feature-acme-wing')!;
    const visible = (name: string) => !root.querySelector(`[data-param="${name}"]`)!.closest('.hidden');
    return { panel, root, visible };
  }

  it('opens an edit on the statement\'s expressions, nothing changed, and drives visibleWhen by what they come to', () => {
    const { panel, visible } = mount();
    panel.setScopeVariables(VARIABLES);
    panel.showEdit({ values: { panel: { expr: "left ? 'left' : 'right'" }, aileron: { expr: 'ribs > 5' }, ribs: 7 }, operation: 'add', seedPicks: () => {} });
    expect([...panel.fields.values()].some(each => each.dirty)).toBe(false);
    expect(panel.scalars()).toMatchObject({ panel: 'right', aileron: true, ribs: 7 });
    expect(visible('hinge')).toBe(true);
    expect(visible('tip')).toBe(false);
    // The Left configuration lands: the rows follow the new values, still clean.
    panel.setScopeVariables([{ ...VARIABLES[0], value: true }, ...VARIABLES.slice(1)]);
    expect(panel.scalars()).toMatchObject({ panel: 'left', aileron: true });
    expect([...panel.fields.values()].some(each => each.dirty)).toBe(false);
    // An edit of another row leaves the expressions to the statement: they are not the user's.
    const ribs = panel.fields.get('ribs')!;
    const input = ribs.row.querySelector<HTMLInputElement>('[data-role="value-ribs"]')!;
    input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ribs.dirty).toBe(true);
    expect(panel.fields.get('panel')!.dirty).toBe(false);
    expect(panel.fields.get('panel')!.read()).toEqual({ value: { expr: "left ? 'left' : 'right'" } });
    // A fresh dialog after it starts from the defaults, the expressions gone.
    panel.show();
    expect(panel.fields.get('panel')!.read()).toEqual({ value: 'right' });
    expect(panel.fields.get('aileron')!.read()).toEqual({ value: false });
  });

  it('an expression typed into a fresh dialog reads for the create, and hides the rows its value hides', () => {
    const { panel, root, visible } = mount();
    panel.setScopeVariables(VARIABLES);
    root.querySelector<HTMLButtonElement>('[data-role="expression-panel"]')!.click();
    const input = root.querySelector<HTMLInputElement>('[data-role="expr-panel"]')!;
    input.value = "left ? 'right' : 'left'";
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.fields.get('panel')!.dirty).toBe(true);
    expect(panel.fields.get('panel')!.read()).toEqual({ value: { expr: "left ? 'right' : 'left'" } });
    expect(panel.scalars().panel).toBe('left');
    expect(visible('tip')).toBe(true);
  });
});
