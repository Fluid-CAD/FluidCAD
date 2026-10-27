// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetAppearanceDialog } from '../src/ui/set-appearance-dialog';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';
import { APPEARANCES } from '../../lib/common/appearances';

// The Set appearance dialog: a part row's pick over the built-in appearance
// table (no server list — there is no custom table), a swatch per row, the
// current appearance checked, None to take the chain off, and Apply
// dispatching the acked set-part-appearance edit.

const FILE = '/ws/shelf.part.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });

function part(id: string, line: number, appearance?: string): SceneObjectRender {
  return {
    id, name: `part-${id}`, type: 'part', isContainer: true, object: { name: `Shelf ${id}`, appearance },
    sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

function mount(opts: { editor?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = { setPartAppearance: vi.fn(async () => ({ success: true })) };
  const client = { editor: opts.editor === false ? null : editor } as unknown as EngineClient;
  const dialog = new SetAppearanceDialog(container, client);
  const overlay = container.querySelector<HTMLElement>('[role="dialog"]')!;
  const rows = () => Array.from(overlay.querySelectorAll<HTMLButtonElement>('[role="option"]'));
  const labels = () => rows().map((r) => r.querySelector('span:nth-child(3)')!.textContent);
  const row = (id: string | null) => rows().find((r) => r.dataset.appearanceId === (id ?? ''))!;
  const apply = () => overlay.querySelector<HTMLButtonElement>('[data-ref="apply"]')!;
  return { container, dialog, editor, overlay, rows, labels, row, apply };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SetAppearanceDialog', () => {
  it('lists None then every built-in appearance, the current one checked, with a swatch each', () => {
    const h = mount();
    h.dialog.open(part('A', 1, 'oak'));
    expect(h.dialog.isOpen).toBe(true);
    expect(h.overlay.querySelector('[data-ref="subtitle"]')!.textContent).toBe('Shelf A');
    expect(h.labels()).toEqual(['None', ...APPEARANCES.map((a) => a.name)]);
    expect(h.row('oak').querySelector('svg')).not.toBeNull();
    expect(h.row(null).querySelector('svg')).toBeNull();
    expect(h.row('steel').querySelector('svg')).toBeNull();
    // A wood's swatch shows grain stripes over its colour; a plain one a sheen over its colour.
    expect(h.row('oak').querySelector<HTMLElement>('[data-swatch="oak"]')!.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(h.row('oak').querySelector<HTMLElement>('[data-swatch="oak"]')!.style.backgroundColor).not.toBe('');
    expect(h.row('steel').querySelector<HTMLElement>('[data-swatch="steel"]')!.style.backgroundImage).toContain('radial-gradient');
    expect(h.row('steel').querySelector<HTMLElement>('[data-swatch="steel"]')!.style.backgroundColor).not.toBe('');
    expect(h.apply().disabled).toBe(true);
  });

  it('applies a pick through the acked edit and closes', () => {
    const h = mount();
    h.dialog.open(part('A', 4));
    h.row('brass').click();
    expect(h.row('brass').getAttribute('aria-selected')).toBe('true');
    expect(h.apply().disabled).toBe(false);
    h.apply().click();
    expect(h.editor.setPartAppearance).toHaveBeenCalledWith(loc(4), 'brass');
    expect(h.dialog.isOpen).toBe(false);
  });

  it('None removes the chain; a double-click applies at once', () => {
    const h = mount();
    h.dialog.open(part('A', 4, 'oak'));
    h.row(null).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(h.editor.setPartAppearance).toHaveBeenCalledWith(loc(4), null);
  });

  it('shows an id the table lacks as a checked, unpickable row and still lets another be picked', () => {
    const h = mount();
    h.dialog.open(part('A', 4, 'chrome'));
    const unknown = h.row('chrome');
    expect(unknown.disabled).toBe(true);
    expect(unknown.textContent).toContain('Unknown appearance: chrome');
    expect(unknown.querySelector('svg')).not.toBeNull();
    h.row('copper').click();
    h.apply().click();
    expect(h.editor.setPartAppearance).toHaveBeenCalledWith(loc(4), 'copper');
  });

  it('writes nothing when the pick is the current one, or without an editor', () => {
    const h = mount();
    h.dialog.open(part('A', 4, 'oak'));
    h.row('oak').click();
    h.apply().click();
    expect(h.editor.setPartAppearance).not.toHaveBeenCalled();
    expect(h.dialog.isOpen).toBe(true);

    const noEditor = mount({ editor: false });
    noEditor.dialog.open(part('B', 9));
    noEditor.row('oak').click();
    expect(() => noEditor.apply().click()).not.toThrow();
    expect(noEditor.dialog.isOpen).toBe(false);
  });

  it('closes on Escape and on the Cancel button', () => {
    const h = mount();
    h.dialog.open(part('A', 4));
    h.overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.dialog.isOpen).toBe(false);
    h.dialog.open(part('A', 4));
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="cancel"]')!.click();
    expect(h.dialog.isOpen).toBe(false);
  });
});
