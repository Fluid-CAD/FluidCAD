// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../src/ui/settings/settings-modal';
import { viewerSettings } from '../src/scene/viewer-settings';
import { editorPrefs } from '../src/editor/editor-prefs';
import { newProjectDefaults } from '../src/ui/settings/new-project-defaults';
import type { UserPreferences } from '../src/api';

// The Settings dialog: a gear-opened modal with one vertical tab per area.
// Tabs edit drafts; Save applies them to the live stores AND persists the
// changed keys, Cancel drops them, and a tab with an unsaved edit shows a
// dot. Reset re-applies the server's defaults through the page's own routine.

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  viewerSettings.update({ snapRadiusPx: 15, pickRadiusPx: 12 });
  editorPrefs.update({ fontFamily: '', fontSize: 13, wordWrap: false, openAtStartup: false });
  newProjectDefaults.update({ unit: 'mm' });
});

function mount() {
  const savePreference = vi.fn();
  const resetPreferences = vi.fn(async (): Promise<UserPreferences | null> => ({
    theme: 'fluidcad-dark', showGrid: true, cameraMode: 'orthographic', showBuildTimings: false,
    editorFontFamily: '', editorFontSize: 13, editorWordWrap: false, snapRadiusPx: 15, pickRadiusPx: 12, defaultProjectUnit: 'mm', editorOpen: false,
  }));
  const applyPreferences = vi.fn((prefs: UserPreferences) => {
    viewerSettings.update({ snapRadiusPx: prefs.snapRadiusPx!, pickRadiusPx: prefs.pickRadiusPx! });
    editorPrefs.update({ fontSize: prefs.editorFontSize!, fontFamily: prefs.editorFontFamily!, wordWrap: false, openAtStartup: false });
    newProjectDefaults.update({ unit: prefs.defaultProjectUnit! });
    document.documentElement.setAttribute('data-theme', prefs.theme);
  });
  const modal = new SettingsModal(document.body, { savePreference, resetPreferences, applyPreferences });
  const overlay = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  return { modal, overlay, savePreference, resetPreferences, applyPreferences };
}

function tabButton(overlay: HTMLElement, id: string): HTMLButtonElement {
  return overlay.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)!;
}

function dotVisible(overlay: HTMLElement, id: string): boolean {
  return !tabButton(overlay, id).querySelector('[data-dirty]')!.classList.contains('hidden');
}

function panel(overlay: HTMLElement, id: string): HTMLElement {
  return overlay.querySelector<HTMLElement>(`[data-panel="${id}"]`)!;
}

function saveButton(overlay: HTMLElement): HTMLButtonElement {
  return overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!;
}

function typeNumber(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('change'));
}

