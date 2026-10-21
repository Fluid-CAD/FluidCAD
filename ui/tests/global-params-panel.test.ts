// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The project Parameters column: one section per `*.params.js` file, the
// same controls the model's Parameters section draws, an identifier chip on
// every row, derived exports read-only. A value edit is a source write
// (POST api/global-params/set) — debounced for typed fields, on release for
// a slider — and the push that answers it redraws in place.

import { GlobalParamsPanel, type GlobalParamsPanelHandlers } from '../src/ui/global-params-panel';
import { GLOBAL_PANEL_WIDTH_VARIABLE } from '../src/ui/rail-styles';
import type { GlobalParam, GlobalParamsSnapshot } from '../src/types';

if (typeof globalThis.CSS === 'undefined') {
  (globalThis as any).CSS = { escape: (value: string) => value };
}

const FILE = '/ws/project.params.js';

function param(overrides: Partial<GlobalParam>): GlobalParam {
  return {
    file: FILE,
    relPath: 'project.params.js',
    name: 'wall',
    label: 'Wall thickness',
    controlType: 'number',
    defaultValue: 3,
    value: 3,
    derived: false,
    numeric: true,
    line: 3,
    column: 0,
    ...overrides,
  };
}

function snapshot(params: GlobalParam[], problems: string[] = []): GlobalParamsSnapshot {
  return {
    projectUnit: 'mm',
    files: params.length === 0 && problems.length === 0
      ? []
      : [{ file: FILE, relPath: 'project.params.js', params, problems }],
  };
}

const WALL = param({});
const CLEARANCE = param({ name: 'clearance', label: 'Clearance', controlType: 'slider', defaultValue: 0.2, value: 0.2, min: 0, max: 1, step: 0.05, line: 4 });
const FINISH = param({ name: 'finish', label: 'Finish', controlType: 'select', defaultValue: 'matte', value: 'matte', numeric: false, options: [{ label: 'Matte', value: 'matte' }, { label: 'Gloss', value: 'gloss' }], group: 'Looks', line: 5 });
const HALF = param({ name: 'halfWall', label: 'halfWall', derived: true, expression: 'wall / 2', value: 1.5, defaultValue: 1.5, line: 7 });

function mount(initial: GlobalParamsSnapshot | null = snapshot([WALL, CLEARANCE, FINISH, HALF])) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const handlers: GlobalParamsPanelHandlers = {
    fetch: vi.fn(async () => initial),
    setValue: vi.fn(async () => ({ success: true })),
    openFile: vi.fn(),
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onError: vi.fn(),
    onOpenChange: vi.fn(),
  };
  const panel = new GlobalParamsPanel(container, handlers);
  const open = async () => {
    panel.setOpen(true);
    await vi.waitFor(() => expect(container.querySelector('[data-param-label]') ?? container.textContent).toBeTruthy());
    // The fetch resolves on a microtask; let the render land.
    await Promise.resolve();
    await Promise.resolve();
  };
  const control = <T extends HTMLElement>(label: string) =>
    container.querySelector<T>(`[data-param-label="${label}"]`)!;
  return { container, panel, handlers, open, control };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty(GLOBAL_PANEL_WIDTH_VARIABLE);
  vi.useRealTimers();
  // jsdom has no scrollIntoView; the showFile tests stub it.
  delete (HTMLElement.prototype as any).scrollIntoView;
});

