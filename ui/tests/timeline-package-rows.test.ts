// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// Rows an installed package made (`row.package`, stamped by the engine):
// a package mark, and none of the affordances that would edit the
// package's file — no dots menu, no rename/edit/remove/breakpoint, no
// activation of a package part, no drag into one, no source jump. The
// double-click says why instead. The model's own rows are untouched.

Element.prototype.scrollIntoView = vi.fn();

const MODEL = '/ws/riser.part.js';
const PACKAGE_FILE = '/lib/@acme/kit/0.1.0/pcb-plate.part.js';
const KIT = { name: '@acme/kit', version: '0.1.0' };

function row(id: string, extra: Partial<SceneObjectRender>): SceneObjectRender {
  return { id, name: id, visible: true, sceneShapes: [], ownShapes: [], ...extra } as unknown as SceneObjectRender;
}

const SCENE: SceneObjectRender[] = [
  row('riser', { type: 'part', isContainer: true, sourceLocation: { filePath: MODEL, line: 3, column: 1 } }),
  row('block', { type: 'extrude', parentId: 'riser', sourceLocation: { filePath: MODEL, line: 5, column: 3 } }),
  row('plate', { type: 'part', isContainer: true, sourceLocation: { filePath: PACKAGE_FILE, line: 4, column: 1 }, package: KIT }),
  row('plate-extrude', { type: 'extrude', parentId: 'plate', sourceLocation: { filePath: PACKAGE_FILE, line: 6, column: 3 }, package: KIT }),
  row('top', { type: 'extrude', sourceLocation: { filePath: MODEL, line: 20, column: 1 } }),
];

afterEach(() => {
  document.body.innerHTML = '';
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = {
    addBreakpoint: vi.fn(),
    gotoSource: vi.fn(),
    renameFeature: vi.fn(),
    removeFeature: vi.fn(),
  };
  const client = { savePreference: vi.fn(), rollback: vi.fn(), editor } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container, client,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined,
  );
  const setActivePart = vi.fn(() => true);
  timeline.setActivePart = setActivePart;
  timeline.isFeatureEditable = () => true;
  timeline.onFeatureEdit = vi.fn();
  timeline.onMoveToPart = vi.fn();
  const onReadOnlyRow = vi.fn();
  timeline.onReadOnlyRow = onReadOnlyRow;
  timeline.update(SCENE, SCENE.length - 1);
  const rowEl = (id: string) => container.querySelector<HTMLElement>(`[data-index="${SCENE.findIndex((o) => o.id === id)}"]`)!;
  const menuFor = (id: string) => {
    rowEl(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    return container.querySelector<HTMLElement>('.menu, [data-ref="package-row-note"]');
  };
  return { container, timeline, editor, client, rowEl, menuFor, setActivePart, onReadOnlyRow };
}

describe('timeline — rows from an installed package', () => {
  it('marks package rows with the package and leaves the model\'s own rows plain', () => {
    const h = mount();
    const badge = h.rowEl('plate-extrude').querySelector<HTMLElement>('[data-package-badge]')!;
    expect(badge.dataset.packageBadge).toBe('@acme/kit');
    expect(badge.title).toBe("From @acme/kit 0.1.0. Installed packages are read-only, so this row can't be edited, renamed or removed.");
    expect(h.rowEl('plate').querySelector('[data-package-badge]')).not.toBeNull();
    expect(h.rowEl('block').querySelector('[data-package-badge]')).toBeNull();
    expect(h.rowEl('top').querySelector('[data-package-badge]')).toBeNull();
  });

  it('gives a package part no dots menu, no activation and no drop, while a model part keeps them', () => {
    const h = mount();
    expect(h.rowEl('riser').querySelector('[data-row-menu]')).not.toBeNull();
    expect(h.rowEl('plate').querySelector('[data-row-menu]')).toBeNull();
    expect(h.rowEl('riser').dataset.dropPart).toBe('true');
    expect(h.rowEl('plate').dataset.dropPart).toBeUndefined();
    expect(h.rowEl('top').dataset.movable).toBe('true');

    h.rowEl('plate').click();
    expect(h.setActivePart).not.toHaveBeenCalled();
    h.rowEl('riser').click();
    expect(h.setActivePart).toHaveBeenCalledTimes(1);
  });

  it('never follows a package row into its file', () => {
    const h = mount();
    h.rowEl('plate-extrude').click();
    expect(h.editor.gotoSource).not.toHaveBeenCalled();
    h.rowEl('top').click();
    expect(h.editor.gotoSource).toHaveBeenCalledTimes(1);
  });

  it('answers a double-click with the read-only notice instead of a breakpoint or a dialog', () => {
    const h = mount();
    h.rowEl('plate-extrude').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(h.onReadOnlyRow).toHaveBeenCalledWith(expect.objectContaining({ id: 'plate-extrude' }));
    expect(h.editor.addBreakpoint).not.toHaveBeenCalled();
    expect(h.timeline.onFeatureEdit).not.toHaveBeenCalled();
  });

  it('shows only the package note in a package row\'s menu, and the full menu on the model\'s rows', () => {
    const h = mount();
    const note = h.menuFor('plate-extrude')!;
    expect(note.dataset.ref).toBe('package-row-note');
    expect(note.textContent).toContain('From @acme/kit 0.1.0.');
    for (const action of ['rename', 'edit', 'rollback', 'remove', 'set-material']) {
      expect(h.container.querySelector(`[data-action="${action}"]`)).toBeNull();
    }
    document.body.click();
    h.menuFor('block');
    expect(h.container.querySelector('[data-action="rename"]')).not.toBeNull();
    expect(h.container.querySelector('[data-action="remove"]')).not.toBeNull();
  });

  it('answers whether a row is a package\'s', () => {
    expect(TimelinePanel.isPackageRow(SCENE[3])).toBe(true);
    expect(TimelinePanel.isPackageRow(SCENE[1])).toBe(false);
    expect(TimelinePanel.isPackageRow(undefined)).toBe(false);
  });
});
