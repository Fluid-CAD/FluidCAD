// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ParamForm } from '../src/ui/param-controls';
import { ParamDeclareMode } from '../src/ui/expression-core';
import type { CatalogParamDef } from '../src/api';

const forms: ParamForm[] = [];
const variables = [{ name: 'width', initializer: "param('Width', 100)", numeric: true }];
const number: CatalogParamDef = { label: 'Length', defaultValue: 50, currentValue: 50, controlType: 'number' };
function mount(defs = [number], seeds: Record<string, string> = {}, resettable = false): ParamForm {
  const form = new ParamForm(defs, { expressions: { seeds, variables }, resettable });
  forms.push(form);
  document.body.append(form.element);
  return form;
}
function type(form: ParamForm, value: string) {
  const input = form.element.querySelector<HTMLInputElement>('input[type="text"]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
afterEach(() => {
  forms.splice(0).forEach(form => form.destroy());
  ParamDeclareMode.set(false);
});

describe('instance parameter expressions', () => {
  it('commits assembly references as source expressions and leaves defaults untouched', () => {
    const form = mount();
    expect(form.commitChanges()).toEqual({ set: {} });
    type(form, 'width / 2');
    expect(form.commitChanges()).toEqual({ set: { Length: { expr: 'width / 2' } } });
  });

  it('preserves seeded source expressions when untouched and supports resetting them', () => {
    const form = mount([number], { Length: 'width / 2' }, true);
    expect(form.element.querySelector('input')!.value).toBe('width / 2');
    expect(form.commitChanges()).toEqual({ set: {} });
    form.element.querySelector<HTMLButtonElement>('button[title="Reset to default"]')!.click();
    expect(form.resetLabels()).toEqual(['Length']);
    expect(form.commitChanges()).toEqual({ set: {} });
    type(form, 'width');
    expect(form.resetLabels()).toEqual([]);
    expect(form.commitChanges()).toEqual({ set: { Length: { expr: 'width' } } });
  });

  it('collects parameter declarations and rejects empty expressions', () => {
    const form = mount();
    ParamDeclareMode.set(true);
    type(form, 'depth = 75');
    expect(form.commitChanges()).toEqual({
      set: { Length: { expr: 'depth' } },
      newVariables: [{ name: 'depth', initializer: "param('depth', 75)" }],
    });
    type(form, '');
    expect(form.commitChanges()).toEqual({ error: 'Length: enter a value' });
  });

  it.each(['slider', 'text', 'checkbox', 'select', 'color'] as const)('allows %s controls to reference a parameter', controlType => {
    const form = mount([{ ...number, controlType }]);
    const toggle = form.element.querySelector<HTMLButtonElement>('button[title="Use an expression"]')!;
    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    type(form, 'width');
    expect(form.commitChanges()).toEqual({ set: { Length: { expr: 'width' } } });
    toggle.click();
    expect(form.commitChanges()).toEqual({ set: {} });
    toggle.click();
    expect(form.commitChanges()).toEqual({ set: { Length: { expr: 'width' } } });
  });

  it('replaces an existing nonnumeric expression with a literal even when its resolved value is unchanged', () => {
    const form = mount([{ label: 'Color', defaultValue: 'red', currentValue: 'blue', controlType: 'text' }], { Color: 'frameColor' });
    form.element.querySelector<HTMLButtonElement>('button[title="Use an expression"]')!.click();
    expect(form.commitChanges()).toEqual({ set: { Color: 'blue' } });
  });

  it('keeps literal strings distinct from expressions', () => {
    const form = mount([{ label: 'Name', defaultValue: 'beam', currentValue: 'beam', controlType: 'text' }]);
    type(form, 'width');
    expect(form.commitChanges()).toEqual({ set: { Name: 'width' } });
  });

  it('preserves a new declaration when switching expression mode off and back on', () => {
    const form = mount([{ ...number, controlType: 'slider' }]);
    const toggle = form.element.querySelector<HTMLButtonElement>('button[title="Use an expression"]')!;
    ParamDeclareMode.set(false);
    toggle.click();
    type(form, 'depth = 75');
    toggle.click();
    toggle.click();
    expect(form.commitChanges()).toEqual({
      set: { Length: { expr: 'depth' } }, newVariables: [{ name: 'depth', initializer: '75' }],
    });
  });

  it('refuses conflicting declarations from different rows', () => {
    const form = mount([number, { ...number, label: 'Depth' }]);
    form.element.querySelectorAll<HTMLInputElement>('input').forEach((input, index) => {
      input.value = `size = ${50 + index}`;
    });
    expect(form.commitChanges()).toEqual({ error: 'Conflicting values for size. Use distinct variable names.' });
  });
});
