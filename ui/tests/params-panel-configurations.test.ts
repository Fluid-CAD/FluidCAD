// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The assembly Parameters panel's configuration band
// (docs/assembly-configurations-plan.md §3.4, stage 2): a dropdown of
// Default + the file's rows, bold labels for the cells the row sets and a
// "default" hint on the rows it leaves out. Stage 3: the band's Add
// configuration button on a file without a table, and the ⋮ menu's Add /
// Duplicate / Rename / Delete / Manage over the client's row edits. Part
// configurations, stage 1 (plans/part-configurations-research.md): the same
// band in part scope, above the Part band, shown once the scene has a part.
// Auto-save: on a host that edits source a value is written into the row on
// screen (or the literal on Default) as it is committed — so there is no
// modified marker, no Save and no prompt on a switch; a read-only host keeps
// session tweaks and its header ↺. See params-panel-value-writes.test.ts.

import { ParamsPanel } from '../src/ui/params-panel';
import type { ParamEditorDialog, PartChoices } from '../src/ui/param-editor-dialog';
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
};

function mount(scope: 'part' | 'assembly' = 'assembly', editable = true) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const edits = editable ? {
    addConfiguration: vi.fn().mockResolvedValue({ success: true }),
    writeParam: vi.fn().mockResolvedValue({ success: true }),
    renameConfiguration: vi.fn().mockResolvedValue({ success: true }),
    removeConfiguration: vi.fn().mockResolvedValue({ success: true }),
    getConfigurationTables: vi.fn().mockResolvedValue(null),
    commitConfigurationTable: vi.fn().mockResolvedValue({ success: true }),
  } : {};
  const client = {
    setParam: vi.fn(), resetParams: vi.fn(), selectConfiguration: vi.fn(), ...edits,
  } as unknown as EngineClient & Required<Pick<EngineClient,
    'addConfiguration' | 'writeParam' | 'renameConfiguration' | 'removeConfiguration'
    | 'getConfigurationTables' | 'commitConfigurationTable'>>;
  const editor = { openForCreate: vi.fn(), openForEdit: vi.fn() } as unknown as ParamEditorDialog;
  const panel = new ParamsPanel(host, client, editor, scope);
  const select = () => host.querySelector<HTMLSelectElement>('[data-configuration]');
  const marker = () => host.querySelector<HTMLElement>('[data-configuration-modified]');
  const inheritOf = (label: string) =>
    host.querySelector<HTMLElement>(`[data-param-label="${label}"]`)!.closest('.group')!.querySelector<HTMLButtonElement>('[data-param-inherit]');
  const reset = () => host.querySelector<HTMLButtonElement>('[data-reset-params]')!;
  const labelOf = (label: string) =>
    host.querySelector<HTMLElement>(`[data-param-label="${label}"]`)!.closest('.group')!.querySelector('label')!;
  const hintOf = (label: string) =>
    host.querySelector<HTMLElement>(`[data-param-label="${label}"]`)!.closest('.group')!.querySelector('[data-param-default-hint]');
  const pick = (name: string) => {
    select()!.value = name;
    select()!.dispatchEvent(new Event('change'));
  };
  return { host, panel, client, select, marker, reset, labelOf, hintOf, inheritOf, pick };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const FILE = '/ws/plate.part.js';
