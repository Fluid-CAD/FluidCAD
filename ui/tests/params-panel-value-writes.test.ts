// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// Auto-saving configurations: on a host that edits source, a value the user
// finishes editing in the Parameters panel is written into the source —
// the active row's cell, or on Default (also every file without a
// configurations() table) the param() literal — through the client's
// `writeParam`, once per committed edit: Enter or blur for a field, the
// release of a slider, a select's or a toggle's change. Writes run one at a
// time and a waiting one is replaced by a newer value of the same
// parameter. A refusal is reported and the control goes back to the
// render's value. ↺ on a row-set parameter clears its cell. A read-only
// host (no editor, or a client without `writeParam`) keeps session-only
// tweaks through `setParam`.

import { ParamsPanel } from '../src/ui/params-panel';
import type { ParamEditorDialog, PartChoices } from '../src/ui/param-editor-dialog';
import type { EngineClient } from '../src/engine-client';
import type { UIConfigurations, UIParamDefinition } from '../src/types';

// jsdom ships no CSS.escape, and a part's row key (`["Bracket","Width"]`)
// needs its quotes escaped inside an attribute selector.
if (typeof globalThis.CSS === 'undefined' || globalThis.CSS.escape('"') === '"') {
  (globalThis as any).CSS = { escape: (value: string) => value.replace(/["\\]/g, '\\$&') };
}

const FILE = '/ws/bracket.part.js';
const bracket = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
const onePart = (): PartChoices => ({ parts: [bracket], selected: bracket.sourceLocation });

const TABLE: UIConfigurations = {
  active: 'M8',
  names: ['M8', 'M10'],
  rows: { M8: { Screw: 'M8', Width: 50 }, M10: { Screw: 'M10', Width: 60, Gusset: true } },
};

type Value = UIParamDefinition['currentValue'];

/** A part parameter of the Bracket; `configured` is the active row's cell, when it sets one. */
function def(label: string, controlType: UIParamDefinition['controlType'], defaultValue: Value, currentValue: Value = defaultValue, configured?: Value, extra: Partial<UIParamDefinition> = {}): UIParamDefinition {
  return {
    label, kind: 'part', body: 'Bracket', part: bracket.sourceLocation, controlType, defaultValue, currentValue,
    ...(configured !== undefined ? { configuredValue: configured } : {}),
    ...extra,
  };
}

/** The angle bracket on M8: Screw and Width set by the row, Thickness and Gusset inherited. */
function bracketParams(): UIParamDefinition[] {
  return [
    def('Screw', 'select', 'M6', 'M8', 'M8', {
      options: [{ label: 'M6', value: 'M6' }, { label: 'M8', value: 'M8' }, { label: 'M10', value: 'M10' }],
    }),
    def('Width', 'number', 40, 50, 50, { min: 20, max: 120 }),
    def('Thickness', 'slider', 5, 5, undefined, { min: 3, max: 10, step: 0.5 }),
    def('Gusset', 'checkbox', false),
  ];
}

const mounted: ParamsPanel[] = [];

function mount(opts: { editor?: boolean; writes?: boolean } = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const client = {
    setParam: vi.fn(),
    resetParams: vi.fn(),
    selectConfiguration: vi.fn(),
    addConfiguration: vi.fn().mockResolvedValue({ success: true }),
    ...(opts.writes === false ? {} : { writeParam: vi.fn().mockResolvedValue({ success: true }) }),
  } as unknown as EngineClient & { writeParam: ReturnType<typeof vi.fn> };
  const editor = opts.editor === false
    ? undefined
    : { openForCreate: vi.fn(), openForEdit: vi.fn() } as unknown as ParamEditorDialog;
  const panel = new ParamsPanel(host, client, editor);
  panel.setPartProvider(onePart);
  panel.onError = vi.fn();
  mounted.push(panel);
  const control = <T extends HTMLElement = HTMLInputElement>(label: string) =>
    host.querySelector<T>(`[data-param-label="${label}"]`)!;
  const rowOf = (label: string) => control(label).closest('.group')!;
  return { host, panel, client, control, rowOf };
}

/** Type `text` into a field, one input event per character, as a user does. */
function type(input: HTMLInputElement, text: string): void {
  input.value = '';
  for (const char of text) {
    input.value += char;
    input.dispatchEvent(new Event('input'));
  }
}

const enter = (input: HTMLElement) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  mounted.length = 0;
});

describe('ParamsPanel value writes on a host that edits source', () => {
  it('writes a value typed on a row into that row, on Enter — once, not again on the blur after it', async () => {
    const { panel, client, control } = mount();
    panel.update(bracketParams(), [], TABLE);
    expect(panel.writesSource).toBe(true);
    const width = control('Width');
    type(width, '55');
    enter(width);
    width.dispatchEvent(new Event('blur'));
    await flush();
    expect(client.writeParam).toHaveBeenCalledTimes(1);
    expect(client.writeParam).toHaveBeenCalledWith('Width', 55, 'Bracket', 'M8');
    expect(client.setParam).not.toHaveBeenCalled();
  });

  it('writes on Default — the literal — and in a file with no table, whose only configuration is Default', async () => {
    const { panel, client, control } = mount();
    const onDefault = bracketParams().map((p) => ({ ...p, currentValue: p.defaultValue, configuredValue: undefined }));
    panel.update(onDefault, [], { ...TABLE, active: 'Default' });
    type(control('Width'), '64');
    enter(control('Width'));
    await flush();
    expect(client.writeParam).toHaveBeenLastCalledWith('Width', 64, 'Bracket', 'Default');

    panel.update(onDefault);
    type(control('Width'), '70');
    control('Width').dispatchEvent(new Event('blur'));
    await flush();
    expect(client.writeParam).toHaveBeenLastCalledWith('Width', 70, 'Bracket', 'Default');
    expect(client.writeParam).toHaveBeenCalledTimes(2);
    expect(client.setParam).not.toHaveBeenCalled();
  });

  it('never writes on keystrokes: typing waits for Enter or blur however long it pauses', async () => {
    vi.useFakeTimers();
    const { panel, client, control } = mount();
    panel.update(bracketParams(), [], TABLE);
    type(control('Width'), '5');
    vi.advanceTimersByTime(2000);
    type(control('Width'), '57');
    vi.advanceTimersByTime(2000);
    expect(client.writeParam).not.toHaveBeenCalled();
    control('Width').dispatchEvent(new Event('blur'));
    expect(client.writeParam).toHaveBeenCalledTimes(1);
    expect(client.writeParam).toHaveBeenCalledWith('Width', 57, 'Bracket', 'M8');
  });

  it('a field left unchanged writes nothing; Escape puts the value back; a field with no number is put back unsent', async () => {
    const { panel, client, control } = mount();
    panel.update(bracketParams(), [], TABLE);
    const width = control('Width');
    width.dispatchEvent(new Event('blur'));
    enter(width);
    type(width, '80');
    width.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(width.value).toBe('50');
    width.dispatchEvent(new Event('blur'));
    type(width, '');
    enter(width);
    expect(width.value).toBe('50');
    await flush();
    expect(client.writeParam).not.toHaveBeenCalled();
  });

  it('a slider writes once, on release, not while it is dragged', async () => {
    const { panel, client, control, host } = mount();
    panel.update(bracketParams(), [], TABLE);
    const slider = control('Thickness');
    for (const value of ['5.5', '6', '6.5', '7']) {
      slider.value = value;
      slider.dispatchEvent(new Event('input'));
    }
    expect(client.writeParam).not.toHaveBeenCalled();
    // The readout follows the thumb meanwhile.
    expect(host.querySelector('[data-param-display]')!.textContent).toBe('7');
    slider.dispatchEvent(new Event('change'));
    await flush();
    expect(client.writeParam).toHaveBeenCalledTimes(1);
    expect(client.writeParam).toHaveBeenCalledWith('Thickness', 7, 'Bracket', 'M8');
  });

  it('a select and a toggle write once per change', async () => {
    const { panel, client, control } = mount();
    panel.update(bracketParams(), [], TABLE);
    const screw = control<HTMLSelectElement>('Screw');
    screw.value = 'M10';
    screw.dispatchEvent(new Event('change'));
    const gusset = control('Gusset');
    gusset.checked = true;
    gusset.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(client.writeParam).toHaveBeenCalledTimes(2));
    expect(client.writeParam).toHaveBeenNthCalledWith(1, 'Screw', 'M10', 'Bracket', 'M8');
    expect(client.writeParam).toHaveBeenNthCalledWith(2, 'Gusset', true, 'Bracket', 'M8');
  });

  it('runs writes one at a time: a waiting write of a parameter is replaced by its newer value', async () => {
    const { panel, client, control } = mount();
    panel.update(bracketParams(), [], TABLE);
    const landings: ((value: { success: boolean }) => void)[] = [];
    vi.mocked(client.writeParam).mockImplementation(() => new Promise((resolve) => {
      landings.push(resolve);
    }));
    const width = control('Width');
    type(width, '51');
    enter(width);
    type(width, '52');
    enter(width);
    const gusset = control('Gusset');
    gusset.checked = true;
    gusset.dispatchEvent(new Event('change'));
    type(width, '53');
    enter(width);
    // Only the first is running; Width 52 waits and is replaced by 53.
    expect(client.writeParam).toHaveBeenCalledTimes(1);
    landings[0]({ success: true });
    await vi.waitFor(() => expect(client.writeParam).toHaveBeenCalledTimes(2));
    landings[1]({ success: true });
    await vi.waitFor(() => expect(client.writeParam).toHaveBeenCalledTimes(3));
    landings[2]({ success: true });
    expect(vi.mocked(client.writeParam).mock.calls.map((call) => [call[0], call[1]]))
      .toEqual([['Width', 51], ['Width', 53], ['Gusset', true]]);
  });

  it('reports a refused write and puts the control back to the value the source still holds', async () => {
    const { panel, client, control } = mount();
    panel.update(bracketParams(), [], TABLE);
    vi.mocked(client.writeParam).mockResolvedValueOnce({
      success: false, reason: 'the configurations() table is not an object literal — edit it in the code instead',
    });
    type(control('Width'), '99');
    enter(control('Width'));
    await vi.waitFor(() => expect(panel.onError).toHaveBeenCalledWith(
      'Couldn\'t change Width: the configurations() table is not an object literal — edit it in the code instead',
    ));
    expect(control('Width').value).toBe('50');
  });

  it('takes the table the answer carries, ahead of the render', async () => {
    const { panel, client, control, host } = mount();
    panel.update(bracketParams(), [], TABLE);
    vi.mocked(client.writeParam).mockResolvedValueOnce({
      success: true,
      configurations: { ...TABLE, rows: { ...TABLE.rows, M8: { Screw: 'M8', Width: 55 } } },
    });
    type(control('Width'), '55');
    enter(control('Width'));
    await flush();
    expect(host.querySelector<HTMLSelectElement>('[data-configuration]')!.value).toBe('M8');
  });

  describe('↺ on a parameter the row sets', () => {
    const inheritOf = (rowOf: (label: string) => Element, label: string) =>
      rowOf(label).querySelector<HTMLButtonElement>('[data-param-inherit]');

    it('shows beside a bold label only, and clears the row\'s cell through the client', async () => {
      const { panel, client, rowOf } = mount();
      panel.update(bracketParams(), [], TABLE);
      expect(inheritOf(rowOf, 'Width')).not.toBeNull();
      expect(inheritOf(rowOf, 'Screw')).not.toBeNull();
      expect(inheritOf(rowOf, 'Thickness')).toBeNull();
      expect(rowOf('Thickness').querySelector('[data-param-default-hint]')).not.toBeNull();
      inheritOf(rowOf, 'Width')!.click();
      await flush();
      expect(client.writeParam).toHaveBeenCalledWith('Width', null, 'Bracket', 'M8');
    });

    it('is not on Default, nor on a read-only host', () => {
      const editing = mount();
      editing.panel.update(bracketParams(), [], { ...TABLE, active: 'Default' });
      expect(editing.host.querySelector('[data-param-inherit]')).toBeNull();
      const readOnly = mount({ editor: false });
      readOnly.panel.update(bracketParams(), [], TABLE);
      expect(readOnly.host.querySelector('[data-param-inherit]')).toBeNull();
      expect(readOnly.rowOf('Width').querySelector('label')!.className).toContain('font-semibold');
    });

    it('reports a refusal', async () => {
      const { panel, client, rowOf } = mount();
      panel.update(bracketParams(), [], TABLE);
      vi.mocked(client.writeParam).mockResolvedValueOnce({ success: false, reason: 'M8 does not set Width' });
      inheritOf(rowOf, 'Width')!.click();
      await vi.waitFor(() => expect(panel.onError).toHaveBeenCalledWith('Couldn\'t reset Width to its default: M8 does not set Width'));
    });
  });
});

describe('ParamsPanel on a read-only host', () => {
  it.each([
    ['no editor', { editor: false }],
    ['a client that cannot write source', { writes: false }],
  ])('with %s keeps session tweaks: setParam as the user types, nothing written', (_name, opts) => {
    vi.useFakeTimers();
    const { panel, client, control } = mount(opts);
    panel.update(bracketParams(), [], TABLE);
    expect(panel.writesSource).toBe(false);
    type(control('Width'), '57');
    vi.advanceTimersByTime(500);
    expect(client.setParam).toHaveBeenCalledWith('Width', 57, 'Bracket');
    const slider = control('Thickness');
    slider.value = '7';
    slider.dispatchEvent(new Event('change'));
    expect(client.setParam).toHaveBeenLastCalledWith('Thickness', 7, 'Bracket');
    expect((client as { writeParam?: unknown }).writeParam === undefined
      || vi.mocked((client as { writeParam: ReturnType<typeof vi.fn> }).writeParam).mock.calls.length === 0).toBe(true);
  });
});
