// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManageMaterialsDialog } from '../src/ui/manage-materials-dialog';
import type { EngineClient } from '../src/engine-client';
import type { Material, ProjectMaterials } from '../src/api';

// The Manage materials… dialog (part-materials stage 3): lists the
// project's own entries out of the merged list, adds one with the id
// slugged from the name, edits and removes, refuses a duplicate project id
// while allowing a built-in's id as an override, and Save posts the whole
// map once, handing the answered list to the opener.

const MATERIALS: Material[] = [
  { id: 'fluidcad-steel', name: 'Steel', density: 7.87, densityUnit: 'g/cm³', source: 'builtin' },
  { id: 'fluidcad-pla', name: 'PLA', density: 1.24, densityUnit: 'g/cm³', source: 'builtin' },
  { id: 'alloy-steel', name: 'Alloy Steel', density: 7.7, densityUnit: 'g/cm³', source: 'project' },
  { id: 'acme-pla', name: 'ACME PLA+', density: 1270, densityUnit: 'kg/m³', source: 'project' },
];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount(opts: { editor?: boolean; saved?: Material[] | null; reason?: string } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const saveProjectMaterials = vi.fn(async (_materials: ProjectMaterials) =>
    opts.reason
      ? { success: false as const, reason: opts.reason }
      : { success: true as const, materials: opts.saved ?? MATERIALS });
  const client = {
    getMaterials: vi.fn(async () => MATERIALS),
    editor: opts.editor === false ? null : { saveProjectMaterials },
  } as unknown as EngineClient;
  const dialog = new ManageMaterialsDialog(container, client);
  const saved: Material[][] = [];
  dialog.onSaved = (materials) => saved.push(materials);

  const ref = <T extends HTMLElement>(name: string) => container.querySelector<T>(`[data-ref="${name}"]`)!;
  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-material-id]'));
  const rowIds = () => rows().map((r) => r.dataset.materialId);
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const fill = (name: string, density: string, unit?: string, id?: string) => {
    type(ref<HTMLInputElement>('name'), name);
    ref<HTMLInputElement>('density').value = density;
    if (unit) {
      ref<HTMLSelectElement>('unit').value = unit;
    }
    if (id !== undefined) {
      type(ref<HTMLInputElement>('id'), id);
    }
  };
  const open = async () => {
    dialog.open();
    await flush();
  };
  return {
    container, dialog, client, saveProjectMaterials, saved, ref, rows, rowIds, type, fill, open,
    commit: () => ref<HTMLButtonElement>('commit').click(),
    save: async () => { ref<HTMLButtonElement>('save').click(); await flush(); },
    formMessage: () => ref('form-message').textContent,
    status: () => ref('status').textContent,
    isOpen: () => dialog.isOpen,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ManageMaterialsDialog — listing', () => {
  it('lists the project entries only, with id, density and unit, and marks an override', async () => {
    const h = mount();
    await h.open();
    expect(h.rowIds()).toEqual(['alloy-steel', 'acme-pla']);
    expect(h.rows()[1].textContent).toContain('ACME PLA+');
    expect(h.rows()[1].textContent).toContain('acme-pla · 1270 kg/m³');
    expect(h.container.textContent).not.toContain('fluidcad-steel');
    expect(h.ref<HTMLButtonElement>('save').disabled).toBe(true);
  });

  it('says so when the project has none', async () => {
    const h = mount();
    vi.mocked(h.client.getMaterials).mockResolvedValueOnce(MATERIALS.filter((m) => m.source === 'builtin'));
    await h.open();
    expect(h.rows()).toEqual([]);
    expect(h.ref('empty').textContent).toBe('No project materials yet.');
  });
});

