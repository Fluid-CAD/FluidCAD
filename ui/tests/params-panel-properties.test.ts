// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Parameters panel's property side: the header + becomes a two-item
// menu (parameter or property) once a property editor is wired in, the
// selected part's `property()` values list under their own caption with a
// pencil opening the editor, and a value-only render updates them in place.

import { ParamsPanel } from '../src/ui/params-panel';
import type { ParamEditorDialog, PartChoices } from '../src/ui/param-editor-dialog';
import type { PropertyEditorDialog } from '../src/ui/property-editor-dialog';
import type { EngineClient } from '../src/engine-client';
import type { UIParamDefinition, UIPropertyDefinition } from '../src/types';

if (typeof globalThis.CSS === 'undefined') {
  (globalThis as any).CSS = { escape: (value: string) => value };
}

const FILE = '/ws/model.fluid.js';
const bracket = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
const lid = { name: 'Lid', sourceLocation: { filePath: FILE, line: 13, column: 0 } };

function param(label: string, part = bracket): UIParamDefinition {
  return { label, defaultValue: 10, currentValue: 10, controlType: 'number', part: part.sourceLocation };
}

function property(name: string, value: UIPropertyDefinition['value'], part = bracket): UIPropertyDefinition {
  const label = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return {
    label, name, value, part: part.sourceLocation,
    sourceLocation: { filePath: FILE, line: part.sourceLocation.line + 5, column: 2 },
  };
}

function mount(choices: () => PartChoices, scope: 'part' | 'assembly' = 'part') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const client = { setParam: vi.fn(), resetParams: vi.fn() } as unknown as EngineClient;
  const editor = { openForCreate: vi.fn(), openForEdit: vi.fn() } as unknown as ParamEditorDialog;
  const propertyEditor = { openForCreate: vi.fn(), openForEdit: vi.fn() } as unknown as PropertyEditorDialog;
  const panel = new ParamsPanel(host, client, editor, scope, propertyEditor);
  panel.setPartProvider(choices);
  const add = () => host.querySelector<HTMLButtonElement>('[data-add-param]')!;
  const menu = () => host.querySelector<HTMLElement>('[data-add-menu]');
  const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-property-row]'), (el) => el.dataset.propertyRow);
  const valueOf = (name: string) => host.querySelector(`[data-property-value="${name}"]`)?.textContent;
  return { host, panel, editor, propertyEditor, add, menu, rows, valueOf };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ParamsPanel + menu', () => {
  it('opens a New parameter / New property menu instead of the dialog', () => {
    const { panel, editor, propertyEditor, add, menu } = mount(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));
    panel.update([param('Width')]);
    add().click();
    expect(editor.openForCreate).not.toHaveBeenCalled();
    const items = Array.from(menu()!.querySelectorAll('button'), (b) => b.textContent?.trim());
    expect(items).toEqual(['New parameter', 'New property']);

    menu()!.querySelector<HTMLButtonElement>('[data-add="param"]')!.click();
    expect(editor.openForCreate).toHaveBeenLastCalledWith(lid.sourceLocation);
    expect(menu()).toBeNull();

    add().click();
    menu()!.querySelector<HTMLButtonElement>('[data-add="property"]')!.click();
    expect(propertyEditor.openForCreate).toHaveBeenLastCalledWith(lid.sourceLocation);
    expect(menu()).toBeNull();
  });

  it('toggles closed on a second click and closes on a click elsewhere', () => {
    vi.useFakeTimers();
    try {
      const { panel, add, menu } = mount(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
      panel.update([]);
      add().click();
      expect(menu()).not.toBeNull();
      add().click();
      expect(menu()).toBeNull();

      add().click();
      vi.runAllTimers();
      document.body.click();
      expect(menu()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the direct + in assembly scope, where a property has no home', () => {
    const { panel, editor, add, menu } = mount(() => ({ parts: [], selected: null }), 'assembly');
    panel.update([]);
    add().click();
    expect(menu()).toBeNull();
    expect(editor.openForCreate).toHaveBeenCalledWith(null);
  });
});

describe('ParamsPanel property rows', () => {
  it("lists the selected part's properties under a caption, with their values", () => {
    const { panel, host, rows, valueOf } = mount(() => ({ parts: [bracket, lid], selected: bracket.sourceLocation }));
    panel.update(
      [param('Width')],
      [property('innerWidth', 52), property('finish', 'anodised'), property('lidGap', 0.5, lid)],
    );
    expect(host.querySelector('[data-properties]')?.textContent).toContain('Properties');
    expect(rows()).toEqual(['innerWidth', 'finish']);
    // Rows are keyed by name but read by label.
    expect(host.querySelector('[data-property-row="innerWidth"]')?.textContent).toContain('Inner width');
    expect(valueOf('innerWidth')).toBe('52');
    expect(valueOf('finish')).toBe('anodised');
  });

  it('shows properties even when the part has no parameters, and the empty state only when it has neither', () => {
    const { panel, host, rows } = mount(() => ({ parts: [bracket, lid], selected: bracket.sourceLocation }));
    panel.update([], [property('innerWidth', 52)]);
    expect(rows()).toEqual(['innerWidth']);
    expect(host.textContent).not.toContain('No parameters');
    panel.update([], []);
    expect(host.textContent).toContain('No parameters in Bracket yet');
  });

  it('opens the property editor from the row pencil', () => {
    const { panel, host, propertyEditor } = mount(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    const inner = property('innerWidth', 52);
    panel.update([param('Width')], [inner]);
    host.querySelector<HTMLButtonElement>('[data-property-edit="innerWidth"]')!.click();
    expect(propertyEditor.openForEdit).toHaveBeenCalledWith(inner);
  });

  it('updates values in place when only a value changed, and redraws when a row did', () => {
    const { panel, host, rows, valueOf } = mount(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    panel.update([param('Width')], [property('innerWidth', 52), property('holes', [6, 8])]);
    const before = host.querySelector('[data-property-row="innerWidth"]');
    panel.update([param('Width')], [property('innerWidth', 72), property('holes', [6, 10])]);
    expect(valueOf('innerWidth')).toBe('72');
    expect(valueOf('holes')).toBe('[6, 10]');
    expect(host.querySelector('[data-property-row="innerWidth"]')).toBe(before);

    panel.update([param('Width')], [property('innerWidth', 72)]);
    expect(rows()).toEqual(['innerWidth']);
    expect(host.querySelector('[data-property-row="innerWidth"]')).not.toBe(before);
  });

  it('rounds long fractions for display', () => {
    const { panel, valueOf } = mount(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    panel.update([], [property('ratio', 1 / 3)]);
    expect(valueOf('ratio')).toBe('0.3333');
  });
});
