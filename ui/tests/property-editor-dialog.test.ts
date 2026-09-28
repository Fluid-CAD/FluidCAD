// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Add/Edit-property dialog: a new declaration goes into the chosen part
// with the value written verbatim as an expression, the value field offers
// that part's variables, editing seeds the field from the declaration's
// source text (the render only carries the computed value), and a delete
// warns before it breaks consumers.

vi.mock('../src/api', () => ({
  addProperty: vi.fn(async () => ({ success: true })),
  updateProperty: vi.fn(async () => ({ success: true })),
  removeProperty: vi.fn(async () => ({ success: true })),
  getPropertyUsage: vi.fn(async () => null),
  getScopeVariables: vi.fn(async () => []),
}));

import * as api from '../src/api';
import { PropertyEditorDialog } from '../src/ui/property-editor-dialog';
import type { UIPropertyDefinition } from '../src/types';

const FILE = '/ws/model.fluid.js';
const bracket = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
const lid = { name: 'Lid', sourceLocation: { filePath: FILE, line: 13, column: 0 } };

function mount(): { dialog: PropertyEditorDialog; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const dialog = new PropertyEditorDialog(root);
  dialog.setPartProvider(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));
  return { dialog, root };
}

const ref = <T extends HTMLElement>(root: HTMLElement, name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.mocked(api.addProperty).mockClear();
  vi.mocked(api.updateProperty).mockClear();
  vi.mocked(api.removeProperty).mockClear();
  vi.mocked(api.getPropertyUsage).mockReset().mockResolvedValue(null);
  vi.mocked(api.getScopeVariables).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PropertyEditorDialog create', () => {
  it('posts the name, the expression verbatim and the chosen part', async () => {
    const { dialog, root } = mount();
    dialog.openForCreate(bracket.sourceLocation);
    expect(ref<HTMLSelectElement>(root, 'part').selectedOptions[0].textContent).toBe('Bracket');
    // The value field offers the chosen part's variables, not the active part's.
    expect(api.getScopeVariables).toHaveBeenCalledWith(null, undefined, bracket.sourceLocation);

    ref<HTMLInputElement>(root, 'name').value = 'innerWidth';
    ref<HTMLInputElement>(root, 'value').value = 'width - 2 * wall';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(api.addProperty).toHaveBeenCalledWith(
      { name: 'innerWidth', expression: 'width - 2 * wall' },
      bracket.sourceLocation,
    );
    expect(root.querySelector('.hidden.fixed.inset-0, .fixed.inset-0.hidden')).not.toBeNull();
  });

  it('re-fetches variables when another part is chosen', async () => {
    const { dialog, root } = mount();
    dialog.openForCreate();
    const part = ref<HTMLSelectElement>(root, 'part');
    expect(part.selectedOptions[0].textContent).toBe('Lid');
    part.value = '0';
    part.dispatchEvent(new Event('change'));
    expect(api.getScopeVariables).toHaveBeenLastCalledWith(null, undefined, bracket.sourceLocation);

    ref<HTMLInputElement>(root, 'name').value = 'boltCount';
    ref<HTMLInputElement>(root, 'value').value = '4';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(api.addProperty).toHaveBeenCalledWith({ name: 'boltCount', expression: '4' }, bracket.sourceLocation);
  });

  it('refuses a missing or non-identifier name and an empty value without posting', async () => {
    const { dialog, root } = mount();
    dialog.openForCreate();
    const message = ref(root, 'message');
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(message.textContent).toContain('name');
    ref<HTMLInputElement>(root, 'name').value = 'inner width';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(message.textContent).toContain('plain identifier');
    ref<HTMLInputElement>(root, 'name').value = 'innerWidth';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(message.textContent).toContain('value');
    expect(api.addProperty).not.toHaveBeenCalled();
  });

  it('stays open with the server reason when the edit is refused', async () => {
    vi.mocked(api.addProperty).mockResolvedValueOnce({ success: false, reason: 'this part already declares a property named "x"' });
    const { dialog, root } = mount();
    dialog.openForCreate();
    ref<HTMLInputElement>(root, 'name').value = 'x';
    ref<HTMLInputElement>(root, 'value').value = '1';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(ref(root, 'message').textContent).toContain('already declares');
    expect(root.firstElementChild!.classList.contains('hidden')).toBe(false);
  });
});

describe('PropertyEditorDialog edit', () => {
  const def: UIPropertyDefinition = {
    name: 'innerWidth', value: 52,
    sourceLocation: { filePath: FILE, line: 9, column: 2 }, part: bracket.sourceLocation,
  };

  it('seeds from the declaration source, hides the part row, and posts an update against the target', async () => {
    vi.mocked(api.getPropertyUsage).mockResolvedValue({
      name: 'innerWidth', expression: 'width - 2 * wall',
      variable: null, references: 0, referenceLines: [], editable: true,
    });
    const { dialog, root } = mount();
    dialog.openForEdit(def);
    // The computed value stands in until the source text arrives.
    expect(ref<HTMLInputElement>(root, 'value').value).toBe('52');
    expect(ref(root, 'part-row').classList.contains('hidden')).toBe(true);
    expect(api.getScopeVariables).toHaveBeenCalledWith(9, undefined, null);
    await flush();
    expect(ref<HTMLInputElement>(root, 'value').value).toBe('width - 2 * wall');

    ref<HTMLInputElement>(root, 'name').value = 'pocketWidth';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(api.updateProperty).toHaveBeenCalledWith(
      { name: 'innerWidth', line: 9, filePath: FILE },
      { name: 'pocketWidth', expression: 'width - 2 * wall' },
    );
  });

  it('reports a declaration the editor cannot rewrite, and names the bound variable', async () => {
    vi.mocked(api.getPropertyUsage).mockResolvedValue({
      name: 'innerWidth', expression: '52', variable: 'inner', references: 2, referenceLines: [12, 14],
      editable: false, reason: 'this property() call has a chained method — edit it in the code instead',
    });
    const { dialog, root } = mount();
    dialog.openForEdit(def);
    await flush();
    expect(ref(root, 'message').textContent).toContain('chained method');
    expect(ref(root, 'binding-note').textContent).toContain('Bound to inner');
  });

  it('asks before deleting, naming the readers of a bound variable, then posts the removal', async () => {
    vi.mocked(api.getPropertyUsage).mockResolvedValue({
      name: 'innerWidth', expression: '52', variable: 'inner', references: 2, referenceLines: [12, 14],
      editable: true,
    });
    const { dialog, root } = mount();
    dialog.openForEdit(def);
    await flush();
    ref<HTMLButtonElement>(root, 'delete').click();
    const confirm = ref(root, 'confirm-text').textContent!;
    expect(confirm).toContain('inner is read 2 times (line 12, 14)');
    expect(confirm).toContain('instance.properties.innerWidth');
    expect(api.removeProperty).not.toHaveBeenCalled();
    ref<HTMLButtonElement>(root, 'confirm-delete').click();
    await flush();
    expect(api.removeProperty).toHaveBeenCalledWith({ name: 'innerWidth', line: 9, filePath: FILE });
  });
});
