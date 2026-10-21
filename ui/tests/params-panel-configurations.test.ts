// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The assembly Parameters panel's configuration band
// (docs/assembly-configurations-plan.md §3.4, stage 2): a dropdown of
// Default + the file's rows, the modified marker, bold labels for the cells
// the row sets and a "default" hint on the rows it leaves out, ↺ retitled
// while a row is active, and a Save / Discard / Cancel choice before a
// switch drops tweaks. Stage 3: the band's Add configuration button on a
// file without a table, and the ⋮ menu's Add / Save / Save as / Rename /
// Delete over the client's row edits.

import { ParamsPanel } from '../src/ui/params-panel';
import type { ParamEditorDialog } from '../src/ui/param-editor-dialog';
import type { EngineClient } from '../src/engine-client';
import type { UIConfigurations, UIParamDefinition } from '../src/types';
import type { ConfigurationNamePrompt } from '../src/ui/configuration-dialogs';

if (typeof globalThis.CSS === 'undefined') {
  (globalThis as any).CSS = { escape: (value: string) => value };
}

function param(label: string, currentValue = 10, configuredValue?: number): UIParamDefinition {
  return {
    label, kind: 'assembly', defaultValue: 10, currentValue, controlType: 'number',
    ...(configuredValue !== undefined ? { configuredValue } : {}),
  };
}

const TABLE: UIConfigurations = {
  active: 'Default',
  names: ['Compact', 'Wide'],
  rows: { Compact: { Width: 500 }, Wide: { Width: 1200 } },
  modified: false,
};