describe('ManageMaterialsDialog — add', () => {
  it('slugs the id from the name until the id is edited', async () => {
    const h = mount();
    await h.open();
    h.type(h.ref<HTMLInputElement>('name'), 'Alloy Steel (AISI 4140)');
    expect(h.ref<HTMLInputElement>('id').value).toBe('alloy-steel-aisi-4140');
    h.type(h.ref<HTMLInputElement>('id'), 'aisi4140');
    h.type(h.ref<HTMLInputElement>('name'), 'AISI 4140 Steel');
    expect(h.ref<HTMLInputElement>('id').value).toBe('aisi4140');
  });

  it('adds the entry to the list and Save posts the whole map, handing back the answered list', async () => {
    const answered = [...MATERIALS, { id: 'pine', name: 'Pine', density: 0.5, densityUnit: 'g/cm³', source: 'project' as const }];
    const h = mount({ saved: answered });
    await h.open();
    h.fill('Pine', '0.5');
    h.commit();
    expect(h.rowIds()).toEqual(['alloy-steel', 'acme-pla', 'pine']);
    expect(h.formMessage()).toBe('');
    // The form is blank again for the next entry.
    expect(h.ref<HTMLInputElement>('name').value).toBe('');
    expect(h.ref<HTMLButtonElement>('save').disabled).toBe(false);

    await h.save();
    expect(h.saveProjectMaterials).toHaveBeenCalledTimes(1);
    expect(h.saveProjectMaterials).toHaveBeenCalledWith({
      'alloy-steel': { name: 'Alloy Steel', density: 7.7 },
      'acme-pla': { name: 'ACME PLA+', density: 1270, densityUnit: 'kg/m³' },
      pine: { name: 'Pine', density: 0.5 },
    });
    expect(h.saved).toEqual([answered]);
    expect(h.isOpen()).toBe(false);
  });

  it('keeps a non-default unit on the entry', async () => {
    const h = mount();
    await h.open();
    h.fill('Lead', '0.41', 'lbs/in³');
    h.commit();
    await h.save();
    expect(h.saveProjectMaterials.mock.calls[0][0].lead).toEqual({ name: 'Lead', density: 0.41, densityUnit: 'lbs/in³' });
  });

  it('refuses a blank name, a non-positive density and a blank id', async () => {
    const h = mount();
    await h.open();
    h.fill('', '1');
    h.commit();
    expect(h.formMessage()).toBe('Name is required.');
    h.fill('Foam', '0');
    h.commit();
    expect(h.formMessage()).toBe('Density must be a positive number.');
    h.fill('Foam', '0.1', undefined, '');
    h.commit();
    expect(h.formMessage()).toBe('Id is required.');
    expect(h.rowIds()).toEqual(['alloy-steel', 'acme-pla']);
    expect(h.ref<HTMLButtonElement>('save').disabled).toBe(true);
  });

  it('blocks an id another project entry already uses', async () => {
    const h = mount();
    await h.open();
    h.fill('Alloy Steel 2', '7.8', undefined, 'alloy-steel');
    h.commit();
    expect(h.formMessage()).toBe('Id "alloy-steel" is already used by "Alloy Steel" in this project.');
    expect(h.rowIds()).toEqual(['alloy-steel', 'acme-pla']);
  });

  it('allows a built-in id as an override and says so', async () => {
    const h = mount();
    await h.open();
    h.fill('House PLA', '1.3', undefined, 'fluidcad-pla');
    expect(h.ref('id-hint').textContent).toBe('Overrides the built-in PLA for this project.');
    h.commit();
    expect(h.rowIds()).toEqual(['alloy-steel', 'acme-pla', 'fluidcad-pla']);
    expect(h.rows()[2].textContent).toContain('overrides built-in PLA');
  });
});

describe('ManageMaterialsDialog — edit and remove', () => {
  it('loads an entry into the form and updates it in place, a renamed id keeping its position', async () => {
    const h = mount();
    await h.open();
    h.rows()[0].querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
    expect(h.ref('form-title').textContent).toBe('Edit material');
    expect(h.ref<HTMLInputElement>('name').value).toBe('Alloy Steel');
    expect(h.ref<HTMLInputElement>('id').value).toBe('alloy-steel');
    // Editing the name does not rewrite an existing id.
    h.type(h.ref<HTMLInputElement>('name'), 'Alloy Steel 4140');
    expect(h.ref<HTMLInputElement>('id').value).toBe('alloy-steel');
    h.type(h.ref<HTMLInputElement>('id'), 'alloy-4140');
    h.ref<HTMLInputElement>('density').value = '7.85';
    h.commit();
    expect(h.rowIds()).toEqual(['alloy-4140', 'acme-pla']);
    await h.save();
    expect(h.saveProjectMaterials).toHaveBeenCalledWith({
      'alloy-4140': { name: 'Alloy Steel 4140', density: 7.85 },
      'acme-pla': { name: 'ACME PLA+', density: 1270, densityUnit: 'kg/m³' },
    });
  });

  it('removes an entry and Save posts the map without it', async () => {
    const h = mount();
    await h.open();
    h.rows()[1].querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
    expect(h.rowIds()).toEqual(['alloy-steel']);
    await h.save();
    expect(h.saveProjectMaterials).toHaveBeenCalledWith({ 'alloy-steel': { name: 'Alloy Steel', density: 7.7 } });
  });

  it('shows the server\'s reason and stays open when the save fails', async () => {
    const h = mount({ reason: 'The "materials" map has an entry "x" without a "name" string.' });
    await h.open();
    h.fill('Pine', '0.5');
    h.commit();
    await h.save();
    expect(h.status()).toContain('without a "name"');
    expect(h.isOpen()).toBe(true);
    expect(h.saved).toEqual([]);
  });

  it('cannot save in a read-only host', async () => {
    const h = mount({ editor: false });
    await h.open();
    h.fill('Pine', '0.5');
    h.commit();
    await h.save();
    expect(h.status()).toContain('cannot write');
    expect(h.isOpen()).toBe(true);
  });
});
