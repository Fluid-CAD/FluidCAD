// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', () => ({
  getPartCatalogFiles: vi.fn(), scanPartCatalogFile: vi.fn(), getScopeVariables: vi.fn(),
  insertCatalogParts: vi.fn(), getInsertParamExpressions: vi.fn(), updateInsertParams: vi.fn(),
}));
vi.mock('../src/ui/insert-part/part-thumbnails', () => ({
  PartThumbnailRenderer: class { render() { return null; } dispose() {} },
}));
import * as api from '../src/api';
import { InsertPartDialog } from '../src/ui/insert-part/insert-part-dialog';
import { EditParamsDialog } from '../src/ui/edit-params-dialog';

const definition = { label: 'Length', controlType: 'number' as const, defaultValue: 50, currentValue: 50 };
let root: HTMLElement;
let dialog: InsertPartDialog | EditParamsDialog;
beforeEach(() => {
  vi.clearAllMocks();
  root = document.createElement('div');
  document.body.append(root);
  vi.mocked(api.getScopeVariables).mockResolvedValue([{ name: 'width', initializer: "param('Width', 100)", numeric: true }]);
  vi.mocked(api.getPartCatalogFiles).mockResolvedValue([{ absPath: '/ws/beam.part.js', path: 'beam.part.js' }] as any);
  vi.mocked(api.scanPartCatalogFile).mockResolvedValue({
    parts: [{ exportName: 'beam', partName: 'Beam', kind: 'value', params: [definition], objects: [] }],
    assemblies: [], errors: [],
  } as any);
  vi.mocked(api.insertCatalogParts).mockResolvedValue({ success: true });
  vi.mocked(api.getInsertParamExpressions).mockResolvedValue({ Length: 'width / 2' });
  vi.mocked(api.updateInsertParams).mockResolvedValue({ success: true });
});
afterEach(() => { dialog?.hide(); root.remove(); });
function click(ref: string) { root.querySelector<HTMLButtonElement>(`[data-ref="${ref}"]`)!.click(); }
function type(value: string) {
  const input = root.querySelector<HTMLInputElement>('[data-ref="page-host"] input, [data-ref="form-host"] input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}
async function insertForm() {
  dialog = new InsertPartDialog(root);
  dialog.show('/ws/frame.assembly.js');
  await vi.waitFor(() => expect(root.querySelector('[data-kind="part"]')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('[data-kind="part"]')!.click();
  click('next-btn');
}

describe('instance parameter dialogs', () => {
  it('loads assembly scope and submits expression overrides from Insert', async () => {
    await insertForm();
    expect(api.getScopeVariables).toHaveBeenCalledWith(null, 'assembly');
    type('width / 2');
    click('next-page');
    await vi.waitFor(() => expect(api.insertCatalogParts).toHaveBeenCalledWith([
      { file: '/ws/beam.part.js', exportName: 'beam', kind: 'value', params: { Length: { expr: 'width / 2' } } },
    ], undefined));
  });

  it('keeps invalid Insert inputs open and never submits partial changes', async () => {
    await insertForm();
    type('');
    click('next-page');
    expect(api.insertCatalogParts).not.toHaveBeenCalled();
    expect(root.querySelector('[data-ref="status"]')!.textContent).toContain('enter a value');
  });

  it('Escape first dismisses suggestions, then the Insert dialog', async () => {
    await insertForm();
    const input = type('wid');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.firstElementChild!.classList.contains('hidden')).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.firstElementChild!.classList.contains('hidden')).toBe(true);
  });

  it('loads source expressions in Edit Parameters and submits changed references', async () => {
    dialog = new EditParamsDialog(root);
    dialog.show({ title: 'Beam', subtitle: '', defs: [definition], currentValues: { Length: 50 }, filePath: '/ws/frame.assembly.js', line: 5 });
    await vi.waitFor(() => expect(root.querySelector('input')?.value).toBe('width / 2'));
    expect(api.getScopeVariables).toHaveBeenCalledWith(5);
    type('width - 20');
    click('apply-btn');
    await vi.waitFor(() => expect(api.updateInsertParams).toHaveBeenCalledWith(
      '/ws/frame.assembly.js', 5, { Length: { expr: 'width - 20' } }, [], undefined,
    ));
  });

  it('keeps a reopened Insert dialog intact when an earlier submission finishes', async () => {
    let finish!: (value: { success: boolean }) => void;
    vi.mocked(api.insertCatalogParts).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await insertForm();
    type('width / 2');
    click('next-page');
    dialog.hide();
    (dialog as InsertPartDialog).show('/ws/frame.assembly.js');
    await vi.waitFor(() => expect(api.getPartCatalogFiles).toHaveBeenCalledTimes(2));
    finish({ success: true });
    await Promise.resolve();
    expect(root.firstElementChild!.classList.contains('hidden')).toBe(false);
  });

  it('Insert: a Configuration select fills the form with the row and posts it with only the differing values', async () => {
    vi.mocked(api.scanPartCatalogFile).mockResolvedValue({
      parts: [{
        exportName: 'beam', partName: 'Beam', kind: 'value', params: [definition], objects: [],
        configurations: [{ name: 'Long', values: { Length: 80 } }, { name: 'Bare', values: {} }],
      }],
      assemblies: [], errors: [],
    } as any);
    await insertForm();
    const select = root.querySelector<HTMLSelectElement>('[data-insert-configuration]')!;
    expect(Array.from(select.options, (o) => o.value)).toEqual(['Default', 'Long', 'Bare']);
    expect(select.value).toBe('Default');
    const input = () => root.querySelector<HTMLInputElement>('[data-ref="page-host"] input')!;
    expect(input().value).toBe('50');

    select.value = 'Long';
    select.dispatchEvent(new Event('change'));
    expect(input().value).toBe('80');
    // Back to the default's value: it differs from the row's, so it travels.
    type('50');
    click('next-page');
    await vi.waitFor(() => expect(api.insertCatalogParts).toHaveBeenCalledWith([
      { file: '/ws/beam.part.js', exportName: 'beam', kind: 'value', params: { Length: 50 }, configuration: 'Long' },
    ], undefined));
  });

  it('Insert: an untouched row posts the configuration alone; a row without the cell shows the default', async () => {
    vi.mocked(api.scanPartCatalogFile).mockResolvedValue({
      parts: [{
        exportName: 'beam', partName: 'Beam', kind: 'value', params: [definition], objects: [],
        configurations: [{ name: 'Long', values: { Length: 80 } }, { name: 'Bare', values: {} }],
      }],
      assemblies: [], errors: [],
    } as any);
    await insertForm();
    const select = root.querySelector<HTMLSelectElement>('[data-insert-configuration]')!;
    select.value = 'Bare';
    select.dispatchEvent(new Event('change'));
    expect(root.querySelector<HTMLInputElement>('[data-ref="page-host"] input')!.value).toBe('50');
    select.value = 'Long';
    select.dispatchEvent(new Event('change'));
    click('next-page');
    await vi.waitFor(() => expect(api.insertCatalogParts).toHaveBeenCalledWith([
      { file: '/ws/beam.part.js', exportName: 'beam', kind: 'value', configuration: 'Long' },
    ], undefined));
  });

  it('Insert: no select without a table', async () => {
    await insertForm();
    expect(root.querySelector('[data-insert-configuration]')).toBeNull();
  });

  it('Edit Parameters: the Configuration select opens on the statement\'s row and Apply sends a change', async () => {
    dialog = new EditParamsDialog(root);
    dialog.show({
      title: 'Beam', subtitle: '', defs: [definition], currentValues: { Length: 80 },
      filePath: '/ws/frame.assembly.js', line: 5, configuration: 'Long', configurations: ['Long', 'Short'],
    });
    await vi.waitFor(() => expect(root.querySelector('[data-ref="form-host"] input')).not.toBeNull());
    const select = root.querySelector<HTMLSelectElement>('[data-ref="configuration"]')!;
    expect(select.closest('[data-ref="configuration-row"]')!.classList.contains('hidden')).toBe(false);
    expect(Array.from(select.options, (o) => o.value)).toEqual(['Default', 'Long', 'Short']);
    expect(select.value).toBe('Long');

    select.value = 'Short';
    click('apply-btn');
    await vi.waitFor(() => expect(api.updateInsertParams).toHaveBeenCalledWith(
      '/ws/frame.assembly.js', 5, {}, [], undefined, 'Short',
    ));
  });

  it('Edit Parameters: Default sends null; an untouched select sends nothing about the row', async () => {
    dialog = new EditParamsDialog(root);
    const options = {
      title: 'Beam', subtitle: '', defs: [definition], currentValues: { Length: 80 },
      filePath: '/ws/frame.assembly.js', line: 5, configuration: 'Long', configurations: ['Long'],
    };
    dialog.show(options);
    await vi.waitFor(() => expect(root.querySelector('[data-ref="form-host"] input')).not.toBeNull());
    const select = root.querySelector<HTMLSelectElement>('[data-ref="configuration"]')!;
    select.value = 'Default';
    click('apply-btn');
    await vi.waitFor(() => expect(api.updateInsertParams).toHaveBeenCalledWith(
      '/ws/frame.assembly.js', 5, {}, [], undefined, null,
    ));

    vi.mocked(api.updateInsertParams).mockClear();
    dialog.show(options);
    await vi.waitFor(() => expect(root.querySelector('[data-ref="form-host"] input')).not.toBeNull());
    // Nothing changed: the dialog just closes.
    click('apply-btn');
    expect(api.updateInsertParams).not.toHaveBeenCalled();
    expect(root.firstElementChild!.classList.contains('hidden')).toBe(true);
  });

  it('Edit Parameters: hides the select when the definition has no table', async () => {
    dialog = new EditParamsDialog(root);
    dialog.show({ title: 'Beam', subtitle: '', defs: [definition], currentValues: { Length: 50 }, filePath: '/ws/frame.assembly.js', line: 5 });
    expect(root.querySelector('[data-ref="configuration-row"]')!.classList.contains('hidden')).toBe(true);
  });

  it('keeps a reopened Edit Parameters dialog intact when an earlier apply finishes', async () => {
    let finish!: (value: { success: boolean }) => void;
    vi.mocked(api.updateInsertParams).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    dialog = new EditParamsDialog(root);
    const options = { title: 'Beam', subtitle: '', defs: [definition], currentValues: { Length: 50 }, filePath: '/ws/frame.assembly.js', line: 5 };
    dialog.show(options);
    await vi.waitFor(() => expect(root.querySelector('input')).not.toBeNull());
    type('width - 20');
    click('apply-btn');
    dialog.hide();
    dialog.show({ ...options, line: 6 });
    finish({ success: true });
    await Promise.resolve();
    expect(root.firstElementChild!.classList.contains('hidden')).toBe(false);
  });
});