function mount(scope: 'part' | 'assembly' = 'assembly', editable = true) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const edits = editable ? {
    addConfiguration: vi.fn().mockResolvedValue({ success: true }),
    saveConfiguration: vi.fn().mockResolvedValue({ success: true }),
    renameConfiguration: vi.fn().mockResolvedValue({ success: true }),
    removeConfiguration: vi.fn().mockResolvedValue({ success: true }),
  } : {};
  const client = {
    setParam: vi.fn(), resetParams: vi.fn(), selectConfiguration: vi.fn(), ...edits,
  } as unknown as EngineClient & Required<Pick<EngineClient,
    'addConfiguration' | 'saveConfiguration' | 'renameConfiguration' | 'removeConfiguration'>>;
  const editor = { openForCreate: vi.fn(), openForEdit: vi.fn() } as unknown as ParamEditorDialog;
  const panel = new ParamsPanel(host, client, editor, scope);
  const select = () => host.querySelector<HTMLSelectElement>('[data-configuration]');
  const marker = () => host.querySelector<HTMLElement>('[data-configuration-modified]');
  const reset = () => host.querySelector<HTMLButtonElement>('[data-reset-params]')!;
  const labelOf = (label: string) =>
    host.querySelector<HTMLElement>(`[data-param-label="${label}"]`)!.closest('.group')!.querySelector('label')!;
  const hintOf = (label: string) =>
    host.querySelector<HTMLElement>(`[data-param-label="${label}"]`)!.closest('.group')!.querySelector('[data-param-default-hint]');
  const pick = (name: string) => {
    select()!.value = name;
    select()!.dispatchEvent(new Event('change'));
  };
  return { host, panel, client, select, marker, reset, labelOf, hintOf, pick };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ParamsPanel configuration dropdown', () => {
  it('lists Default then the rows, on the active one, above the controls', () => {
    const { panel, host, select } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(Array.from(select()!.options, (o) => o.textContent)).toEqual(['Default', 'Compact', 'Wide']);
    expect(select()!.value).toBe('Wide');
    expect(panel.activeConfiguration).toBe('Wide');
    const order = Array.from(host.querySelectorAll('[data-configuration], [data-param-label]'));
    expect(order[0]).toBe(select());
  });

  it('shows no dropdown when the file declares no rows, or the render carries none', () => {
    const { panel, select, marker } = mount();
    panel.update([param('Width')]);
    expect(select()).toBeNull();
    panel.update([param('Width')], [], { active: 'Default', names: [], rows: {}, modified: true });
    expect(select()).toBeNull();
    expect(marker()).toBeNull();
    expect(panel.activeConfiguration).toBe('Default');
  });

  it('never shows in part scope', () => {
    const { panel, select } = mount('part');
    panel.update([{ ...param('Width'), kind: 'part' }], [], { ...TABLE, active: 'Wide' });
    expect(select()).toBeNull();
  });

  it('selecting a row calls the client; Default is a row like any other', () => {
    const { panel, client, pick } = mount();
    panel.update([param('Width')], [], TABLE);
    pick('Wide');
    expect(client.selectConfiguration).toHaveBeenCalledWith('Wide');
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    pick('Default');
    expect(client.selectConfiguration).toHaveBeenLastCalledWith('Default');
    expect(client.selectConfiguration).toHaveBeenCalledTimes(2);
  });

  it('draws the cells the row sets bold and hints "default" on the rows it leaves out', () => {
    const { panel, labelOf, hintOf } = mount();
    panel.update([param('Width', 1200, 1200), param('Depth', 800)], [], { ...TABLE, active: 'Wide' });
    expect(labelOf('Width').className).toContain('font-semibold');
    expect(hintOf('Width')).toBeNull();
    expect(labelOf('Depth').className).not.toContain('font-semibold');
    expect(hintOf('Depth')!.textContent).toBe('default');

    // Back on Default nothing is decorated — even with values equal.
    panel.update([param('Width', 1200), param('Depth', 800)], [], TABLE);
    expect(labelOf('Width').className).not.toContain('font-semibold');
    expect(hintOf('Depth')).toBeNull();
  });

  it('redraws the decorations on a switch even when the controls are unchanged', () => {
    const { panel, labelOf, hintOf } = mount();
    panel.update([param('Width', 1200), param('Depth', 800)], [], TABLE);
    // Same labels and control types: the in-place path would keep the markup.
    panel.update([param('Width', 1200, 1200), param('Depth', 800)], [], { ...TABLE, active: 'Wide' });
    expect(labelOf('Width').className).toContain('font-semibold');
    expect(hintOf('Depth')!.textContent).toBe('default');
  });

  it('shows the modified marker while session tweaks sit on the row, and retitles ↺', () => {
    const { panel, marker, reset, client } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(marker()).toBeNull();
    expect(reset().title).toBe('Revert changes');
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    expect(marker()!.textContent).toContain('modified');
    reset().click();
    expect(client.resetParams).toHaveBeenCalledTimes(1);
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(marker()).toBeNull();
    panel.update([param('Width', 10)], [], TABLE);
    expect(reset().title).toBe('Reset all to defaults');
  });

  it('asks Save / Discard / Cancel before a switch drops tweaks; Cancel keeps the dropdown on the active row', async () => {
    const { panel, client, select, pick } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    const choose = vi.fn<(active: string, target: string, canSave: boolean) => Promise<'save' | 'discard' | 'cancel'>>()
      .mockResolvedValueOnce('cancel').mockResolvedValueOnce('discard');
    panel.chooseSwitch = choose;

    pick('Compact');
    await flush();
    expect(choose).toHaveBeenCalledWith('Wide', 'Compact', true);
    expect(client.selectConfiguration).not.toHaveBeenCalled();
    expect(select()!.value).toBe('Wide');

    pick('Compact');
    await flush();
    expect(client.saveConfiguration).not.toHaveBeenCalled();
    expect(client.selectConfiguration).toHaveBeenCalledWith('Compact');
  });

  it('Save on a switch saves into the active row, then selects', async () => {
    const { panel, client, pick } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    panel.chooseSwitch = vi.fn().mockResolvedValue('save');
    pick('Compact');
    await vi.waitFor(() => expect(client.selectConfiguration).toHaveBeenCalledWith('Compact'));
    expect(client.saveConfiguration).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.saveConfiguration).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(client.selectConfiguration).mock.invocationCallOrder[0]);
  });

  it('a refused Save on a switch stays on the row and reports why', async () => {
    const { panel, client, select, pick } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    panel.chooseSwitch = vi.fn().mockResolvedValue('save');
    panel.onError = vi.fn();
    vi.mocked(client.saveConfiguration).mockResolvedValueOnce({ success: false, reason: 'table is not a literal' });
    pick('Compact');
    await vi.waitFor(() => expect(panel.onError).toHaveBeenCalledWith(expect.stringContaining('table is not a literal')));
    expect(client.selectConfiguration).not.toHaveBeenCalled();
    expect(select()!.value).toBe('Wide');
  });

  it('offers no Save when the tweaks sit on Default', async () => {
    const { panel, client, pick } = mount();
    panel.update([param('Width', 1300)], [], { ...TABLE, modified: true });
    const choose = vi.fn().mockResolvedValue('discard');
    panel.chooseSwitch = choose;
    pick('Wide');
    await flush();
    expect(choose).toHaveBeenCalledWith('Default', 'Wide', false);
    expect(client.selectConfiguration).toHaveBeenCalledWith('Wide');
  });

  it('switches without asking when nothing is modified', async () => {
    const { panel, client, pick } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    const choose = vi.fn().mockResolvedValue('discard');
    panel.chooseSwitch = choose;
    pick('Compact');
    await flush();
    expect(choose).not.toHaveBeenCalled();
    expect(client.selectConfiguration).toHaveBeenCalledWith('Compact');
  });
});

