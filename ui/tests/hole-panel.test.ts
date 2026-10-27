// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { HolePanel } from '../src/interactive/create-feature/hole/hole-panel';
import { tableDiameter } from '../src/interactive/create-feature/hole/hole-catalog';
import type { ParsedFeatureStatement } from '../src/api';
import { ParamDeclareMode, type VariableInfo } from '../src/ui/expression-core';
import './dom-reset';

// The Hole dialog's form: what each style, hole type and termination writes
// into the request, the derived diameter the fastener tables give, and the
// size / fit / pitch dropdowns bound to a parameter in place of an option.

const opened: HolePanel[] = [];

/** The scope as the server lists it: a string `param()` is `numeric: true` there, so the dropdowns go by `value`. */
const VARIABLES: VariableInfo[] = [
  { name: 'holeSize', initializer: "param('Size', 'M8', 'select', { options: [] })", numeric: true, value: 'M8' },
  { name: 'fit', initializer: "'close'", numeric: false, value: 'close' },
  { name: 'pitch', initializer: 'param(\'Pitch\', 1)', numeric: true, value: 1 },
  { name: 'finish', initializer: "'matte'", numeric: false, value: 'matte' },
  { name: 'depth', initializer: '8', numeric: true, value: 8 },
  { name: 'half', initializer: 'depth / 2', numeric: true },
];

function openPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new HolePanel(container);
  panel.show();
  opened.push(panel);
  const popover = () => document.body.querySelector<HTMLElement>('[data-mode]');
  const open = (role: string) => container.querySelector<HTMLButtonElement>(`[data-role="${role}"]`)!.click();
  // Escape closes the popover alone; a press elsewhere would also swallow the click that follows it.
  const dismiss = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  const optionRows = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]:not([data-parameter])')];
  /** Choose a native select's value, or a dropdown's option by its label. */
  const select = (role: string, value: string) => {
    const el = container.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
    if (el instanceof HTMLSelectElement) {
      el.value = value;
      el.dispatchEvent(new Event('change'));
      return;
    }
    el.click();
    optionRows().find(option => option.querySelector('.truncate')!.textContent === value)!.click();
  };
  /** The option labels and the parameter names a dropdown lists, closed again. */
  const listed = (role: string) => {
    open(role);
    const options = optionRows().map(option => option.querySelector('.truncate')!.textContent);
    const groups = [...popover()!.querySelectorAll<HTMLElement>('[role="group"]:not([data-role="parameters"])')].map(group => group.getAttribute('aria-label'));
    const parameters = [...document.body.querySelectorAll<HTMLElement>('[data-parameter]:not([data-new])')].map(row => row.dataset.parameter);
    dismiss();
    return { options, groups, parameters };
  };
  /** Pick a parameter row of a dropdown's Parameters group. */
  const pick = (role: string, name: string) => {
    open(role);
    document.body.querySelector<HTMLElement>(`[data-parameter="${name}"]`)!.click();
  };
  /** What a bound dropdown's button shows: the parameter's name and the option it resolves to. */
  const binding = (role: string) => {
    const el = container.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
    return { name: el.querySelector('[data-role="parameter"]')?.textContent, value: el.querySelector('[data-role="resolved"]')?.textContent };
  };
  const type = (role: string, value: string) => {
    const el = container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
    el.value = value;
    el.dispatchEvent(new Event('input'));
  };
  const input = (role: string) => container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
  const tab = (rowRole: string, label: string) => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(`[data-role="${rowRole}"] button`)];
    buttons.find(button => button.textContent === label)!.click();
  };
  const hidden = (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)!.classList.contains('hidden');
  return { panel, container, select, type, input, tab, hidden, open, popover, listed, pick, binding, dismiss };
}

// An open feature panel stays registered for Escape until it hides — leave
// none behind for the next file's dialogs.
afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  ParamDeclareMode.set(true);
});

