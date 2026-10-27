// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceControl, type ChoiceControlOptions } from '../src/interactive/create-feature/choice-control';
import type { ChoiceItem } from '../src/ui/controls';
import { ParamDeclareMode, type VariableInfo } from '../src/ui/expression-core';

// The hand-rolled dialogs' dropdown: a plain select without variables, the
// parameters in scope listed under its options with them, a parameter picked
// (or declared) in place of an option, and what the control reads either way.

const SIZES: ChoiceItem<string>[] = [
  { value: 'm3', label: 'M3' },
  { value: 'm4', label: 'M4', description: 'The common one' },
  { value: 'm5', label: 'M5' },
];
const WEIGHTS: ChoiceItem<number>[] = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 700, label: 'Bold' },
];

// The scope as the server lists it: a string param() is `numeric: true` there, so the control goes by `value`.
const VARIABLES: VariableInfo[] = [
  { name: 'holeSize', initializer: "param('holeSize', 'm5', 'select', { options: [] })", numeric: true, value: 'm5' },
  { name: 'finish', initializer: "'matte'", numeric: false, value: 'matte' },
  { name: 'count', initializer: "param('count', 2)", numeric: true, value: 2 },
  { name: 'weight', initializer: '700', numeric: true, value: 700 },
  { name: 'half', initializer: 'depth / 2', numeric: true },
  { name: 'through', initializer: 'true', numeric: false, value: true },
  { name: 'finishing', initializer: "['deburr', 'polish']", numeric: false, value: ['deburr', 'polish'] },
  { name: 'stock', initializer: "'m4'", numeric: false, value: 'm4', global: { file: 'shop.params.js', label: 'Stock size', imported: true } },
  { name: 'body', initializer: 'extrude(profile, 10)', numeric: false },
];

const mounted: ChoiceControl<string | number>[] = [];

afterEach(() => {
  for (const control of mounted.splice(0)) {
    control.destroy();
  }
  document.dispatchEvent(new Event('pointerdown'));
  document.body.innerHTML = '';
  ParamDeclareMode.set(true);
});

function mount<V extends string | number>(items: readonly ChoiceItem<V>[], options: Partial<ChoiceControlOptions<V>> = {}) {
  const control = new ChoiceControl<V>({ items, label: 'Size', dataRole: 'size', ...options });
  mounted.push(control as ChoiceControl<string | number>);
  document.body.appendChild(control.element);
  const onChange = vi.fn();
  control.onChange = onChange;
  const el = control.element;
  const popover = () => document.body.querySelector<HTMLElement>('[data-mode]');
  const parameters = () => [...document.body.querySelectorAll<HTMLElement>('[data-parameter]')];
  return {
    control, onChange, el, popover, parameters,
    open: () => el.click(),
    options: () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]:not([data-parameter])')],
    optionLabels: () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]:not([data-parameter])')].map(o => o.querySelector('.truncate')!.textContent),
    choose: (label: string) => {
      [...document.body.querySelectorAll<HTMLElement>('[role="option"]:not([data-parameter])')].find(o => o.querySelector('.truncate')!.textContent === label)!.click();
    },
    names: () => parameters().filter(row => !row.dataset.new).map(row => row.dataset.parameter),
    offers: () => parameters().filter(row => row.dataset.new).map(row => row.dataset.parameter),
    pick: (name: string) => parameters().find(row => row.dataset.parameter === name)!.click(),
    search: (text: string) => {
      const box = popover()!.querySelector<HTMLInputElement>('input[type="search"]')!;
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    },
    binding: () => ({
      name: el.querySelector('[data-role="parameter"]')?.textContent,
      value: el.querySelector('[data-role="resolved"]')?.textContent,
    }),
  };
}

