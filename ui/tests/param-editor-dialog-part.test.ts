// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Add-parameter dialog's Part dropdown: a new declaration goes into a
// part's callback body, the timeline's selected part by default. The dropdown
// lists parts only — a parameter lives inside a part body — shows only when
// the scene has parts, and never while editing an existing declaration.

vi.mock('../src/api', () => ({
  addParam: vi.fn(async () => ({ success: true })),
  updateParam: vi.fn(async () => ({ success: true })),
  removeParam: vi.fn(async () => ({ success: true })),
  getParamUsage: vi.fn(async () => null),
}));

import { addParam } from '../src/api';
import { ParamEditorDialog } from '../src/ui/param-editor-dialog';
import type { UIParamDefinition } from '../src/types';

const FILE = '/ws/model.fluid.js';
const bracket = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
const lid = { name: 'Lid', sourceLocation: { filePath: FILE, line: 13, column: 0 } };

function mount(): { dialog: ParamEditorDialog; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { dialog: new ParamEditorDialog(root), root };
}

function partRow(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('[data-ref="part-row"]')!;
}

function partSelect(root: HTMLElement): HTMLSelectElement {
  return root.querySelector<HTMLSelectElement>('[data-ref="part"]')!;
}

function labelInput(root: HTMLElement): HTMLInputElement {
  return root.querySelector<HTMLInputElement>('[data-ref="label"]')!;
}

async function save(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
  await vi.waitFor(() => expect(vi.mocked(addParam)).toHaveBeenCalled());
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ParamEditorDialog part dropdown', () => {
  it('creates assembly parameters without showing a part selector', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const dialog = new ParamEditorDialog(root, 'assembly');
    dialog.setPartProvider(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    dialog.openForCreate();
    expect(partRow(root).classList.contains('hidden')).toBe(true);
    labelInput(root).value = 'Assembly width';
    await save(root);
    expect(addParam).toHaveBeenCalledWith(expect.objectContaining({ label: 'Assembly width' }), null, 'assembly');
  });

  it('lists the parts and opens on the selected part', () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));
    dialog.openForCreate();

    expect(partRow(root).classList.contains('hidden')).toBe(false);
    const options = Array.from(partSelect(root).options, (o) => o.textContent);
    expect(options).toEqual(['Bracket', 'Lid']);
    expect(partSelect(root).selectedOptions[0].textContent).toBe('Lid');
  });

  it('sends the selected part with the new declaration', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));
    dialog.openForCreate();
    labelInput(root).value = 'Depth';
    await save(root);

    expect(vi.mocked(addParam)).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Depth' }),
      lid.sourceLocation,
      'part',
      false,
    );
  });

  it('sends whichever part the user picks instead', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));

    dialog.openForCreate();
    labelInput(root).value = 'Depth';
    partSelect(root).value = '0';
    await save(root);
    expect(vi.mocked(addParam)).toHaveBeenLastCalledWith(expect.anything(), bracket.sourceLocation, 'part', false);
  });

  it('opens on the part the panel hands it', () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));
    dialog.openForCreate(bracket.sourceLocation);
    expect(partSelect(root).selectedOptions[0].textContent).toBe('Bracket');
  });

  it('hides the dropdown when the scene has no parts and sends no part, which the server refuses', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [], selected: null }));
    dialog.openForCreate();
    expect(partRow(root).classList.contains('hidden')).toBe(true);
    labelInput(root).value = 'Depth';
    await save(root);
    expect(vi.mocked(addParam)).toHaveBeenLastCalledWith(expect.anything(), null, 'part', false);
  });

  it('re-reads the parts on every open, so a re-render is reflected', () => {
    const { dialog, root } = mount();
    let choices = { parts: [bracket], selected: bracket.sourceLocation };
    dialog.setPartProvider(() => choices);
    dialog.openForCreate();
    expect(Array.from(partSelect(root).options, (o) => o.textContent)).toEqual(['Bracket']);

    choices = { parts: [bracket, lid], selected: lid.sourceLocation };
    dialog.openForCreate();
    expect(Array.from(partSelect(root).options, (o) => o.textContent)).toEqual(['Bracket', 'Lid']);
    expect(partSelect(root).selectedOptions[0].textContent).toBe('Lid');
  });

  it('tells two parts with the same name apart by line', () => {
    const { dialog, root } = mount();
    const twin = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 20, column: 0 } };
    dialog.setPartProvider(() => ({ parts: [bracket, twin], selected: bracket.sourceLocation }));
    dialog.openForCreate();
    expect(Array.from(partSelect(root).options, (o) => o.textContent))
      .toEqual(['Bracket (line 3)', 'Bracket (line 20)']);
  });

  it('never shows the dropdown while editing an existing declaration', () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));
    dialog.openForCreate();
    expect(partRow(root).classList.contains('hidden')).toBe(false);

    const def: UIParamDefinition = {
      label: 'Width', defaultValue: 10, currentValue: 10, controlType: 'number',
      sourceLocation: { filePath: FILE, line: 4, column: 2 },
    };
    dialog.openForEdit(def);
    expect(partRow(root).classList.contains('hidden')).toBe(true);
  });
});

// "Expose as property": a new part parameter can also be published as a
// property of the same name in the same edit. Off by default, an add-time
// choice only — never offered while editing, never in assembly scope.
describe('ParamEditorDialog expose-as-property toggle', () => {
  function exposeRow(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>('[data-ref="expose-row"]')!;
  }
  function exposeToggle(root: HTMLElement): HTMLInputElement {
    return root.querySelector<HTMLInputElement>('[data-ref="expose"]')!;
  }

  it('shows the toggle off when adding a part parameter', () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    dialog.openForCreate();
    expect(exposeRow(root).classList.contains('hidden')).toBe(false);
    expect(exposeToggle(root).checked).toBe(false);
  });

  it('sends the flag with the new declaration when switched on', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    dialog.openForCreate();
    labelInput(root).value = 'Wall thickness';
    exposeToggle(root).checked = true;
    await save(root);
    expect(vi.mocked(addParam)).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: 'Wall thickness' }),
      bracket.sourceLocation,
      'part',
      true,
    );
  });

  it('resets to off on the next open', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    dialog.openForCreate();
    labelInput(root).value = 'A';
    exposeToggle(root).checked = true;
    await save(root);
    dialog.openForCreate();
    expect(exposeToggle(root).checked).toBe(false);
  });

  it('is absent while editing an existing declaration', () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    dialog.openForEdit({ label: 'Width', value: 100, defaultValue: 100, type: 'number', sourceLocation: bracket.sourceLocation } as UIParamDefinition);
    expect(exposeRow(root).classList.contains('hidden')).toBe(true);
  });

  it('is absent in assembly scope, where a property has no home', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const dialog = new ParamEditorDialog(root, 'assembly');
    dialog.openForCreate();
    expect(exposeRow(root).classList.contains('hidden')).toBe(true);
  });
});
