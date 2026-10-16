// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// Rename on the timeline: a feature row edits its chained `.name('…')`, a
// part row is renamed in its `part('…', …)` statement — the acked edit that
// takes the part's variable, and the files importing it, along. The input
// starts on the row's current name (the lib's `<Type> <n>` default for an
// unnamed row); an empty or unchanged value sends nothing, and a name another
// row in the file holds is refused inline before any request.

Element.prototype.scrollIntoView = vi.fn();

const FILE = '/ws/bracket.part.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });

const SCENE = [
  {
    id: 'A', name: 'Part 1', hasCustomName: true, type: 'part', isContainer: true, object: {},
    sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(1),
  },
  {
    id: 'a1', name: 'Extrude 1', type: 'extrude', parentId: 'A', visible: true,
    sceneShapes: [], ownShapes: [], sourceLocation: loc(2),
  },
  {
    id: 'a2', name: 'Lug', hasCustomName: true, type: 'extrude', parentId: 'A', visible: true,
    sceneShapes: [], ownShapes: [], sourceLocation: loc(3),
  },
  {
    id: 'a3', name: 'Extrude 3', type: 'extrude', parentId: 'A', visible: true,
    sceneShapes: [], ownShapes: [], sourceLocation: loc(4),
  },
] as unknown as SceneObjectRender[];

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = {
    addBreakpoint: vi.fn(),
    gotoSource: vi.fn(),
    renameFeature: vi.fn(),
    renamePart: vi.fn(async () => ({ success: true })),
  };
  const client = { savePreference: vi.fn(), rollback: vi.fn(), editor } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container, client,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined,
  );
  timeline.setActivePart = vi.fn(() => false);
  timeline.update(SCENE, SCENE.length - 1);
  /** Open the row's menu and pick Rename; returns the input as it opened. */
  const open = (id: string) => {
    const row = container.querySelector<HTMLElement>(`[data-index="${SCENE.findIndex((o) => o.id === id)}"]`)!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    container.querySelector<HTMLButtonElement>('[data-action="rename"]')!.click();
    return container.querySelector<HTMLInputElement>('[data-ref="rename-input"]')!;
  };
  /** Open the row's menu, pick Rename, type `name` and press Enter. */
  const rename = (id: string, name: string) => {
    const input = open(id);
    input.value = name;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return input;
  };
  const input = () => container.querySelector<HTMLInputElement>('[data-ref="rename-input"]');
  const error = () => container.querySelector<HTMLElement>('[data-ref="rename-error"]');
  return { container, editor, open, rename, input, error };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('timeline — Rename', () => {
  it('opens on the row\'s current name, default label included', () => {
    const h = mount();
    const input = h.open('a1');
    expect(input.value).toBe('Extrude 1');
    expect(input.placeholder).toBe('Extrude 1');
  });

  it('renames a part through the part rename edit', () => {
    const h = mount();
    h.rename('A', 'Fixed leaf');
    expect(h.editor.renamePart).toHaveBeenCalledWith(loc(1), 'Fixed leaf');
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
  });

  it('renames any other feature through its .name() chain', () => {
    const h = mount();
    h.rename('a1', 'Boss');
    expect(h.editor.renameFeature).toHaveBeenCalledWith(loc(2), 'Boss');
    expect(h.editor.renamePart).not.toHaveBeenCalled();
    expect(h.input()).toBeNull();
  });

  it('leaves a part alone when the name did not change', () => {
    const h = mount();
    h.rename('A', 'Part 1');
    expect(h.editor.renamePart).not.toHaveBeenCalled();
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
  });

  it('sends nothing when the default label is submitted unchanged', () => {
    const h = mount();
    h.rename('a1', 'Extrude 1');
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
    expect(h.input()).toBeNull();
  });

  it('sends nothing on an empty name — the name stays', () => {
    const h = mount();
    h.rename('a1', '   ');
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
    expect(h.editor.renamePart).not.toHaveBeenCalled();
    expect(h.input()).toBeNull();

    h.rename('A', '');
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
    expect(h.editor.renamePart).not.toHaveBeenCalled();
  });

  it('refuses a name another feature in the file holds, inline, without a request', () => {
    const h = mount();
    const input = h.rename('a1', 'Lug');
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
    expect(h.input()).toBe(input);
    expect(input.classList.contains('input-error')).toBe(true);
    expect(h.error()!.classList.contains('hidden')).toBe(false);
    expect(h.error()!.textContent).toBe("'Lug' is already used by Lug");

    // Typing again clears the mark; a free name then goes through.
    input.value = 'Lug 2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('input-error')).toBe(false);
    expect(h.error()!.classList.contains('hidden')).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.editor.renameFeature).toHaveBeenCalledWith(loc(2), 'Lug 2');
  });

  it('refuses the name of a part in the file too', () => {
    const h = mount();
    h.rename('a1', 'Part 1');
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
    expect(h.error()!.textContent).toBe("'Part 1' is already used by Part 1");
  });

  it('does not count another row\'s default label as taken', () => {
    const h = mount();
    h.rename('a1', 'Extrude 3');
    expect(h.editor.renameFeature).toHaveBeenCalledWith(loc(2), 'Extrude 3');
  });
});