describe('ChoiceControl without variables', () => {
  it('is the button in the select\'s slot, wearing its data-role, and reads the chosen option', () => {
    const { control, el, open, popover, optionLabels, choose, onChange } = mount(SIZES, { value: 'm4' });
    expect(el.tagName).toBe('BUTTON');
    expect(el.dataset.role).toBe('size');
    expect(el.textContent).toBe('M4');
    expect(el.title).toBe('The common one');
    expect(control.value).toBe('m4');
    expect(control.binding).toBeUndefined();
    expect(control.read()).toEqual({ value: 'm4' });
    open();
    expect(optionLabels()).toEqual(['M3', 'M4', 'M5']);
    expect(popover()!.querySelector('[data-role="parameters"]')).toBeNull();
    expect(popover()!.querySelector('input[type="search"]')).not.toBeNull();
    choose('M5');
    expect(popover()).toBeNull();
    expect(control.value).toBe('m5');
    expect(control.read()).toEqual({ value: 'm5' });
    expect(el.textContent).toBe('M5');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the placeholder and reads an error while nothing is chosen; search can be turned off', () => {
    const { control, el, open, popover } = mount(SIZES, { placeholder: '—', search: false });
    expect(el.textContent).toBe('—');
    expect(control.value).toBeUndefined();
    expect(control.read()).toEqual({ error: 'Size needs a choice.' });
    open();
    expect(popover()!.querySelector('input')).toBeNull();
  });

  it('setValue shows the option (or the placeholder) and fires no change', () => {
    const { control, el, onChange } = mount(SIZES, { value: 'm4' });
    control.setValue('m3');
    expect(el.textContent).toBe('M3');
    expect(control.read()).toEqual({ value: 'm3' });
    control.setValue(undefined);
    expect(control.value).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ChoiceControl with variables', () => {
  it('lists the compatible parameters under the options — by the type of their value, never by numeric — and hides the rest', () => {
    const { control, open, popover, names, parameters } = mount(SIZES, { value: 'm4' });
    control.setVariables(VARIABLES);
    open();
    expect(names()).toEqual(['holeSize', 'finish', 'stock']);
    expect(popover()!.querySelector('[data-role="parameters"]')!.previousElementSibling!.textContent).toBe('Parameters');
    const [hole, finish, stock] = parameters();
    expect(hole.querySelector('[data-role="chip"]')!.textContent).toBe('P');
    expect(hole.querySelector('[data-role="resolved"]')!.textContent).toBe('M5');
    expect(finish.querySelector('[data-role="chip"]')!.textContent).toBe('V');
    expect(finish.querySelector('[data-role="resolved"]')!.textContent).toBe("'matte'");
    expect(finish.querySelector<HTMLElement>('[data-role="resolved"]')!.title).toBe("finish is 'matte', which is not one of the options.");
    expect(stock.querySelector('[data-role="chip"]')!.textContent).toBe('G');
    expect(stock.querySelector('[data-role="parameter-label"]')!.textContent).toBe('Stock size');
    expect(stock.querySelector('[data-role="resolved"]')!.textContent).toBe('M4');
    control.close();

    const weights = mount(WEIGHTS, { value: 400, label: 'Weight', dataRole: 'weight' });
    weights.control.setVariables(VARIABLES);
    weights.open();
    expect(weights.names()).toEqual(['count', 'weight']);
    expect(weights.parameters()[1].querySelector('[data-role="resolved"]')!.textContent).toBe('Bold');
    expect(weights.parameters()[0].querySelector('[data-role="resolved"]')!.textContent).toBe('2');
  });

  it('a parameter picked stands in for the option: the button shows its name and what it selects, read gives the reference and the value', () => {
    const { control, open, pick, choose, binding, el, onChange, popover } = mount(SIZES, { value: 'm4' });
    control.setVariables(VARIABLES);
    open();
    pick('holeSize');
    expect(popover()).toBeNull();
    expect(binding()).toEqual({ name: 'holeSize', value: 'M5' });
    expect(el.querySelector('[data-role="parameter"]')!.className).toContain('font-mono');
    expect(el.querySelector('[data-role="resolved"]')!.className).toContain('text-base-content/50');
    expect(control.binding).toEqual({ ref: 'holeSize' });
    expect(control.value).toBe('m5');
    expect(control.read()).toEqual({ ref: 'holeSize', value: 'm5' });
    expect(onChange).toHaveBeenCalledTimes(1);
    // The bound row is marked on reopening; choosing an option again unbinds.
    open();
    expect(document.body.querySelector('[data-parameter="holeSize"]')!.getAttribute('aria-selected')).toBe('true');
    choose('M3');
    expect(control.binding).toBeUndefined();
    expect(control.read()).toEqual({ value: 'm3' });
    expect(el.textContent).toBe('M3');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('setRef binds before the variables arrive and resolves once they do, or at once when they are there — no change fires', () => {
    const { control, binding, el, onChange } = mount(SIZES, { value: 'm4' });
    control.setRef('holeSize');
    expect(binding()).toEqual({ name: 'holeSize', value: undefined });
    expect(el.querySelector('[data-role="chip"]')).toBeNull();
    expect(control.binding).toEqual({ ref: 'holeSize' });
    expect(control.value).toBeUndefined();
    expect(control.read()).toEqual({ ref: 'holeSize' });
    control.setVariables(VARIABLES);
    expect(binding()).toEqual({ name: 'holeSize', value: 'M5' });
    expect(control.value).toBe('m5');
    expect(control.read()).toEqual({ ref: 'holeSize', value: 'm5' });

    const other = mount(SIZES, { value: 'm4' });
    other.control.setVariables(VARIABLES);
    other.control.setRef('stock');
    expect(other.binding()).toEqual({ name: 'stock', value: 'M4' });
    expect(other.control.read()).toEqual({ ref: 'stock', value: 'm4' });
    expect(other.el.title).toBe('Stock size');
    expect(onChange).not.toHaveBeenCalled();
    expect(other.onChange).not.toHaveBeenCalled();
  });

  it('a variable whose value no option carries shows the warning and reads the error, with the row label first', () => {
    const { control, el, binding } = mount(SIZES, { value: 'm4' });
    control.setVariables(VARIABLES);
    control.setRef('finish');
    expect(binding()).toEqual({ name: 'finish', value: "'matte'" });
    expect(el.querySelector('[data-role="resolved"]')!.className).toContain('text-warning');
    expect(el.title).toBe("finish is 'matte', which is not one of the options.");
    expect(control.value).toBeUndefined();
    expect(control.read()).toEqual({ error: "Size: finish is 'matte', which is not one of the options." });
    // A variable of unknown value binds without a word: the file is the judge.
    control.setRef('half');
    expect(control.read()).toEqual({ ref: 'half' });
    expect(binding()).toEqual({ name: 'half', value: undefined });
  });

  it('offers to declare a parameter of a fresh name over the option shown — a param() with the P toggle on, the literal with it off', () => {
    const { control, open, search, names, offers, parameters, pick, binding, onChange } = mount(SIZES, { value: 'm4' });
    control.setVariables(VARIABLES);
    open();
    search('boltSize');
    expect(names()).toEqual([]);
    expect(offers()).toEqual(['boltSize']);
    const offer = parameters()[0];
    expect(offer.querySelector('[data-role="new"]')!.textContent).toBe('new');
    expect(offer.querySelector('[data-role="chip"]')!.textContent).toBe('P');
    expect(offer.querySelector('[data-role="resolved"]')!.textContent).toBe('M4');
    pick('boltSize');
    expect(binding()).toEqual({ name: 'boltSize', value: 'M4' });
    expect(control.value).toBe('m4');
    expect(control.read()).toEqual({
      ref: 'boltSize',
      value: 'm4',
      newVariable: {
        name: 'boltSize',
        initializer: "param('boltSize', 'm4', 'select', { options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }, { label: 'M5', value: 'm5' }] })",
      },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    // Declared, it is a name the control knows: no second offer.
    open();
    search('boltSize');
    expect(parameters()).toEqual([]);
    control.close();

    ParamDeclareMode.set(false);
    const weights = mount(WEIGHTS, { value: 700, label: 'Weight', dataRole: 'weight' });
    weights.control.setVariables(VARIABLES);
    weights.open();
    weights.search('heft');
    expect(weights.parameters()[0].querySelector('[data-role="chip"]')!.textContent).toBe('V');
    weights.pick('heft');
    expect(weights.control.read()).toEqual({ ref: 'heft', value: 700, newVariable: { name: 'heft', initializer: '700' } });
    expect(weights.binding()).toEqual({ name: 'heft', value: 'Bold' });
    // An option chosen again drops the declaration with the name.
    weights.open();
    weights.choose('Regular');
    expect(weights.control.read()).toEqual({ value: 400 });
  });

  it('offers no declaration over text that matches an option or a variable, is no valid name, or where nothing is shown', () => {
    const { control, open, search, offers, names } = mount(SIZES, { value: 'm4' });
    control.setVariables(VARIABLES);
    open();
    search('m5');
    expect(offers()).toEqual([]);
    search('holeSize');
    expect(names()).toEqual(['holeSize']);
    expect(offers()).toEqual([]);
    search('bolt size');
    expect(offers()).toEqual([]);
    search('class');
    expect(offers()).toEqual([]);
    control.close();
    const empty = mount(SIZES);
    empty.control.setVariables(VARIABLES);
    empty.open();
    empty.search('boltSize');
    expect(empty.offers()).toEqual([]);
  });

  it('setItems keeps a binding, re-resolved against the new options, and a chosen value only while an item carries it', () => {
    const { control, binding, onChange } = mount(SIZES, { value: 'm4' });
    control.setVariables(VARIABLES);
    control.setRef('holeSize');
    control.setItems([{ value: 'm5', label: 'M5 (coarse)' }, { value: 'm6', label: 'M6' }]);
    expect(control.binding).toEqual({ ref: 'holeSize' });
    expect(binding()).toEqual({ name: 'holeSize', value: 'M5 (coarse)' });
    expect(control.read()).toEqual({ ref: 'holeSize', value: 'm5' });
    control.setItems([{ value: 'm6', label: 'M6' }]);
    expect(control.binding).toEqual({ ref: 'holeSize' });
    expect(control.read()).toEqual({ error: "Size: holeSize is 'm5', which is not one of the options." });

    control.setValue('m6');
    control.setItems([{ value: 'm6', label: 'M6' }, { value: 'm8', label: 'M8' }]);
    expect(control.read()).toEqual({ value: 'm6' });
    control.setItems([{ value: 'm8', label: 'M8' }]);
    expect(control.value).toBeUndefined();
    expect(control.read()).toEqual({ error: 'Size needs a choice.' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('setValue lets a binding go without a change; only the user\'s choices fire one', () => {
    const { control, open, pick, choose, onChange } = mount(SIZES, { value: 'm4' });
    control.setVariables(VARIABLES);
    control.setRef('holeSize');
    control.setValue('m3');
    expect(control.binding).toBeUndefined();
    expect(control.read()).toEqual({ value: 'm3' });
    expect(onChange).not.toHaveBeenCalled();
    open();
    pick('stock');
    expect(onChange).toHaveBeenCalledTimes(1);
    open();
    choose('M4');
    expect(onChange).toHaveBeenCalledTimes(2);
    control.setVariables([]);
    control.setItems(SIZES);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
