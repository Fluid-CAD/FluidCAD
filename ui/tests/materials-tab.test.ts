// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../src/ui/settings/settings-modal';
import { MaterialsTab } from '../src/ui/settings/materials-tab';
import { applyGlobalMaterialsPreferences, globalMaterials } from '../src/ui/settings/global-materials';
import type { Material, UserPreferences } from '../src/api';

// Settings → Materials: the user's own materials, edited as a draft like
// every tab. Add / edit / remove mark the tab dirty; the dialog's Save puts
// the map in the store and persists it under `materials`; Cancel drops it.

const BUILTINS: Material[] = [
  { id: 'fluidcad-steel-1020', name: 'Steel (AISI 1020)', density: 7.87, densityUnit: 'g/cm³', source: 'builtin' },
];

afterEach(() => {
  document.body.innerHTML = '';
  globalMaterials.update({});
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount() {
  const savePreference = vi.fn();
  const modal = new SettingsModal(document.body, {
    savePreference,
    resetPreferences: vi.fn(async (): Promise<UserPreferences | null> => null),
    applyPreferences: vi.fn(),
    loadMaterials: vi.fn(async () => BUILTINS),
  });
  const overlay = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  const panel = overlay.querySelector<HTMLElement>('[data-panel="materials"]')!;
  const ref = <T extends HTMLElement>(name: string) => panel.querySelector<T>(`[data-ref="${name}"]`)!;
  const type = (name: string, value: string) => {
    const input = ref<HTMLInputElement>(name);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const rowsIds = () => Array.from(panel.querySelectorAll<HTMLElement>('[data-material-id]')).map((r) => r.dataset.materialId);
  const dot = () => !overlay.querySelector('[data-tab="materials"] [data-dirty]')!.classList.contains('hidden');
  const save = () => overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!;
  const add = (name: string, density: string, unit = 'g/cm³') => {
    type('name', name);
    type('density', density);
    ref<HTMLSelectElement>('unit').value = unit;
    ref<HTMLButtonElement>('commit').click();
  };
  return { modal, overlay, panel, ref, type, rowsIds, dot, save, add, savePreference };
}

describe('MaterialsTab', () => {
  it('sits between Units and Advanced and starts from the store, empty', () => {
    const h = mount();
    h.modal.show('materials');
    expect(h.panel.classList.contains('hidden')).toBe(false);
    expect(h.ref('empty')).not.toBeNull();
    expect(h.dot()).toBe(false);
  });

  it('slugs the id from the name until the id is typed, and hints an override of a built-in', async () => {
    const h = mount();
    h.modal.show('materials');
    await flush();
    h.type('name', 'Alloy Steel (AISI 4140)');
    expect(h.ref<HTMLInputElement>('id').value).toBe('alloy-steel-aisi-4140');
    h.type('id', 'fluidcad-steel-1020');
    expect(h.ref('id-hint').textContent).toContain('Overrides the built-in Steel (AISI 1020)');
    h.type('name', 'Other');
    expect(h.ref<HTMLInputElement>('id').value).toBe('fluidcad-steel-1020');
  });

  it('add marks the tab dirty; Save stores the map and persists it under materials; g/cm³ stays implicit', () => {
    const h = mount();
    h.modal.show('materials');
    h.add('Alloy Steel', '7.7');
    h.add('ACME PLA+', '1270', 'kg/m³');
    expect(h.rowsIds()).toEqual(['alloy-steel', 'acme-pla']);
    expect(h.dot()).toBe(true);
    expect(globalMaterials.current).toEqual({});
    expect(h.save().disabled).toBe(false);
    h.save().click();
    const expected = { 'alloy-steel': { name: 'Alloy Steel', density: 7.7 }, 'acme-pla': { name: 'ACME PLA+', density: 1270, densityUnit: 'kg/m³' } };
    expect(globalMaterials.current).toEqual(expected);
    expect(h.savePreference).toHaveBeenCalledWith('materials', expected);
    expect(h.dot()).toBe(false);
  });

  it('rejects a blank name, a non-positive density, a blank id and a duplicate id without touching the draft', () => {
    const h = mount();
    h.modal.show('materials');
    h.add('', '1');
    expect(h.ref('form-message').textContent).toBe('Name is required.');
    h.add('X', '0');
    expect(h.ref('form-message').textContent).toBe('Density must be a positive number.');
    h.type('name', 'X');
    h.type('density', '1');
    h.type('id', '');
    h.ref<HTMLButtonElement>('commit').click();
    expect(h.ref('form-message').textContent).toBe('Id is required.');
    h.add('Pine', '0.5');
    h.add('Pine', '0.6');
    expect(h.ref('form-message').textContent).toContain('already used');
    expect(h.rowsIds()).toEqual(['pine']);
  });

  it('edits in place (a renamed id keeps its position), removes, and Cancel drops the draft', () => {
    globalMaterials.update({ pine: { name: 'Pine', density: 0.5 }, oak: { name: 'Oak', density: 0.7 } });
    const h = mount();
    h.modal.show('materials');
    expect(h.rowsIds()).toEqual(['pine', 'oak']);
    expect(h.dot()).toBe(false);
    h.panel.querySelector<HTMLButtonElement>('[data-material-id="pine"] [data-action="edit"]')!.click();
    expect(h.ref('form-title').textContent).toBe('Edit material');
    h.type('name', 'Scots Pine');
    h.type('id', 'scots-pine');
    h.ref<HTMLButtonElement>('commit').click();
    expect(h.rowsIds()).toEqual(['scots-pine', 'oak']);
    h.panel.querySelector<HTMLButtonElement>('[data-material-id="oak"] [data-action="remove"]')!.click();
    expect(h.rowsIds()).toEqual(['scots-pine']);
    expect(h.dot()).toBe(true);
    h.modal.hide();
    h.modal.show('materials');
    expect(h.rowsIds()).toEqual(['pine', 'oak']);
    expect(h.dot()).toBe(false);
  });

  it('applyGlobalMaterialsPreferences fills the store from the preferences, empty without the key', () => {
    applyGlobalMaterialsPreferences({ materials: { pine: { name: 'Pine', density: 0.5 } } } as unknown as UserPreferences);
    expect(globalMaterials.current).toEqual({ pine: { name: 'Pine', density: 0.5 } });
    applyGlobalMaterialsPreferences({} as UserPreferences);
    expect(globalMaterials.current).toEqual({});
  });

  it('slugOf strips accents and punctuation', () => {
    expect(MaterialsTab.slugOf('Acier Élastique 2.0!')).toBe('acier-elastique-2-0');
  });
});