describe('ParamsPanel configuration actions', () => {
  /** Stand in for the name prompt: submit `name` and remember what was asked. */
  function answerPrompt(panel: ParamsPanel, name: string) {
    const asked: ConfigurationNamePrompt[] = [];
    const refusals: (string | null)[] = [];
    panel.promptName = async (prompt) => {
      asked.push(prompt);
      refusals.push(await prompt.submit(name));
    };
    return { asked, refusals };
  }
  const menuButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-configuration-menu]');
  const item = (panel: ParamsPanel, label: string) => panel.configurationMenuItems().find((i) => i.label === label)!;

  it('shows one Add configuration button while the file has no table', async () => {
    const { panel, host, client, select } = mount();
    panel.update([param('Width', 1300)], [], { active: 'Default', names: [], rows: {}, modified: true });
    const add = host.querySelector<HTMLButtonElement>('[data-configuration-add]')!;
    expect(add.textContent).toContain('Add configuration');
    expect(select()).toBeNull();
    expect(menuButton(host)).toBeNull();

    const { asked } = answerPrompt(panel, 'Wide');
    add.click();
    await flush();
    expect(asked[0].taken).toEqual([]);
    // No values: the server writes the tweaks on screen into the new row.
    expect(client.addConfiguration).toHaveBeenCalledWith('Wide');
  });

  it('shows the Add button before any render too, but not on a host that cannot edit', () => {
    const editable = mount();
    expect(editable.host.querySelector('[data-configuration-add]')).not.toBeNull();
    document.body.innerHTML = '';
    const readOnly = mount('assembly', false);
    readOnly.panel.update([param('Width')]);
    expect(readOnly.host.querySelector('[data-configuration-add]')).toBeNull();
    // A table still shows its dropdown — without the row actions.
    readOnly.panel.update([param('Width')], [], TABLE);
    expect(readOnly.select()).not.toBeNull();
    expect(menuButton(readOnly.host)).toBeNull();
  });

  it('never shows in part scope, Add button included', () => {
    const { panel, host } = mount('part');
    panel.update([{ ...param('Width'), kind: 'part' }]);
    expect(host.querySelector('[data-configuration-add]')).toBeNull();
  });

  it('opens the ⋮ menu beside the dropdown with every row action', () => {
    const { panel, host } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    menuButton(host)!.click();
    const menu = document.querySelector<HTMLElement>('[data-configuration-actions]')!;
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]'), (b) => b.textContent!.trim()))
      .toEqual(['Add configuration…', 'Save', 'Save as…', 'Rename…', 'Delete']);
  });

  it('enables Save only on a modified row, and Rename / Delete only on a row', () => {
    const { panel } = mount();
    panel.update([param('Width')], [], TABLE);
    expect(item(panel, 'Save').disabled).toBe(true);
    expect(item(panel, 'Rename…').disabled).toBe(true);
    expect(item(panel, 'Delete').disabled).toBe(true);
    expect(item(panel, 'Add configuration…').disabled).toBeFalsy();
    expect(item(panel, 'Save as…').disabled).toBeFalsy();

    // Tweaks on Default still have no row to save into.
    panel.update([param('Width', 1300)], [], { ...TABLE, modified: true });
    expect(item(panel, 'Save').disabled).toBe(true);

    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(item(panel, 'Save').disabled).toBe(true);
    expect(item(panel, 'Rename…').disabled).toBe(false);
    expect(item(panel, 'Delete').disabled).toBe(false);

    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    expect(item(panel, 'Save').disabled).toBe(false);
  });

  it('Add and Save as add a row through the client and take the table the answer carries', async () => {
    const { panel, client, select } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    vi.mocked(client.addConfiguration).mockResolvedValueOnce({
      success: true,
      configurations: { active: 'Wider', names: ['Compact', 'Wide', 'Wider'], rows: {}, modified: false },
    });
    const { asked, refusals } = answerPrompt(panel, 'Wider');
    item(panel, 'Save as…').onSelect!();
    await flush();
    expect(asked[0].initial).toBe('Wide copy');
    expect(asked[0].taken).toEqual(['Compact', 'Wide']);
    expect(client.addConfiguration).toHaveBeenCalledWith('Wider');
    expect(refusals).toEqual([null]);
    expect(Array.from(select()!.options, (o) => o.value)).toEqual(['Default', 'Compact', 'Wide', 'Wider']);
    expect(select()!.value).toBe('Wider');

    item(panel, 'Add configuration…').onSelect!();
    await flush();
    expect(asked[1].initial).toBe('');
    expect(client.addConfiguration).toHaveBeenCalledTimes(2);
  });

  it('hands a refused add back to the prompt to show', async () => {
    const { panel, client } = mount();
    panel.update([param('Width')], [], TABLE);
    vi.mocked(client.addConfiguration).mockResolvedValueOnce({ success: false, reason: 'Default is reserved' });
    const { refusals } = answerPrompt(panel, 'Default');
    item(panel, 'Add configuration…').onSelect!();
    await flush();
    expect(refusals).toEqual(['Default is reserved']);
  });

  it('Save writes the tweaks into the active row', async () => {
    const { panel, client, marker } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    vi.mocked(client.saveConfiguration).mockResolvedValueOnce({ success: true, configurations: { ...TABLE, active: 'Wide' } });
    item(panel, 'Save').onSelect!();
    await flush();
    expect(client.saveConfiguration).toHaveBeenCalledWith();
    expect(marker()).toBeNull();
  });

  it('a refused Save is reported', async () => {
    const { panel, client } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    panel.onError = vi.fn();
    vi.mocked(client.saveConfiguration).mockResolvedValueOnce({ success: false, reason: 'the editor did not apply' });
    item(panel, 'Save').onSelect!();
    await flush();
    expect(panel.onError).toHaveBeenCalledWith('Couldn\'t save Wide: the editor did not apply');
  });

  it('Rename renames the active row from its own name', async () => {
    const { panel, client } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    const { asked } = answerPrompt(panel, 'Broad');
    item(panel, 'Rename…').onSelect!();
    await flush();
    expect(asked[0].initial).toBe('Wide');
    expect(client.renameConfiguration).toHaveBeenCalledWith('Wide', 'Broad');
  });

  it('Delete asks first and removes the active row only on a yes', async () => {
    const { panel, client } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    const confirm = vi.fn<(name: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    panel.confirmDelete = confirm;
    item(panel, 'Delete').onSelect!();
    await flush();
    expect(confirm).toHaveBeenCalledWith('Wide');
    expect(client.removeConfiguration).not.toHaveBeenCalled();
    item(panel, 'Delete').onSelect!();
    await flush();
    expect(client.removeConfiguration).toHaveBeenCalledWith('Wide');
  });

  it('redraws the row hints when an answer switched the row ahead of the render', async () => {
    const { panel, client, hintOf } = mount();
    panel.update([param('Width', 1300)], [], { ...TABLE, modified: true });
    vi.mocked(client.addConfiguration).mockResolvedValueOnce({
      success: true,
      configurations: { active: 'Empty', names: ['Compact', 'Wide', 'Empty'], rows: { Empty: {} }, modified: false },
    });
    answerPrompt(panel, 'Empty');
    item(panel, 'Add configuration…').onSelect!();
    await flush();
    // The render of the empty row: same controls, no cells — every row is "default".
    panel.update([param('Width', 10)], [], { active: 'Empty', names: ['Compact', 'Wide', 'Empty'], rows: { Empty: {} }, modified: false });
    expect(hintOf('Width')!.textContent).toBe('default');
  });
});
