// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Manage-configurations grid (docs/assembly-configurations-plan.md §3.4):
// rows × parameters, a pinned Default row of literals, inherited cells
// dimmed, expression cells read-only, inline renames, add / duplicate /
// delete rows, and ONE commit carrying only what changed.

import { openConfigurationsGrid, type ConfigurationsGridOptions } from '../src/ui/configurations-grid-dialog';
import type { ConfigurationSourceTable, ConfigurationTableCommit } from '../src/api';
import type { UIConfigurations, UIParamDefinition } from '../src/types';

const PARAMS: UIParamDefinition[] = [
  { label: 'Width', kind: 'assembly', defaultValue: 700, currentValue: 700, controlType: 'number' },
  { label: 'Depth', kind: 'assembly', defaultValue: 400, currentValue: 400, controlType: 'slider', min: 0, max: 1000 },
  { label: 'Lid', kind: 'assembly', defaultValue: true, currentValue: true, controlType: 'checkbox' },
  {
    label: 'Finish', kind: 'assembly', defaultValue: 'raw', currentValue: 'raw', controlType: 'select',
    options: [{ label: 'Raw', value: 'raw' }, { label: 'Painted', value: 'paint' }],
  },
];

const RENDERED: UIConfigurations = {
  active: 'Wide',
  names: ['Compact', 'Wide'],
  rows: { Compact: { Width: 500, Lid: false }, Wide: { Width: 1400, Depth: 900 } },
  modified: false,
};

