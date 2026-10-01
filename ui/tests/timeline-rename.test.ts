// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// Rename on the timeline: a feature row edits its chained `.name('…')`, a
// part row is renamed in its `part('…', …)` statement — the acked edit that
// takes the part's variable, and the files importing it, along.

Element.prototype.scrollIntoView = vi.fn();

const FILE = '/ws/bracket.part.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });

const SCENE = [
  {
    id: 'A', name: 'Part 1', hasCustomName: true, type: 'part', isContainer: true, object: {},
    sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(1),
  },
  {
    id: 'a1', name: 'extrude', type: 'extrude', parentId: 'A', visible: true,
    sceneShapes: [], ownShapes: [], sourceLocation: loc(2),
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
  /** Open the row's menu, pick Rename, type `name` and press Enter. */
  const rename = (id: string, name: string) => {
    const row = container.querySelector<HTMLElement>(`[data-index="${SCENE.findIndex((o) => o.id === id)}"]`)!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    container.querySelector<HTMLButtonElement>('[data-action="rename"]')!.click();
    const input = container.querySelector<HTMLInputElement>('[data-ref="rename-input"]')!;
    input.value = name;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return input;
  };
  return { container, editor, rename };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('timeline — Rename', () => {
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
  });

  it('leaves a part alone when the name did not change', () => {
    const h = mount();
    h.rename('A', 'Part 1');
    expect(h.editor.renamePart).not.toHaveBeenCalled();
    expect(h.editor.renameFeature).not.toHaveBeenCalled();
  });

  it('clears a part\'s name through the chain edit, which never empties the argument', () => {
    const h = mount();
    h.rename('A', '');
    expect(h.editor.renameFeature).toHaveBeenCalledWith(loc(1), null);
    expect(h.editor.renamePart).not.toHaveBeenCalled();
  });
});