const plate = { name: 'Plate', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
const lid = { name: 'Lid', sourceLocation: { filePath: FILE, line: 20, column: 0 } };
const onePart = (): PartChoices => ({ parts: [plate], selected: plate.sourceLocation });

/** A part parameter of `owner` — what a part scene's render carries. */
function partParam(label: string, currentValue = 10, configuredValue?: number, owner = plate): UIParamDefinition {
  return { ...param(label, currentValue, configuredValue), kind: 'part', part: owner.sourceLocation };
}

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
    panel.update([param('Width')], [], { active: 'Default', names: [], rows: {} });
    expect(select()).toBeNull();
    expect(marker()).toBeNull();
    expect(panel.activeConfiguration).toBe('Default');
  });

  it('shows in part scope too, on the active row', () => {
    const { panel, select } = mount('part');
    panel.setPartProvider(onePart);
    panel.update([partParam('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(Array.from(select()!.options, (o) => o.textContent)).toEqual(['Default', 'Compact', 'Wide']);
    expect(select()!.value).toBe('Wide');
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

  it('draws no modified marker, and hides the header ↺ where values are written into the source', () => {
    const { panel, host, marker, reset } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(marker()).toBeNull();
    expect(host.textContent).not.toContain('modified');
    expect(reset().hidden).toBe(true);
  });

  it('a read-only host keeps the header ↺ for its session tweaks, retitled while a row is active — no marker either', () => {
    const { panel, marker, reset, client } = mount('assembly', false);
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(marker()).toBeNull();
    expect(reset().hidden).toBe(false);
    expect(reset().title).toBe('Revert changes');
    reset().click();
    expect(client.resetParams).toHaveBeenCalledTimes(1);
    panel.update([param('Width', 10)], [], TABLE);
    expect(reset().title).toBe('Reset all to defaults');
  });

  it('switches rows straight away — nothing to save, nothing to ask', () => {
    const { panel, client, host, pick } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide' });
    pick('Compact');
    expect(client.selectConfiguration).toHaveBeenCalledWith('Compact');
    expect(document.querySelector('[data-configuration-choice]')).toBeNull();
    expect(host.querySelector('[data-configuration-choice]')).toBeNull();
  });

  it('a read-only host switches straight away too, its tweaks dropped with the row', () => {
    const { panel, client, pick } = mount('assembly', false);
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide' });
    pick('Default');
    expect(client.selectConfiguration).toHaveBeenCalledWith('Default');
    expect(document.querySelector('[data-configuration-choice]')).toBeNull();
  });

  it('a switch waits for the values still being written, so each lands in the row it was typed on', async () => {
    const { panel, host, client, pick } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    let land!: (value: { success: boolean }) => void;
    vi.mocked(client.writeParam).mockReturnValueOnce(new Promise((resolve) => {
      land = resolve;
    }));
    const input = host.querySelector<HTMLInputElement>('[data-param-label="Width"]')!;
    input.value = '1300';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(client.writeParam).toHaveBeenCalledWith('Width', 1300, undefined, 'Wide');
    pick('Compact');
    await flush();
    expect(client.selectConfiguration).not.toHaveBeenCalled();
    land({ success: true });
    await vi.waitFor(() => expect(client.selectConfiguration).toHaveBeenCalledWith('Compact'));
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
    panel.update([param('Width', 1300)], [], { active: 'Default', names: [], rows: {} });
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

  it('offers Add configuration in part scope once the scene has a part', async () => {
    const { panel, host, client } = mount('part');
    panel.update([{ ...param('Width'), kind: 'part' }]);
    expect(host.querySelector('[data-configuration-add]')).toBeNull();
    panel.setPartProvider(onePart);
    panel.update([partParam('Width')]);
    const add = host.querySelector<HTMLButtonElement>('[data-configuration-add]')!;
    expect(add).not.toBeNull();
    answerPrompt(panel, 'M8');
    add.click();
    await flush();
    expect(client.addConfiguration).toHaveBeenCalledWith('M8', undefined, plate.sourceLocation);
  });

  it('opens the ⋮ menu beside the dropdown with every row action', () => {
    const { panel, host } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    menuButton(host)!.click();
    const menu = document.querySelector<HTMLElement>('[data-configuration-actions]')!;
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]'), (b) => b.textContent!.trim()))
      .toEqual(['Add configuration…', 'Duplicate…', 'Rename…', 'Delete', 'Manage…']);
    // A solid surface, never the docked chrome's see-through one: the
    // bands and rows it opens over must not read through it.
    expect(menu.className).toContain('bg-base-100');
    expect(menu.className).not.toContain('panel-bg');
  });

  it('enables Rename / Delete only on a row', () => {
    const { panel } = mount();
    panel.update([param('Width')], [], TABLE);
    expect(item(panel, 'Rename…').disabled).toBe(true);
    expect(item(panel, 'Delete').disabled).toBe(true);
    expect(item(panel, 'Add configuration…').disabled).toBeFalsy();
    expect(item(panel, 'Duplicate…').disabled).toBeFalsy();

    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    expect(item(panel, 'Rename…').disabled).toBe(false);
    expect(item(panel, 'Delete').disabled).toBe(false);
    expect(item(panel, 'Save')).toBeUndefined();
  });

  it('Add and Duplicate add a row through the client and take the table the answer carries', async () => {
    const { panel, client, select } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide' });
    vi.mocked(client.addConfiguration).mockResolvedValueOnce({
      success: true,
      configurations: { active: 'Wider', names: ['Compact', 'Wide', 'Wider'], rows: {} },
    });
    const { asked, refusals } = answerPrompt(panel, 'Wider');
    item(panel, 'Duplicate…').onSelect!();
    await flush();
    expect(asked[0].title).toBe('Duplicate configuration');
    expect(asked[0].confirmLabel).toBe('Duplicate');
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
    panel.update([param('Width', 1300)], [], { ...TABLE });
    vi.mocked(client.addConfiguration).mockResolvedValueOnce({
      success: true,
      configurations: { active: 'Empty', names: ['Compact', 'Wide', 'Empty'], rows: { Empty: {} } },
    });
    answerPrompt(panel, 'Empty');
    item(panel, 'Add configuration…').onSelect!();
    await flush();
    // The render of the empty row: same controls, no cells — every row is "default".
    panel.update([param('Width', 10)], [], { active: 'Empty', names: ['Compact', 'Wide', 'Empty'], rows: { Empty: {} } });
    expect(hintOf('Width')!.textContent).toBe('default');
  });
  it('Manage… opens the grid over the table and commits through the client', async () => {
    const { panel, client } = mount();
    panel.update([param('Width', 1200, 1200), { ...param('Wall'), kind: 'global' }], [], { ...TABLE, active: 'Wide' });
    expect(item(panel, 'Manage…').disabled).toBe(false);
    const opened: any[] = [];
    panel.openGrid = async (opts) => {
      opened.push(opts);
    };
    item(panel, 'Manage…').onSelect!();
    await flush();
    expect(opened).toHaveLength(1);
    // The columns are the section's own rows — never a project global.
    expect(opened[0].params.map((p: UIParamDefinition) => p.label)).toEqual(['Width']);
    expect(opened[0].configurations).toMatchObject({ active: 'Wide', names: ['Compact', 'Wide'] });
    await opened[0].loadTable();
    expect(client.getConfigurationTables).toHaveBeenCalled();
    vi.mocked(client.commitConfigurationTable).mockResolvedValueOnce({ success: false, reason: 'nope' });
    expect(await opened[0].commit({ rows: { Wide: { Width: 1300 } } })).toBe('nope');
    expect(client.commitConfigurationTable).toHaveBeenCalledWith({ rows: { Wide: { Width: 1300 } } });
    vi.mocked(client.commitConfigurationTable).mockResolvedValueOnce({
      success: true,
      configurations: { active: 'Broad', names: ['Compact', 'Broad'], rows: {} },
    });
    expect(await opened[0].commit({ rows: {}, renames: { Wide: 'Broad' } })).toBeNull();
    expect(panel.activeConfiguration).toBe('Broad');
  });

  it('Manage… opens the real grid in the dialog host by default', async () => {
    const { panel } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    item(panel, 'Manage…').onSelect!();
    await flush();
    expect(document.body.querySelector('[data-configurations-grid]')).not.toBeNull();
  });

  it('disables Manage… on a client that cannot commit the table', () => {
    const { panel, client } = mount();
    delete (client as Partial<EngineClient>).commitConfigurationTable;
    panel.update([param('Width')], [], TABLE);
    expect(item(panel, 'Manage…').disabled).toBe(true);
  });
});

describe('ParamsPanel configuration band in part scope', () => {
  const partSelect = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('[data-param-part]');
  /** The bands' stack: the body's first row, above the list. */
  const bandStack = (panel: ParamsPanel) => panel.body.firstElementChild as HTMLElement;

  it('sits above the Part band, both above the controls', () => {
    const { panel, host, select } = mount('part');
    panel.setPartProvider(onePart);
    panel.update([partParam('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    const order = Array.from(host.querySelectorAll('[data-configuration], [data-param-part], [data-param-label]'));
    expect(order[0]).toBe(select());
    expect(order[1]).toBe(partSelect(host));
    expect(order[2]).toBe(host.querySelector('[data-param-label="Width"]'));
    // One stack holds both bands.
    expect(bandStack(panel).contains(select())).toBe(true);
    expect(bandStack(panel).contains(partSelect(host))).toBe(true);
  });

  it('labels each band above its full-width dropdown: Configuration with its ⋮, then Part', () => {
    const { panel, host, select } = mount('part');
    panel.setPartProvider(onePart);
    panel.update([partParam('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide' });
    const configurationLabel = select()!.previousElementSibling as HTMLElement;
    expect(configurationLabel.firstElementChild!.textContent).toBe('Configuration');
    expect(configurationLabel.querySelector('[data-configuration-modified]')).toBeNull();
    expect(configurationLabel.querySelector('[data-configuration-menu]')).not.toBeNull();
    expect(select()!.className).toContain('select-bordered');
    expect(select()!.className).toContain('w-full');
    const partLabel = partSelect(host)!.previousElementSibling as HTMLElement;
    expect(partLabel.textContent).toBe('Part');
    expect(partSelect(host)!.className).toContain('select-bordered');
    expect(host.textContent).not.toContain('Add to');
  });

  it('keeps one band per row in assembly scope: the configuration band, no Part band', () => {
    const { panel, host, select } = mount('assembly');
    panel.update([param('Width')], [], TABLE);
    expect(select()).not.toBeNull();
    expect(partSelect(host)).toBeNull();
    expect(bandStack(panel).hidden).toBe(false);
  });

  it('hides with the + when the scene has no part and no rows', () => {
    const { panel, host } = mount('part');
    panel.setPartProvider(() => ({ parts: [], selected: null }));
    panel.update([{ ...param('Width'), kind: 'part' }]);
    expect(host.querySelector('[data-configuration-add]')).toBeNull();
    expect(host.querySelector('[data-configuration]')).toBeNull();
    expect(partSelect(host)).toBeNull();
    expect(host.querySelector<HTMLElement>('[data-add-param]')!.hidden).toBe(true);
    // The empty stack is hidden with its bands.
    expect(bandStack(panel).hidden).toBe(true);
  });

  it('shows a table\'s dropdown with no part to add to, as on a read-only host', () => {
    const { panel, host, select } = mount('part', false);
    panel.update([{ ...param('Width', 1200, 1200), kind: 'part' }], [], { ...TABLE, active: 'Wide' });
    expect(select()!.value).toBe('Wide');
    expect(partSelect(host)).toBeNull();
    expect(host.querySelector('[data-configuration-menu]')).toBeNull();
    expect(bandStack(panel).hidden).toBe(false);
  });

  it('decorates the rows while a row is active: bold with ↺ for a set value, the default hint otherwise', () => {
    const { panel, labelOf, hintOf, inheritOf, reset } = mount('part');
    panel.setPartProvider(onePart);
    panel.update([partParam('Width', 1200, 1200), partParam('Depth', 800)], [], { ...TABLE, active: 'Wide' });
    expect(labelOf('Width').className).toContain('font-semibold');
    expect(hintOf('Width')).toBeNull();
    expect(inheritOf('Width')!.title).toBe('Use the default — Wide stops setting Width');
    expect(hintOf('Depth')!.textContent).toBe('default');
    expect(inheritOf('Depth')).toBeNull();
    expect(reset().hidden).toBe(true);

    panel.update([partParam('Width', 10), partParam('Depth', 800)], [], TABLE);
    expect(labelOf('Width').className).not.toContain('font-semibold');
    expect(hintOf('Depth')).toBeNull();
    expect(inheritOf('Width')).toBeNull();
  });

  it('survives a Part pick and a timeline selection move, and switches independently of them', () => {
    let selected = plate.sourceLocation;
    const { panel, host, client, select, pick } = mount('part');
    panel.setPartProvider(() => ({ parts: [plate, lid], selected }));
    panel.update([partParam('Width', 1200, 1200), partParam('Height', 5, undefined, lid)], [], { ...TABLE, active: 'Wide' });

    // Part: the other part — the configuration stays, the list follows the part.
    const parts = partSelect(host)!;
    parts.value = '1';
    parts.dispatchEvent(new Event('change'));
    expect(select()!.value).toBe('Wide');
    expect(host.querySelector('[data-param-label="Height"]')).not.toBeNull();
    expect(host.querySelector('[data-param-label="Width"]')).toBeNull();

    // A timeline click moves the selection without a render.
    selected = plate.sourceLocation;
    panel.syncParts();
    selected = lid.sourceLocation;
    panel.syncParts();
    expect(select()!.value).toBe('Wide');
    expect(partSelect(host)!.selectedOptions[0].textContent).toBe('Lid');

    // Picking a configuration leaves the Part choice alone.
    pick('Compact');
    expect(client.selectConfiguration).toHaveBeenCalledWith('Compact');
    expect(partSelect(host)!.selectedOptions[0].textContent).toBe('Lid');
  });

  it('Manage… takes the single part\'s parameters as the grid\'s columns', async () => {
    const { panel } = mount('part');
    panel.setPartProvider(onePart);
    panel.update([
      partParam('Width', 1200, 1200),
      partParam('Depth', 800),
      { ...param('Wall'), kind: 'global' },
    ], [], { ...TABLE, active: 'Wide' });
    const opened: any[] = [];
    panel.openGrid = async (opts) => {
      opened.push(opts);
    };
    panel.configurationMenuItems().find((i) => i.label === 'Manage…')!.onSelect!();
    await flush();
    expect(opened[0].params.map((p: UIParamDefinition) => p.label)).toEqual(['Width', 'Depth']);
    expect(opened[0].home).toEqual(plate.sourceLocation);
  });

  describe('two parts in one file', () => {
    const twoParts = (selected = lid): (() => PartChoices) => () => ({ parts: [plate, lid], selected: selected.sourceLocation });
    const keyed = (label: string, owner: typeof plate, value = 10): UIParamDefinition =>
      ({ ...partParam(label, value, undefined, owner), body: owner.name });

    it('Manage… takes every part\'s parameters, each part\'s run together in the parts\' order', async () => {
      const { panel } = mount('part');
      panel.setPartProvider(twoParts());
      panel.update([
        keyed('Width', lid, 20),
        keyed('Width', plate, 40),
        keyed('Depth', plate, 5),
        { ...param('Wall'), kind: 'global' },
      ], [], { ...TABLE, active: 'Wide' });
      const opened: any[] = [];
      panel.openGrid = async (opts) => {
        opened.push(opts);
      };
      panel.configurationMenuItems().find((i) => i.label === 'Manage…')!.onSelect!();
      await flush();
      expect(opened[0].params.map((p: UIParamDefinition) => `${p.body}.${p.label}`)).toEqual(['Plate.Width', 'Plate.Depth', 'Lid.Width']);
      expect(opened[0].home).toEqual(lid.sourceLocation);
    });

    it('Add sends the Part band part, where a row with no value goes', async () => {
      const { panel, host, client } = mount('part');
      panel.setPartProvider(twoParts(plate));
      panel.update([keyed('Width', plate), keyed('Width', lid)], [], { ...TABLE, active: 'Wide' });
      panel.promptName = async (prompt) => {
        await prompt.submit('Blank');
      };
      panel.configurationMenuItems().find((i) => i.label === 'Add configuration…')!.onSelect!();
      await flush();
      expect(client.addConfiguration).toHaveBeenCalledWith('Blank', undefined, plate.sourceLocation);
      expect(host.querySelector('[data-configuration]')).not.toBeNull();
    });
  });
});