describe('Hole panel', () => {
  it('opens on a normal-fit M6 clearance hole through all, with the table diameter read-only', () => {
    const { panel, input, hidden } = openPanel();
    expect(panel.values()).toEqual({
      size: { kind: 'fastener', label: 'M6' },
      fastener: { type: 'clearance', fit: 'normal' },
      style: null,
      depth: null,
      tipAngle: null,
      newVariables: undefined,
    });
    expect(input('diameter').value).toBe('6.6');
    expect(input('diameter').readOnly).toBe(true);
    expect(hidden('pitch-row')).toBe(true);
    expect(hidden('blind-rows')).toBe(true);
    expect(panel.armedSlot).toBe('placements');
  });

  it('follows the fit and the size, and switches to the tap drill for a tapped hole', () => {
    const { panel, select, input } = openPanel();
    select('fit', 'Close');
    expect(input('diameter').value).toBe('6.4');
    select('size', 'M8');
    expect(input('diameter').value).toBe('8.4');
    select('type', 'tapped');
    expect(input('diameter').value).toBe('6.8');
    expect(panel.values()).toMatchObject({ size: { kind: 'fastener', label: 'M8' }, fastener: { type: 'tapped', pitch: null } });
    select('pitch', '1 mm');
    expect(input('diameter').value).toBe('7');
    expect(panel.values()).toMatchObject({ fastener: { type: 'tapped', pitch: 1 } });
  });

  it('takes a typed diameter for a drilled hole and refuses a bad one', () => {
    const { panel, select, type, input, hidden } = openPanel();
    select('type', 'drilled');
    expect(input('diameter').readOnly).toBe(false);
    expect(hidden('size-rows')).toBe(true);
    type('diameter', '4.2');
    expect(panel.values()).toMatchObject({ size: { kind: 'diameter', value: 4.2 }, fastener: null });
    type('diameter', '0');
    expect(panel.values()).toEqual({ error: 'Enter a positive diameter.' });
  });

  it('writes table counterbores implicitly and edited ones explicitly', () => {
    const { panel, tab, type, hidden } = openPanel();
    tab('style-tabs', 'Counterbore');
    expect(hidden('cbore-rows')).toBe(false);
    expect(panel.values()).toMatchObject({ style: { kind: 'counterbore', diameter: null, depth: null } });
    type('cbore-depth', '7.5');
    expect(panel.values()).toMatchObject({ style: { kind: 'counterbore', diameter: 11, depth: 7.5 } });
  });

  it('always writes a drilled hole\'s countersink explicitly', () => {
    const { panel, tab, select, type } = openPanel();
    tab('style-tabs', 'Countersink');
    select('type', 'drilled');
    type('diameter', '5');
    type('csink-diameter', '10');
    expect(panel.values()).toMatchObject({ style: { kind: 'countersink', diameter: 10, angle: 90 } });
  });

  it('carries the blind depth and the drill point, with 0 meaning a flat bottom', () => {
    const { panel, select, type, hidden } = openPanel();
    select('termination', 'blind');
    expect(hidden('blind-rows')).toBe(false);
    type('depth', '12');
    expect(panel.values()).toMatchObject({ depth: 12, tipAngle: 118 });
    type('tip-angle', '0');
    expect(panel.values()).toMatchObject({ depth: 12, tipAngle: null });
    type('depth', '-1');
    expect(panel.values()).toEqual({ error: 'Enter a positive depth.' });
  });

  it('lists metric and imperial sizes in one grouped dropdown', () => {
    const { panel, select, input, listed } = openPanel();
    const sizes = listed('size');
    expect(sizes.groups).toEqual(['Metric', 'Imperial']);
    expect(sizes.options).toContain('M6');
    expect(sizes.options).toContain('1/4');
    select('size', '1/4');
    expect(panel.sizeLabel).toBe('1/4');
    // 0.266 in in a millimetre document.
    expect(input('diameter').value).toBe('6.76');
  });

  it('the size, fit and pitch dropdowns list the parameters their options\' type admits, strings and numbers apart', () => {
    const { panel, container, select, listed } = openPanel();
    for (const role of ['size', 'fit', 'pitch', 'fasten-pitch']) {
      expect(container.querySelector(`[data-role="${role}"]`)!.tagName).toBe('BUTTON');
    }
    for (const role of ['termination', 'type']) {
      expect(container.querySelector(`[data-role="${role}"]`)!.tagName).toBe('SELECT');
    }
    panel.setScopeVariables(VARIABLES);
    expect(listed('size').parameters).toEqual(['holeSize', 'fit', 'finish']);
    expect(listed('fit').parameters).toEqual(['holeSize', 'fit', 'finish']);
    select('type', 'tapped');
    expect(listed('pitch')).toMatchObject({ groups: ['Coarse', 'Fine'], options: ['1 mm', '0.75 mm'], parameters: ['pitch', 'depth'] });
  });

  it('a size bound to a parameter behaves as its value: pitch list, table diameter, entry seeds and the ghost follow; the request names it', () => {
    const { panel, input, select, pick, binding, listed, tab } = openPanel();
    panel.setScopeVariables(VARIABLES);
    tab('style-tabs', 'Counterbore');
    pick('size', 'holeSize');
    expect(binding('size')).toEqual({ name: 'holeSize', value: 'M8' });
    expect(panel.sizeLabel).toBe('M8');
    expect(input('diameter').value).toBe(String(tableDiameter('M8', 'clearance', { fit: 'normal' })));
    expect(input('cbore-diameter').value).toBe('15');
    expect(panel.ghostNumbers()).toMatchObject({ diameter: 9, counterbore: { diameter: 15, depth: 9 } });
    expect(panel.values()).toMatchObject({
      size: { kind: 'fastener', label: { ref: 'holeSize' } },
      fastener: { type: 'clearance', fit: 'normal' },
      style: { kind: 'counterbore', diameter: null, depth: null },
      newVariables: undefined,
    });
    pick('fit', 'fit');
    expect(input('diameter').value).toBe('8.4');
    expect(panel.values()).toMatchObject({ fastener: { type: 'clearance', fit: { ref: 'fit' } } });
    // The pitch list is M8's; a bound pitch always writes the argument, a chosen coarse one none.
    select('type', 'tapped');
    expect(listed('pitch').options).toEqual(['1.25 mm', '1 mm']);
    expect(panel.values()).toMatchObject({ fastener: { type: 'tapped', pitch: null } });
    pick('pitch', 'pitch');
    expect(binding('pitch')).toEqual({ name: 'pitch', value: '1 mm' });
    expect(input('diameter').value).toBe('7');
    expect(panel.values()).toMatchObject({ size: { kind: 'fastener', label: { ref: 'holeSize' } }, fastener: { type: 'tapped', pitch: { ref: 'pitch' } } });
    // Choosing an option again unbinds.
    select('size', 'M6');
    expect(panel.values()).toMatchObject({ size: { kind: 'fastener', label: 'M6' } });
  });

  it('a bound name with no value draws no ghost and keeps an untouched entry on the tables; a value no option carries blocks Apply', () => {
    const { panel, input, binding, tab } = openPanel();
    tab('style-tabs', 'Counterbore');
    const parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }> = {
      feature: 'hole',
      size: { kind: 'fastener', label: { ref: 'mystery' } },
      fastener: { type: 'clearance', fit: 'normal' },
      style: { kind: 'counterbore', diameter: null, depth: null },
      depth: null, tipAngle: null, placementTexts: ['bolt'], placementRefs: [null], scopeTexts: [], scopeRefs: [],
    };
    panel.showEdit(parsed);
    expect(binding('size')).toEqual({ name: 'mystery', value: undefined });
    expect(panel.sizeLabel).toBeNull();
    expect(panel.ghostNumbers()).toBeNull();
    expect(input('fasten-size').value).toBe('mystery');
    // The file judges an unknown value: the statement writes the name and `.counterbore()` left to the tables.
    expect(panel.values()).toMatchObject({ size: { kind: 'fastener', label: { ref: 'mystery' } }, style: { kind: 'counterbore', diameter: null, depth: null } });
    panel.setScopeVariables([{ name: 'mystery', initializer: "'M99'", numeric: false, value: 'M99' }]);
    expect(binding('size')).toEqual({ name: 'mystery', value: "'M99'" });
    expect(panel.values()).toEqual({ error: "Size: mystery is 'M99', which is not one of the options." });
    expect(panel.ghostNumbers()).toBeNull();
  });

  it('declares a new select parameter over the size shown, with the row\'s options', () => {
    const { panel, open, popover, binding } = openPanel();
    panel.setScopeVariables(VARIABLES);
    open('size');
    const box = popover()!.querySelector<HTMLInputElement>('input[type="search"]')!;
    box.value = 'boltSize';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.body.querySelector<HTMLElement>('[data-parameter="boltSize"][data-new="true"]')!.click();
    expect(binding('size')).toEqual({ name: 'boltSize', value: 'M6' });
    const values = panel.values();
    expect(values).toMatchObject({ size: { kind: 'fastener', label: { ref: 'boltSize' } } });
    const declared = 'newVariables' in values ? values.newVariables! : [];
    expect(declared).toHaveLength(1);
    expect(declared[0].name).toBe('boltSize');
    expect(declared[0].initializer.startsWith("param('boltSize', 'M6', 'select', { options: [{ label: 'M")).toBe(true);
    expect(declared[0].initializer).toContain("{ label: 'M6', value: 'M6' }");
    expect(declared[0].initializer).toContain("{ label: '1/4', value: '1/4' }");
  });

  it('prefills bound slots from a parsed statement and resolves them when the variables arrive', () => {
    const { panel, input, binding, listed } = openPanel();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }> = {
      feature: 'hole',
      size: { kind: 'fastener', label: { ref: 'holeSize' } },
      fastener: { type: 'tapped', pitch: { ref: 'pitch' } },
      style: null, depth: null, tipAngle: null, placementTexts: ['bolt'], placementRefs: [null], scopeTexts: [], scopeRefs: [],
    };
    panel.showEdit(parsed);
    expect(panel.holeType).toBe('tapped');
    expect(binding('pitch')).toEqual({ name: 'pitch', value: undefined });
    expect(listed('pitch').options).toEqual([]);
    expect(panel.values()).toMatchObject({ size: { kind: 'fastener', label: { ref: 'holeSize' } }, fastener: { type: 'tapped', pitch: { ref: 'pitch' } } });
    panel.setScopeVariables(VARIABLES);
    expect(binding('size')).toEqual({ name: 'holeSize', value: 'M8' });
    expect(binding('pitch')).toEqual({ name: 'pitch', value: '1 mm' });
    expect(listed('pitch').options).toEqual(['1.25 mm', '1 mm']);
    expect(input('diameter').value).toBe('7');
    expect(panel.values()).toMatchObject({ size: { kind: 'fastener', label: { ref: 'holeSize' } }, fastener: { type: 'tapped', pitch: { ref: 'pitch' } }, newVariables: undefined });
  });

  it('prefills from a parsed statement in edit mode', () => {
    const { panel, input, hidden } = openPanel();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }> = {
      feature: 'hole',
      size: { kind: 'fastener', label: '#10' },
      fastener: { type: 'clearance', fit: 'loose' },
      style: { kind: 'countersink', diameter: null, angle: null },
      depth: 8,
      tipAngle: null,
      placementTexts: ['bolt'],
      placementRefs: [{ line: 4, column: 0 }],
      scopeTexts: [],
      scopeRefs: [],
    };
    panel.showEdit(parsed);
    expect(panel.holeType).toBe('clearance');
    expect(panel.sizeLabel).toBe('#10');
    expect(panel.style).toBe('countersink');
    expect(hidden('csink-rows')).toBe(false);
    expect(panel.values()).toMatchObject({
      size: { kind: 'fastener', label: '#10' },
      fastener: { type: 'clearance', fit: 'loose' },
      style: { kind: 'countersink', diameter: null, angle: null },
      depth: 8,
      tipAngle: null,
    });
  });

  it('floats the section beside the dialog and keeps the sheet\'s copy in the body', () => {
    const { container } = openPanel();
    const card = container.querySelector<HTMLElement>('[data-role="side-card"]')!;
    const box = container.querySelector<HTMLElement>('[data-role="box"]')!;
    // Beside the box, not inside its scrolling body.
    expect(card.parentElement).toBe(box.parentElement);
    expect(box.contains(card)).toBe(false);
    expect(card.classList.contains('right-full')).toBe(true);
    expect(card.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('[data-role="illustration"]')!.classList.contains('sm:hidden')).toBe(true);
  });

  it('draws the section with the focused field\'s dimension', () => {
    const { container, input, select } = openPanel();
    const illustration = () => container.querySelector('[data-role="side-card"] svg')!.outerHTML;
    expect(illustration()).toContain('⌀');
    select('termination', 'blind');
    input('depth').dispatchEvent(new Event('focus'));
    expect(illustration()).toContain('>depth<');
    input('depth').dispatchEvent(new Event('blur'));
    expect(illustration()).not.toContain('>depth<');
  });
});
