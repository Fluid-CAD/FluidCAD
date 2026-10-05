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
/** Type a label the way a user does: the read-only Name follows on each keystroke. */
function typeLabel(root: HTMLElement, text: string): void {
  const label = ref<HTMLInputElement>(root, 'label');
  label.value = text;
  label.dispatchEvent(new Event('input'));
}

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
  it('posts the label, the name derived from it, the expression verbatim and the chosen part', async () => {
    const { dialog, root } = mount();
    dialog.openForCreate(bracket.sourceLocation);
    expect(ref<HTMLSelectElement>(root, 'part').selectedOptions[0].textContent).toBe('Bracket');
    // The value field offers the chosen part's variables, not the active part's.
    expect(api.getScopeVariables).toHaveBeenCalledWith(null, undefined, bracket.sourceLocation);

    typeLabel(root, 'Inner width');
    expect(ref<HTMLInputElement>(root, 'name').value).toBe('innerWidth');
    expect(ref<HTMLInputElement>(root, 'name').readOnly).toBe(true);
    ref<HTMLInputElement>(root, 'value').value = 'width - 2 * wall';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(api.addProperty).toHaveBeenCalledWith(
      { label: 'Inner width', name: 'innerWidth', expression: 'width - 2 * wall' },
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

    typeLabel(root, 'Bolt count');
    ref<HTMLInputElement>(root, 'value').value = '4';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(api.addProperty).toHaveBeenCalledWith({ label: 'Bolt count', name: 'boltCount', expression: '4' }, bracket.sourceLocation);
  });

  it('refuses a missing label and an empty value without posting, and makes any label a usable name', async () => {
    const { dialog, root } = mount();
    dialog.openForCreate();
    const message = ref(root, 'message');
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(message.textContent).toContain('label');
    typeLabel(root, '2nd width (mm)');
    expect(ref<HTMLInputElement>(root, 'name').value).toBe('p2ndWidthMm');
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(message.textContent).toContain('value');
    expect(api.addProperty).not.toHaveBeenCalled();
  });

  it('stays open with the server reason when the edit is refused', async () => {
    vi.mocked(api.addProperty).mockResolvedValueOnce({ success: false, reason: 'this part already declares a property named "x"' });
    const { dialog, root } = mount();
    dialog.openForCreate();
    typeLabel(root, 'x');
    ref<HTMLInputElement>(root, 'value').value = '1';
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(ref(root, 'message').textContent).toContain('already declares');
    expect(root.firstElementChild!.classList.contains('hidden')).toBe(false);
  });
});

describe('PropertyEditorDialog edit', () => {
  const def: UIPropertyDefinition = {
    label: 'Inner width', name: 'innerWidth', value: 52,
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

    expect(ref<HTMLInputElement>(root, 'label').value).toBe('Inner width');
    typeLabel(root, 'Pocket width');
    expect(ref<HTMLInputElement>(root, 'name').value).toBe('pocketWidth');
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(api.updateProperty).toHaveBeenCalledWith(
      { name: 'innerWidth', line: 9, filePath: FILE },
      { label: 'Pocket width', name: 'pocketWidth', expression: 'width - 2 * wall' },
    );
  });

  it('keeps a name that does not reduce from its label until the label is edited', async () => {
    vi.mocked(api.getPropertyUsage).mockResolvedValue({
      name: 'Width', label: 'Width', expression: '10', variable: null, references: 0, referenceLines: [], editable: true,
    });
    const { dialog, root } = mount();
    dialog.openForEdit({ ...def, label: 'Width', name: 'Width' });
    await flush();
    expect(ref<HTMLInputElement>(root, 'name').value).toBe('Width');
    ref<HTMLButtonElement>(root, 'save').click();
    await flush();
    expect(api.updateProperty).toHaveBeenCalledWith(
      { name: 'Width', line: 9, filePath: FILE },
      { label: 'Width', name: 'Width', expression: '10' },
    );
  });

  it('reports a declaration the editor cannot rewrite', async () => {
    vi.mocked(api.getPropertyUsage).mockResolvedValue({
      name: 'innerWidth', expression: '52', variable: 'inner', references: 2, referenceLines: [12, 14],
      editable: false, reason: 'this property() call has a chained method — edit it in the code instead',
    });
    const { dialog, root } = mount();
    dialog.openForEdit(def);
    await flush();
    expect(ref(root, 'message').textContent).toContain('chained method');
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

  it('refuses the delete when the value only means something in its own part, naming the reads', async () => {
    vi.mocked(api.getPropertyUsage).mockResolvedValue({
      name: 'innerWidth', expression: 'width - 2 * wall', variable: null, references: 0, referenceLines: [],
      editable: true, value: 'width - 2 * wall', portable: false, usages: [{ filePath: '/ws/plug.part.js', count: 1, lines: [8] }],
      deletion: {
        value: 'width - 2 * wall', replaced: [], dropped: [],
        blocked: [{ filePath: '/ws/plug.part.js', count: 1, lines: [8] }],
      },
    });
    const { dialog, root } = mount();
    dialog.openForEdit(def);
    await flush();
    ref<HTMLButtonElement>(root, 'delete').click();
    expect(ref(root, 'confirm-row').classList.contains('hidden')).toBe(true);
    expect(ref(root, 'message').textContent).toBe(
      '“innerWidth” cannot be deleted yet. Its value (width - 2 * wall) reads names that are out of scope in plug.part.js (line 8). '
      + 'Rewrite those reads by hand, then delete the property.',
    );
    expect(api.removeProperty).not.toHaveBeenCalled();
  });

  it('confirms a delete with what the reads become', async () => {
    vi.mocked(api.getPropertyUsage).mockResolvedValue({
      name: 'innerWidth', expression: '52', variable: 'inner', references: 1, referenceLines: [12],
      editable: true, value: '52', portable: true,
      usages: [{ filePath: FILE, count: 1, lines: [12] }, { filePath: '/ws/frame.assembly.js', count: 2, lines: [5, 6] }],
      deletion: {
        value: '52', dropped: [], blocked: [],
        replaced: [{ filePath: FILE, count: 1, lines: [12] }, { filePath: '/ws/frame.assembly.js', count: 2, lines: [5, 6] }],
      },
    });
    const { dialog, root } = mount();
    dialog.openForEdit(def);
    await flush();
    ref<HTMLButtonElement>(root, 'delete').click();
    expect(ref(root, 'confirm-text').textContent).toBe(
      'Delete “innerWidth”? Its 3 reads in model.fluid.js (line 12) and frame.assembly.js (lines 5, 6) become its value 52.',
    );
  });
});