describe('SettingsModal', () => {
  it('lists the five tabs, opens on Appearance, switches on click, and has a fixed-height box', () => {
    const { modal, overlay } = mount();
    expect(Array.from(overlay.querySelectorAll('[data-tab]')).map((b) => b.textContent)).toEqual([
      'Appearance', 'Editor', 'Sketch', 'Units', 'Advanced',
    ]);
    expect(overlay.querySelector('[data-ref="box"]')!.className).toMatch(/\bh-\[480px\]/);
    expect(modal.isOpen()).toBe(false);
    modal.show();
    expect(modal.isOpen()).toBe(true);
    expect(panel(overlay, 'appearance').classList.contains('hidden')).toBe(false);
    tabButton(overlay, 'sketch').click();
    expect(panel(overlay, 'sketch').classList.contains('hidden')).toBe(false);
    expect(tabButton(overlay, 'sketch').getAttribute('aria-selected')).toBe('true');
    expect(saveButton(overlay).disabled).toBe(true);
  });

  it('closes on Escape, the close button and a click on the backdrop', () => {
    const { modal, overlay } = mount();
    modal.show();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.isOpen()).toBe(false);
    modal.show();
    overlay.querySelector<HTMLButtonElement>('[data-ref="close"]')!.click();
    expect(modal.isOpen()).toBe(false);
    modal.show();
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(modal.isOpen()).toBe(false);
  });

  it('an edit marks its tab with a dot and enables Save; nothing is applied until Save', () => {
    const { modal, overlay, savePreference } = mount();
    modal.show('sketch');
    const snap = panel(overlay, 'sketch').querySelector<HTMLInputElement>('input[type="number"]')!;
    typeNumber(snap, '25');
    expect(dotVisible(overlay, 'sketch')).toBe(true);
    expect(dotVisible(overlay, 'editor')).toBe(false);
    expect(saveButton(overlay).disabled).toBe(false);
    expect(viewerSettings.current.snapRadiusPx).toBe(15);
    expect(savePreference).not.toHaveBeenCalled();

    tabButton(overlay, 'appearance').click();
    overlay.querySelector<HTMLButtonElement>('[data-theme="fluidcad-light"]')!.click();
    expect(dotVisible(overlay, 'appearance')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();

    saveButton(overlay).click();
    expect(viewerSettings.current.snapRadiusPx).toBe(25);
    expect(savePreference).toHaveBeenCalledWith('snapRadiusPx', 25);
    expect(savePreference).not.toHaveBeenCalledWith('pickRadiusPx', expect.anything());
    expect(document.documentElement.getAttribute('data-theme')).toBe('fluidcad-light');
    expect(savePreference).toHaveBeenCalledWith('theme', 'fluidcad-light');
    expect(dotVisible(overlay, 'sketch')).toBe(false);
    expect(dotVisible(overlay, 'appearance')).toBe(false);
    expect(saveButton(overlay).disabled).toBe(true);
  });

  it('Cancel drops the drafts and re-reads the stores', () => {
    const { modal, overlay, savePreference } = mount();
    modal.show('sketch');
    const snap = panel(overlay, 'sketch').querySelector<HTMLInputElement>('input[type="number"]')!;
    typeNumber(snap, '500');
    expect(snap.value).toBe('80');
    expect(modal.hasUnsavedChanges()).toBe(true);
    overlay.querySelector<HTMLButtonElement>('[data-ref="cancel"]')!.click();
    expect(modal.isOpen()).toBe(false);
    expect(modal.hasUnsavedChanges()).toBe(false);
    expect(viewerSettings.current.snapRadiusPx).toBe(15);
    expect(savePreference).not.toHaveBeenCalled();
    modal.show('sketch');
    expect(snap.value).toBe('15');
    expect(dotVisible(overlay, 'sketch')).toBe(false);
  });

  it('Editor offers "Editor default" plus installed fonts, keeps an unknown stored font visible, and saves size, wrap and startup', () => {
    editorPrefs.update({ fontFamily: 'Somewhere Else Mono' });
    const { modal, overlay, savePreference } = mount();
    modal.show('editor');
    const editor = panel(overlay, 'editor');
    const select = editor.querySelector<HTMLSelectElement>('select')!;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[0]).toBe('Editor default');
    expect(labels).toContain('Somewhere Else Mono (not installed here)');
    expect(select.value).toBe('Somewhere Else Mono');

    select.value = '';
    select.dispatchEvent(new Event('change'));
    typeNumber(editor.querySelector<HTMLInputElement>('input[type="number"]')!, '16');
    const [wrap, startup] = Array.from(editor.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(wrap.checked).toBe(false);
    expect(startup.checked).toBe(false);
    wrap.checked = true;
    wrap.dispatchEvent(new Event('change'));
    startup.checked = true;
    startup.dispatchEvent(new Event('change'));
    expect(editorPrefs.current.fontSize).toBe(13);

    saveButton(overlay).click();
    expect(editorPrefs.current).toEqual({ fontFamily: '', fontSize: 16, wordWrap: true, openAtStartup: true });
    expect(savePreference).toHaveBeenCalledWith('editorFontFamily', '');
    expect(savePreference).toHaveBeenCalledWith('editorFontSize', 16);
    expect(savePreference).toHaveBeenCalledWith('editorWordWrap', true);
    expect(savePreference).toHaveBeenCalledWith('editorOpen', true);
  });

  it('Units lists every unit and saves the pick for new projects', () => {
    const { modal, overlay, savePreference } = mount();
    modal.show('units');
    const select = panel(overlay, 'units').querySelector<HTMLSelectElement>('select')!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['mm', 'cm', 'm', 'in', 'ft']);
    select.value = 'in';
    select.dispatchEvent(new Event('change'));
    expect(newProjectDefaults.current.unit).toBe('mm');
    saveButton(overlay).click();
    expect(newProjectDefaults.current.unit).toBe('in');
    expect(savePreference).toHaveBeenCalledWith('defaultProjectUnit', 'in');
  });

  it('Advanced asks first, then resets on the server at once, re-applies the defaults and drops every draft', async () => {
    const { modal, overlay, resetPreferences, applyPreferences } = mount();
    modal.show('sketch');
    typeNumber(panel(overlay, 'sketch').querySelector<HTMLInputElement>('input[type="number"]')!, '40');
    expect(dotVisible(overlay, 'sketch')).toBe(true);

    tabButton(overlay, 'advanced').click();
    const advanced = panel(overlay, 'advanced');
    const buttons = () => Array.from(advanced.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.closest('.hidden'));
    expect(buttons().map((b) => b.textContent)).toEqual(['Reset all to defaults']);
    buttons()[0].click();
    expect(resetPreferences).not.toHaveBeenCalled();
    buttons().find((b) => b.textContent === 'Reset')!.click();
    await vi.waitFor(() => expect(applyPreferences).toHaveBeenCalledTimes(1));
    expect(resetPreferences).toHaveBeenCalledTimes(1);
    expect(viewerSettings.current.snapRadiusPx).toBe(15);
    expect(panel(overlay, 'sketch').querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('15');
    expect(dotVisible(overlay, 'sketch')).toBe(false);
    expect(advanced.textContent).toContain('Every setting is back to its default.');
  });
});