describe('GlobalParamsPanel', () => {
  it('starts hidden, fetches on first open and publishes its width while open', async () => {
    const { container, panel, handlers, open } = mount();
    const column = container.querySelector<HTMLElement>('[data-global-params]')!;
    expect(column.classList.contains('hidden')).toBe(true);
    expect(handlers.fetch).not.toHaveBeenCalled();

    await open();
    expect(handlers.fetch).toHaveBeenCalledTimes(1);
    expect(column.classList.contains('hidden')).toBe(false);
    expect(panel.isOpen).toBe(true);
    expect(document.documentElement.style.getPropertyValue(GLOBAL_PANEL_WIDTH_VARIABLE)).toContain('260px');
    expect(handlers.onOpenChange).toHaveBeenCalledTimes(1);

    panel.toggle();
    expect(column.classList.contains('hidden')).toBe(true);
    expect(document.documentElement.style.getPropertyValue(GLOBAL_PANEL_WIDTH_VARIABLE)).toBe('');
    // A second open does not fetch again — the push keeps it current.
    panel.toggle();
    expect(handlers.fetch).toHaveBeenCalledTimes(1);
  });

  it('renders one section per file with a row, control and identifier chip per export', async () => {
    const { container, open, control } = mount();
    await open();
    const headers = Array.from(container.querySelectorAll('[data-ref="chevron"] + span'), (el) => el.textContent);
    expect(headers).toEqual(['project.params.js']);

    expect(control<HTMLInputElement>('Wall thickness').type).toBe('number');
    expect(control<HTMLInputElement>('Wall thickness').value).toBe('3');
    expect(control<HTMLInputElement>('Clearance').type).toBe('range');
    expect(control<HTMLSelectElement>('Finish').tagName).toBe('SELECT');
    const chips = Array.from(container.querySelectorAll('[data-param-name]'), (el) => el.textContent);
    // Ungrouped rows first, then each group's — the model section's order.
    expect(chips).toEqual(['wall', 'clearance', 'halfWall', 'finish']);
    // `group` folds rows under a collapse card, as in the model's section.
    const group = container.querySelector<HTMLElement>('[data-param-group="Looks"]')!;
    expect(group.contains(control('Finish'))).toBe(true);
  });

  it('posts a typed number 500 ms after the last keystroke, as a number', async () => {
    vi.useFakeTimers();
    const { handlers, open, control } = mount();
    await open();
    const input = control<HTMLInputElement>('Wall thickness');
    input.value = '4';
    input.dispatchEvent(new Event('input'));
    input.value = '4.5';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(499);
    expect(handlers.setValue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handlers.setValue).toHaveBeenCalledTimes(1);
    expect(handlers.setValue).toHaveBeenCalledWith(FILE, 'Wall thickness', 4.5);
  });

  it('flushes a pending typed value on blur', async () => {
    vi.useFakeTimers();
    const { handlers, open, control } = mount();
    await open();
    const input = control<HTMLInputElement>('Wall thickness');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    expect(handlers.setValue).toHaveBeenCalledWith(FILE, 'Wall thickness', 5);
    vi.advanceTimersByTime(600);
    expect(handlers.setValue).toHaveBeenCalledTimes(1);
  });

  it('posts a slider on change only, previewing the readout while dragging', async () => {
    const { container, handlers, open, control } = mount();
    await open();
    const slider = control<HTMLInputElement>('Clearance');
    slider.value = '0.5';
    slider.dispatchEvent(new Event('input'));
    expect(container.querySelector('[data-param-display="Clearance"]')!.textContent).toBe('0.5');
    expect(handlers.setValue).not.toHaveBeenCalled();
    slider.dispatchEvent(new Event('change'));
    expect(handlers.setValue).toHaveBeenCalledWith(FILE, 'Clearance', 0.5);
  });

  it('posts a select on change', async () => {
    const { handlers, open, control } = mount();
    await open();
    const select = control<HTMLSelectElement>('Finish');
    select.value = 'gloss';
    select.dispatchEvent(new Event('change'));
    expect(handlers.setValue).toHaveBeenCalledWith(FILE, 'Finish', 'gloss');
  });

  it('surfaces a refused write through onError', async () => {
    const { handlers, open, control } = mount();
    vi.mocked(handlers.setValue).mockResolvedValueOnce({ success: false, reason: 'read-only file' });
    await open();
    const select = control<HTMLSelectElement>('Finish');
    select.value = 'gloss';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalledWith('read-only file'));
  });

  it('draws a derived export read-only: identifier, expression, value, and a pencil that opens the file', async () => {
    const { container, handlers, open } = mount();
    await open();
    const row = container.querySelector<HTMLElement>('[data-derived-row="halfWall"]')!;
    expect(row.querySelector('[data-param-label]')).toBeNull();
    expect(row.textContent).toContain('wall / 2');
    expect(row.querySelector('[data-derived-value="halfWall"]')!.textContent).toBe('1.5');
    row.querySelector<HTMLButtonElement>('[data-derived-open]')!.click();
    expect(handlers.openFile).toHaveBeenCalledWith(FILE, 7, 0);
  });

  it('opens the dialog on a row from its pencil, and the file from the header', async () => {
    const { container, handlers, open } = mount();
    await open();
    container.querySelector<HTMLButtonElement>('[data-param-edit="Clearance"]')!.click();
    expect(handlers.onEdit).toHaveBeenCalledWith(CLEARANCE);
    container.querySelector<HTMLButtonElement>('[data-open-file]')!.click();
    expect(handlers.openFile).toHaveBeenCalledWith(FILE, 3, 0);
    container.querySelector<HTMLButtonElement>('[data-add-global]')!.click();
    expect(handlers.onAdd).toHaveBeenCalledWith(FILE);
  });

  it('marks a row with problems with the warning triangle carrying them', async () => {
    const { container, open } = mount(snapshot([param({ problems: ['Reads a part-unit value'] })]));
    await open();
    const mark = container.querySelector<HTMLElement>('[data-warning]')!;
    expect(mark.title).toBe('Reads a part-unit value');
    expect(container.querySelector('[data-param-label="Wall thickness"]')).not.toBeNull();
  });

  it('shows the empty state, whose + creates the first params file', async () => {
    const { container, handlers, open } = mount(snapshot([]));
    await open();
    expect(container.textContent).toContain('No project parameters yet');
    expect(container.textContent).toContain('project.params.js');
    container.querySelector<HTMLButtonElement>('[data-add-global]')!.click();
    expect(handlers.onAdd).toHaveBeenCalledWith(null);
  });

  it('updates values in place on a push that changed nothing else, and redraws otherwise', async () => {
    const { container, panel, open, control } = mount();
    await open();
    const before = control<HTMLInputElement>('Wall thickness');
    panel.update(snapshot([param({ value: 8 }), CLEARANCE, FINISH, param({ ...HALF, value: 4 })]));
    expect(control<HTMLInputElement>('Wall thickness')).toBe(before);
    expect(before.value).toBe('8');
    expect(container.querySelector('[data-derived-value="halfWall"]')!.textContent).toBe('4');

    // A slider whose bounds moved has to be redrawn to honour them.
    panel.update(snapshot([param({ value: 8 }), { ...CLEARANCE, max: 2 }, FINISH, HALF]));
    expect(control<HTMLInputElement>('Wall thickness')).not.toBe(before);
    expect(control<HTMLInputElement>('Clearance').max).toBe('2');
  });

  it('keeps a typed field the user is in untouched by a push', async () => {
    const { panel, open, control } = mount();
    await open();
    const input = control<HTMLInputElement>('Wall thickness');
    input.focus();
    input.value = '12';
    panel.update(snapshot([param({ value: 8 }), CLEARANCE, FINISH, HALF]));
    expect(input.value).toBe('12');
  });

  it('showFile opens the column and, once the catalog lands, unfolds and scrolls to that file', async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    const { container, panel, handlers } = mount();
    const chevron = () => container.querySelector<HTMLElement>('[data-ref="chevron"]')!;

    panel.showFile(FILE);
    expect(panel.isOpen).toBe(true);
    expect(handlers.fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(container.querySelector('[data-param-label]')).not.toBeNull());
    expect(chevron().classList.contains('rotate-90')).toBe(true);
    expect(scrolled).toHaveBeenCalledTimes(1);

    // A folded section unfolds when its file is opened again.
    chevron().closest<HTMLElement>('.cursor-pointer')!.click();
    expect(chevron().classList.contains('rotate-90')).toBe(false);
    panel.showFile(FILE);
    expect(chevron().classList.contains('rotate-90')).toBe(true);
    expect(scrolled).toHaveBeenCalledTimes(2);
  });

  it('showFile forgets a file the catalog never listed once the column closes', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const { container, panel } = mount();
    panel.showFile('/ws/other.params.js');
    await vi.waitFor(() => expect(container.querySelector('[data-param-label]')).not.toBeNull());
    panel.setOpen(false);

    // The file shows up later; nothing jumps to it on its own.
    panel.update({
      projectUnit: 'mm',
      files: [{ file: '/ws/other.params.js', relPath: 'other.params.js', params: [param({ file: '/ws/other.params.js' })], problems: [] }],
    });
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
