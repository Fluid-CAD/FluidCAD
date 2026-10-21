// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The assembly Parameters panel's configuration band
// (docs/assembly-configurations-plan.md §3.4, stage 2): a dropdown of
// Default + the file's rows, the modified marker, bold labels for the cells
// the row sets and a "default" hint on the rows it leaves out, ↺ retitled
// while a row is active, and a confirm before a switch discards tweaks.

import { ParamsPanel } from '../src/ui/params-panel';
import type { ParamEditorDialog } from '../src/ui/param-editor-dialog';
import type { EngineClient } from '../src/engine-client';
import type { UIConfigurations, UIParamDefinition } from '../src/types';

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

function mount(scope: 'part' | 'assembly' = 'assembly') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const client = { setParam: vi.fn(), resetParams: vi.fn(), selectConfiguration: vi.fn() } as unknown as EngineClient;
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

  it('hides the band when the file declares no rows, or the render carries none', () => {
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

  it('asks before a switch discards tweaks; a cancel keeps the dropdown on the active row', async () => {
    const { panel, client, select, pick } = mount();
    panel.update([param('Width', 1300, 1200)], [], { ...TABLE, active: 'Wide', modified: true });
    const confirm = vi.fn<(active: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    panel.confirmDiscard = confirm;

    pick('Compact');
    await flush();
    expect(confirm).toHaveBeenCalledWith('Wide');
    expect(client.selectConfiguration).not.toHaveBeenCalled();
    expect(select()!.value).toBe('Wide');

    pick('Compact');
    await flush();
    expect(client.selectConfiguration).toHaveBeenCalledWith('Compact');
  });

  it('switches without asking when nothing is modified', async () => {
    const { panel, client, pick } = mount();
    panel.update([param('Width', 1200, 1200)], [], { ...TABLE, active: 'Wide' });
    const confirm = vi.fn<(active: string) => Promise<boolean>>().mockResolvedValue(true);
    panel.confirmDiscard = confirm;
    pick('Compact');
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(client.selectConfiguration).toHaveBeenCalledWith('Compact');
  });
});
