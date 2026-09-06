// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Add-parameter dialog's Part dropdown: a new declaration goes into a
// part's callback body, the timeline's active part by default. The dropdown
// only shows when the scene has parts, keeps the file's top level reachable
// as its last entry, and never shows while editing an existing declaration.

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
  it('lists the parts plus the file level and opens on the active part', () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
    dialog.openForCreate();

    expect(partRow(root).classList.contains('hidden')).toBe(false);
    const options = Array.from(partSelect(root).options, (o) => o.textContent);
    expect(options).toEqual(['Bracket', 'Lid', 'File (top level)']);
    expect(partSelect(root).selectedOptions[0].textContent).toBe('Lid');
  });

  it('sends the active part with the new declaration', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
    dialog.openForCreate();
    labelInput(root).value = 'Depth';
    await save(root);

    expect(vi.mocked(addParam)).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Depth' }),
      lid.sourceLocation,
    );
  });

  it('sends whichever part the user picks instead, or none for the file level', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));

    dialog.openForCreate();
    labelInput(root).value = 'Depth';
    partSelect(root).value = '0';
    await save(root);
    expect(vi.mocked(addParam)).toHaveBeenLastCalledWith(expect.anything(), bracket.sourceLocation);

    dialog.openForCreate();
    labelInput(root).value = 'Depth';
    partSelect(root).value = 'file';
    await save(root);
    expect(vi.mocked(addParam)).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  it('hides the dropdown when the scene has no parts and declares at top level', async () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [], active: null }));
    dialog.openForCreate();
    expect(partRow(root).classList.contains('hidden')).toBe(true);
    labelInput(root).value = 'Depth';
    await save(root);
    expect(vi.mocked(addParam)).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  it('re-reads the parts on every open, so a re-render is reflected', () => {
    const { dialog, root } = mount();
    let choices = { parts: [bracket], active: bracket.sourceLocation };
    dialog.setPartProvider(() => choices);
    dialog.openForCreate();
    expect(Array.from(partSelect(root).options, (o) => o.textContent)).toEqual(['Bracket', 'File (top level)']);

    choices = { parts: [bracket, lid], active: lid.sourceLocation };
    dialog.openForCreate();
    expect(Array.from(partSelect(root).options, (o) => o.textContent)).toEqual(['Bracket', 'Lid', 'File (top level)']);
    expect(partSelect(root).selectedOptions[0].textContent).toBe('Lid');
  });

  it('tells two parts with the same name apart by line', () => {
    const { dialog, root } = mount();
    const twin = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 20, column: 0 } };
    dialog.setPartProvider(() => ({ parts: [bracket, twin], active: bracket.sourceLocation }));
    dialog.openForCreate();
    expect(Array.from(partSelect(root).options, (o) => o.textContent))
      .toEqual(['Bracket (line 3)', 'Bracket (line 20)', 'File (top level)']);
  });

  it('never shows the dropdown while editing an existing declaration', () => {
    const { dialog, root } = mount();
    dialog.setPartProvider(() => ({ parts: [bracket, lid], active: lid.sourceLocation }));
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
