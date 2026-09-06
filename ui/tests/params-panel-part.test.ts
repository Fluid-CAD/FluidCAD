// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Parameters panel's Part dropdown: the part a new parameter is declared
// in. It follows the timeline's active part until the user picks another,
// hands that choice to the Add dialog, and survives the list re-rendering.

import { ParamsPanel } from '../src/ui/params-panel';
import type { ParamEditorDialog, PartChoices } from '../src/ui/param-editor-dialog';
import type { EngineClient } from '../src/engine-client';
import type { UIParamDefinition } from '../src/types';

// jsdom ships no CSS.escape; the in-place value update path uses it.
if (typeof globalThis.CSS === 'undefined') {
  (globalThis as any).CSS = { escape: (value: string) => value };
}

const FILE = '/ws/model.fluid.js';
const bracket = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
const lid = { name: 'Lid', sourceLocation: { filePath: FILE, line: 13, column: 0 } };
const base = { name: 'Base', sourceLocation: { filePath: FILE, line: 23, column: 0 } };

function param(label: string, part?: { sourceLocation: { filePath: string; line: number; column: number } }): UIParamDefinition {
  return {
    label, defaultValue: 10, currentValue: 10, controlType: 'number',
    ...(part ? { part: part.sourceLocation } : {}),
  };
}