const SOURCE: ConfigurationSourceTable = {
  line: 3,
  rows: {
    Compact: { Width: { literal: 500, text: '500' }, Lid: { literal: false, text: 'false' } },
    Wide: { Width: { text: 'base * 2' }, Depth: { literal: 900, text: '900' }, Note: { literal: 'x', text: "'x'" } },
  },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open(overrides: Partial<ConfigurationsGridOptions> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const commit = vi.fn<(c: ConfigurationTableCommit) => Promise<string | null>>().mockResolvedValue(null);
  const closed = vi.fn();
  void openConfigurationsGrid(host, {
    params: PARAMS,
    configurations: RENDERED,
    loadTable: async () => SOURCE,
    commit,
    ...overrides,
  }).then(closed);
  await flush();
  const grid = () => host.querySelector<HTMLElement>('[data-configurations-grid]');
  const rowEl = (index: number) => grid()!.querySelectorAll<HTMLTableRowElement>('tbody tr:not([data-default-row])')[index];
  const cell = (index: number, label: string) => rowEl(index).querySelector<HTMLElement>(`[data-cell="${label}"]`)!;
  const nameInput = (index: number) => rowEl(index).querySelector<HTMLInputElement>('[data-row-name]')!;
  const apply = () => grid()!.querySelector<HTMLButtonElement>('[data-ref="apply"]')!;
  const button = (ref: string) => grid()!.querySelector<HTMLButtonElement>(`[data-ref="${ref}"]`)!;
  const message = () => grid()!.querySelector<HTMLElement>('[data-ref="message"]')!;
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  /** A paste as a spreadsheet makes it, dispatched at `target` (the focused field). Returns whether the grid took it. */
  const paste = (target: HTMLElement, text: string): boolean => {
    target.focus();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const key = (target: HTMLElement, init: KeyboardEventInit) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  };
  return { host, grid, rowEl, cell, nameInput, apply, button, message, commit, closed, type, paste, key };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('configurations grid', () => {
  it('draws a column per parameter, the Default row of literals, and a row per configuration', async () => {
    const { grid, rowEl, nameInput } = await open();
    const headers = Array.from(grid()!.querySelectorAll('thead th'), (th) => th.textContent);
    // The first is the row-number column.
    expect(headers).toEqual(['', 'Configuration', 'Width', 'Depth', 'Lid', 'Finish']);
    expect(Array.from(grid()!.querySelectorAll('tbody tr:not([data-default-row]) > th'), (th) => th.textContent)).toEqual(['1', '2']);
    const defaults = grid()!.querySelector('[data-default-row]')!;
    expect(Array.from(defaults.querySelectorAll('td'), (td) => td.textContent)).toEqual(['Default', '700', '400', 'Yes', 'Raw']);
    expect(defaults.querySelector('input, select')).toBeNull();
    expect(nameInput(0).value).toBe('Compact');
    expect(nameInput(1).value).toBe('Wide');
    expect(rowEl(2)).toBeUndefined();
  });

  it('shows set cells as controls, inherited ones dimmed with the literal, expressions read-only', async () => {
    const { cell } = await open();
    expect(cell(0, 'Width').dataset.state).toBe('literal');
    expect(cell(0, 'Width').querySelector<HTMLInputElement>('input')!.value).toBe('500');
    expect(cell(0, 'Width').querySelector('[data-cell-reset]')).not.toBeNull();
    expect(cell(0, 'Lid').querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);

    const inherited = cell(0, 'Depth');
    expect(inherited.dataset.state).toBe('inherit');
    // A slider is a number field in the grid.
    expect(inherited.querySelector<HTMLInputElement>('input')!.type).toBe('number');
    expect(inherited.querySelector<HTMLInputElement>('input')!.value).toBe('400');
    expect(inherited.querySelector('.opacity-45')).not.toBeNull();
    expect(inherited.querySelector('[data-cell-reset]')).toBeNull();

    const expr = cell(1, 'Width');
    expect(expr.dataset.state).toBe('expr');
    expect(expr.querySelector('[data-cell-expr]')!.textContent).toBe('base * 2');
    expect(expr.querySelector('input, select')).toBeNull();
  });

  it('keeps Apply disabled until something changes, and commits only the changed cells', async () => {
    const { cell, apply, commit, closed, type } = await open();
    expect(apply().disabled).toBe(true);
    type(cell(0, 'Depth').querySelector<HTMLInputElement>('input')!, '650');
    expect(cell(0, 'Depth').dataset.state).toBe('literal');
    expect(cell(0, 'Depth').querySelector('.opacity-45')).toBeNull();
    expect(cell(0, 'Depth').querySelector('[data-cell-reset]')).not.toBeNull();
    const finish = cell(1, 'Finish').querySelector<HTMLSelectElement>('select')!;
    finish.value = 'paint';
    finish.dispatchEvent(new Event('change'));
    expect(apply().disabled).toBe(false);
    apply().click();
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith({ rows: { Compact: { Depth: 650 }, Wide: { Finish: 'paint' } } });
    expect(closed).toHaveBeenCalled();
  });

  it('↺ clears a cell back to inherit — null in the commit — expressions included', async () => {
    const { cell, apply, commit } = await open();
    cell(0, 'Lid').querySelector<HTMLButtonElement>('[data-cell-reset]')!.click();
    expect(cell(0, 'Lid').dataset.state).toBe('inherit');
    expect(cell(0, 'Lid').querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    cell(1, 'Width').querySelector<HTMLButtonElement>('[data-cell-reset]')!.click();
    expect(cell(1, 'Width').dataset.state).toBe('inherit');
    apply().click();
    await flush();
    expect(commit).toHaveBeenCalledWith({ rows: { Compact: { Lid: null }, Wide: { Width: null } } });
  });

  it('editing a cell back to where it was is no change', async () => {
    const { cell, apply, type } = await open();
    const input = cell(0, 'Width').querySelector<HTMLInputElement>('input')!;
    type(input, '510');
    expect(apply().disabled).toBe(false);
    type(input, '500');
    expect(apply().disabled).toBe(true);
  });

  it('renames inline, validating the name, and commits rename and cells together', async () => {
    const { nameInput, cell, apply, message, commit, type } = await open();
    type(nameInput(1), 'Compact');
    expect(apply().disabled).toBe(true);
    expect(message().textContent).toContain('already exists');
    expect(nameInput(1).getAttribute('aria-invalid')).toBe('true');
    type(nameInput(1), 'Default');
    expect(message().textContent).toContain('reserved');
    type(nameInput(1), 'Broad');
    expect(message().classList.contains('hidden')).toBe(true);
    expect(nameInput(1).getAttribute('aria-invalid')).toBe('false');
    type(cell(1, 'Depth').querySelector<HTMLInputElement>('input')!, '950');
    apply().click();
    await flush();
    expect(commit).toHaveBeenCalledWith({ rows: { Broad: { Depth: 950 } }, renames: { Wide: 'Broad' } });
  });

  it('adds an empty row and duplicates the selected one, expressions copied verbatim', async () => {
    const { rowEl, nameInput, button, cell, apply, commit, type } = await open();
    // The active row is selected on open.
    expect(rowEl(1).dataset.selected).toBe('');
    button('duplicate').click();
    expect(nameInput(2).value).toBe('Wide copy');
    expect(cell(2, 'Width').dataset.state).toBe('expr');
    button('add').click();
    expect(nameInput(3).value).toBe('Configuration');
    expect(rowEl(3).dataset.selected).toBe('');
    type(cell(3, 'Width').querySelector<HTMLInputElement>('input')!, '800');
    apply().click();
    await flush();
    expect(commit).toHaveBeenCalledWith({
      rows: {
        'Wide copy': { Width: { expr: 'base * 2' }, Depth: 900 },
        Configuration: { Width: 800 },
      },
    });
  });

  it('deletes the selected row after asking, and commits it as removed', async () => {
    const confirmDelete = vi.fn<(name: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { rowEl, nameInput, button, apply, commit } = await open({ confirmDelete });
    rowEl(0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(rowEl(0).dataset.selected).toBe('');
    button('delete').click();
    await flush();
    expect(confirmDelete).toHaveBeenCalledWith('Compact');
    expect(nameInput(0).value).toBe('Compact');
    button('delete').click();
    await flush();
    expect(nameInput(0).value).toBe('Wide');
    expect(rowEl(1)).toBeUndefined();
    apply().click();
    await flush();
    expect(commit).toHaveBeenCalledWith({ rows: {}, removed: ['Compact'] });
  });

  it('a new row deleted again is no change', async () => {
    const { button, apply } = await open();
    button('add').click();
    expect(apply().disabled).toBe(false);
    button('delete').click();
    await flush();
    expect(apply().disabled).toBe(true);
  });

  it('shows a refusal in the footer and stays open', async () => {
    const { cell, apply, message, commit, closed, grid, type } = await open();
    commit.mockResolvedValueOnce('the editor did not apply');
    type(cell(0, 'Width').querySelector<HTMLInputElement>('input')!, '510');
    apply().click();
    await flush();
    expect(grid()).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(message().textContent).toBe('the editor did not apply');
    expect(message().classList.contains('hidden')).toBe(false);
    expect(apply().disabled).toBe(false);
  });

  it('Cancel and Escape close without committing', async () => {
    const first = await open();
    first.button('cancel').click();
    await flush();
    expect(first.grid()).toBeNull();
    expect(first.closed).toHaveBeenCalled();
    const second = await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(second.grid()).toBeNull();
    expect(second.commit).not.toHaveBeenCalled();
  });

  it('falls back to the render\'s rows when the source cannot be read', async () => {
    const { cell, nameInput } = await open({ loadTable: async () => null });
    expect(nameInput(1).value).toBe('Wide');
    expect(cell(1, 'Width').dataset.state).toBe('literal');
    expect(cell(1, 'Width').querySelector<HTMLInputElement>('input')!.value).toBe('1400');
  });

  it('notes the length unit when given one', async () => {
    const { grid } = await open({ unit: 'mm' });
    expect(grid()!.querySelector('[data-ref="subtitle"]')!.textContent).toContain('Lengths in mm');
  });

  describe('paste from a spreadsheet', () => {
    it('lays a range with a header row by name, adds rows, and commits it with the rest', async () => {
      const { grid, cell, nameInput, paste, apply, commit, message } = await open();
      const taken = paste(cell(0, 'Depth').querySelector('input')!, 'Configuration\tDepth\tFinish\r\nCompact\t320\tPainted\r\nTall\t880\traw\r\n');
      expect(taken).toBe(true);
      expect(cell(0, 'Depth').dataset.state).toBe('literal');
      expect(cell(0, 'Depth').querySelector('input')!.value).toBe('320');
      expect(cell(0, 'Finish').querySelector('select')!.value).toBe('paint');
      expect(nameInput(2).value).toBe('Tall');
      expect(message().classList.contains('hidden')).toBe(true);
      // The focus stays where the paste was made.
      expect(document.activeElement).toBe(cell(0, 'Depth').querySelector('input'));
      expect(grid()!.querySelector('tr[data-selected]')).toBe(nameInput(0).closest('tr'));
      apply().click();
      await flush();
      expect(commit).toHaveBeenCalledWith({
        rows: { Compact: { Depth: 320, Finish: 'paint' }, Tall: { Depth: 880, Finish: 'raw' } },
      });
    });

    it('lays a range without a header from the focused cell, ignoring the columns past the last one with a warning', async () => {
      const { cell, paste, message } = await open();
      paste(cell(0, 'Lid').querySelector('input')!, 'no\tpaint\textra\nyes\traw\textra\n');
      expect(cell(0, 'Lid').querySelector<HTMLInputElement>('input')!.checked).toBe(false);
      expect(cell(1, 'Lid').querySelector<HTMLInputElement>('input')!.checked).toBe(true);
      expect(cell(1, 'Finish').querySelector('select')!.value).toBe('raw');
      expect(message().classList.contains('hidden')).toBe(false);
      expect(message().dataset.tone).toBe('warning');
      expect(message().textContent).toBe('Ignored 1 column past “Finish”, the grid\'s last column.');
      // The warning can be dismissed.
      message().querySelector<HTMLButtonElement>('[data-ref="message-dismiss"]')!.click();
      expect(message().classList.contains('hidden')).toBe(true);
    });

    it('names rows it adds without a name', async () => {
      const { cell, nameInput, paste } = await open();
      paste(cell(1, 'Depth').querySelector('input')!, '910\n920\n930\n');
      expect(nameInput(2).value).toBe('Configuration');
      expect(nameInput(3).value).toBe('Configuration 2');
      expect(cell(3, 'Depth').querySelector('input')!.value).toBe('930');
    });

    it('changes nothing over a bad value, and says why', async () => {
      const { cell, paste, apply, message } = await open();
      paste(cell(0, 'Depth').querySelector('input')!, '640\nwide\n');
      expect(cell(0, 'Depth').dataset.state).toBe('inherit');
      expect(apply().disabled).toBe(true);
      expect(message().dataset.tone).toBe('error');
      expect(message().textContent).toBe('Nothing was pasted — Wide, Depth: “wide” is not a number.');
    });

    it('leaves plain text to the field\'s own paste', async () => {
      const { cell, paste } = await open();
      expect(paste(cell(0, 'Width').querySelector('input')!, '640')).toBe(false);
    });

    it('pastes from the selected row when no cell has the focus', async () => {
      const { nameInput, paste, cell } = await open();
      // Wide, the active configuration, is selected on open.
      paste(document.body, 'Broad\t1500\n');
      expect(nameInput(1).value).toBe('Broad');
      expect(cell(1, 'Width').dataset.state).toBe('expr');
    });
  });

  describe('keyboard', () => {
    it('Enter and the arrows move down and up a column; a select keeps its arrows', async () => {
      const { cell, nameInput, key } = await open();
      const first = cell(0, 'Width').querySelector('input')!;
      first.focus();
      key(first, { key: 'Enter' });
      // Wide's Width is an expression: nothing to focus, so the focus stays.
      expect(document.activeElement).toBe(first);
      const depth = cell(0, 'Depth').querySelector('input')!;
      depth.focus();
      key(depth, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(cell(1, 'Depth').querySelector('input'));
      key(document.activeElement as HTMLElement, { key: 'Enter', shiftKey: true });
      expect(document.activeElement).toBe(depth);
      nameInput(1).focus();
      key(nameInput(1), { key: 'ArrowUp' });
      expect(document.activeElement).toBe(nameInput(0));
      const finish = cell(0, 'Finish').querySelector('select')!;
      finish.focus();
      key(finish, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(finish);
    });
  });
});