function mount(choices: () => PartChoices) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const client = { setParam: vi.fn(), resetParams: vi.fn() } as unknown as EngineClient;
  const editor = { openForCreate: vi.fn(), openForEdit: vi.fn() } as unknown as ParamEditorDialog;
  const panel = new ParamsPanel(host, client, editor);
  panel.setPartProvider(choices);
  const select = () => host.querySelector<HTMLSelectElement>('[data-param-part]');
  const add = () => host.querySelector<HTMLButtonElement>('[data-add-param]')!;
  return { host, panel, editor, select, add };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ParamsPanel part dropdown', () => {
  it('lists the parts, on the active part, above the controls', () => {
    const { panel, host, select } = mount(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
    panel.update([param('Width', lid)]);
    // Parts only: a parameter lives inside a part body, so there is no file level to add to.
    expect(Array.from(select()!.options, (o) => o.textContent)).toEqual(['Bracket', 'Lid']);
    expect(select()!.selectedOptions[0].textContent).toBe('Lid');
    // The dropdown row precedes the first control in the body.
    const order = Array.from(host.querySelectorAll('[data-param-part], [data-param-label]'));
    expect(order[0]).toBe(select());
  });

  it('opens the Add dialog on the active part, or on the part the user picked', () => {
    const { panel, editor, select, add } = mount(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
    panel.update([param('Width')]);
    add().click();
    expect(vi.mocked(editor.openForCreate)).toHaveBeenLastCalledWith(lid.sourceLocation);

    select()!.value = '0';
    select()!.dispatchEvent(new Event('change'));
    add().click();
    expect(vi.mocked(editor.openForCreate)).toHaveBeenLastCalledWith(bracket.sourceLocation);
  });

  it('keeps the pick across a re-render, even when the part moved lines', () => {
    let choices: PartChoices = { parts: [bracket, lid], active: lid.sourceLocation };
    const { panel, select } = mount(() => choices);
    panel.update([param('Width')]);
    select()!.value = '0';
    select()!.dispatchEvent(new Event('change'));

    // A declaration added above Bracket shifts every statement down two lines.
    const movedBracket = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 5, column: 0 } };
    const movedLid = { name: 'Lid', sourceLocation: { filePath: FILE, line: 15, column: 0 } };
    choices = { parts: [movedBracket, movedLid], active: movedLid.sourceLocation };
    panel.update([param('Width'), param('Depth')]);
    expect(select()!.selectedOptions[0].textContent).toBe('Bracket');
    expect(panel.selectedPart).toEqual(movedBracket.sourceLocation);
  });

  it('follows the active part again once it changes', () => {
    let choices: PartChoices = { parts: [bracket, lid, base], active: lid.sourceLocation };
    const { panel, select } = mount(() => choices);
    panel.update([param('Width')]);
    select()!.value = '2';
    select()!.dispatchEvent(new Event('change'));
    expect(panel.selectedPart).toEqual(base.sourceLocation);

    // A timeline click makes Bracket active: the panel syncs without a render
    // and the pick gives way to it.
    choices = { parts: [bracket, lid, base], active: bracket.sourceLocation };
    panel.syncParts();
    expect(select()!.selectedOptions[0].textContent).toBe('Bracket');
    expect(panel.selectedPart).toEqual(bracket.sourceLocation);
  });

  it('falls back to the active part when the picked one leaves the scene', () => {
    let choices: PartChoices = { parts: [bracket, lid], active: lid.sourceLocation };
    const { panel, select } = mount(() => choices);
    panel.update([param('Width')]);
    select()!.value = '0';
    select()!.dispatchEvent(new Event('change'));

    choices = { parts: [lid], active: lid.sourceLocation };
    panel.update([param('Width')]);
    expect(select()!.selectedOptions[0].textContent).toBe('Lid');
    expect(panel.selectedPart).toEqual(lid.sourceLocation);
  });

  it('hides the row and the + when the scene has no parts, and shows them with no params yet', () => {
    let choices: PartChoices = { parts: [], active: null };
    const { panel, host, select, add } = mount(() => choices);
    panel.update([param('Width')]);
    expect(select()).toBeNull();
    expect(panel.selectedPart).toBeNull();
    // Nowhere to declare one: the + goes with the dropdown.
    expect(add().hidden).toBe(true);

    choices = { parts: [bracket], active: bracket.sourceLocation };
    panel.update([]);
    expect(select()).not.toBeNull();
    expect(add().hidden).toBe(false);
    expect(host.textContent).toContain('No parameters in Bracket yet');
  });

  it("lists only the selected part's parameters", () => {
    const { panel, host, select } = mount(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
    const labels = () => Array.from(host.querySelectorAll('[data-param-label]'), (el) => (el as HTMLElement).dataset.paramLabel);
    // `Shared` carries no part (an assembly body's) — never a part's row.
    panel.update([param('Shared'), param('Width', bracket), param('Height', bracket), param('Bore', lid)]);
    expect(labels()).toEqual(['Bore']);

    select()!.value = '0';
    select()!.dispatchEvent(new Event('change'));
    expect(labels()).toEqual(['Width', 'Height']);
  });

  it('shows everything when the scene has no parts', () => {
    const { panel, host } = mount(() => ({ parts: [], active: null }));
    panel.update([param('Shared'), param('Width', bracket)]);
    expect(host.querySelectorAll('[data-param-label]')).toHaveLength(2);
  });

  it('re-filters when a timeline click moves the active part', () => {
    let choices: PartChoices = { parts: [bracket, lid], active: lid.sourceLocation };
    const { panel, host } = mount(() => choices);
    const labels = () => Array.from(host.querySelectorAll('[data-param-label]'), (el) => (el as HTMLElement).dataset.paramLabel);
    panel.update([param('Width', bracket), param('Bore', lid)]);
    expect(labels()).toEqual(['Bore']);

    choices = { parts: [bracket, lid], active: bracket.sourceLocation };
    panel.syncParts();
    expect(labels()).toEqual(['Width']);
  });

  it('names the part in the empty state when it has no parameters', () => {
    const { panel, host, select } = mount(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
    panel.update([param('Width', bracket)]);
    expect(host.textContent).toContain('No parameters in Lid yet');
    select()!.value = '0';
    select()!.dispatchEvent(new Event('change'));
    expect(host.textContent).not.toContain('No parameters');
  });

  it('points at a part body in the empty state of a scene with no parts', () => {
    const { panel, host } = mount(() => ({ parts: [], active: null }));
    panel.update([]);
    expect(host.textContent).toContain('inside a part() body');
  });

  it('updates values in place within the filtered view', () => {
    const { panel, host } = mount(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
    panel.update([param('Width', bracket), param('Bore', lid)]);
    const input = host.querySelector<HTMLInputElement>('[data-param-label="Bore"]')!;
    panel.update([param('Width', bracket), { ...param('Bore', lid), currentValue: 42 }]);
    // Same element, new value: the list was not rebuilt under the user.
    expect(host.querySelector('[data-param-label="Bore"]')).toBe(input);
    expect(input.value).toBe('42');
  });
});
