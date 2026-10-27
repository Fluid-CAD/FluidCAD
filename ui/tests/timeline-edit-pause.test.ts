// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { SceneObjectRender } from '../src/types';
import type { EngineClient } from '../src/engine-client';

// The edit gesture's pause: a double-click on an editable row asks the host
// for the acknowledged pause after the row and hands its promise to the
// dialog; while an open edit dialog holds the build on its stop, the pause
// lifts that stop in the same edit. A host without the acknowledged pause
// falls back to the fire-and-forget breakpoint.

function mount(opts: { acked?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const pause = Promise.resolve({ changed: true, renderVersion: 3 });
  const editor: Record<string, unknown> = { gotoSource: vi.fn(), addBreakpoint: vi.fn(), removeFeature: vi.fn() };
  if (opts.acked !== false) {
    editor.pauseAfter = vi.fn(() => pause);
  }
  const client = { editor, rollback: vi.fn(), savePreference: vi.fn() };
  const panel = new TimelinePanel(container, client as unknown as EngineClient,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined);
  panel.onFeatureEdit = vi.fn();
  panel.isFeatureEditable = () => true;
  panel.setActivePart = vi.fn();
  return { panel, container, client, editor, pause };
}

function feature(id: string, type = 'extrude'): SceneObjectRender {
  return { id, type, uniqueType: type, name: id, parentId: null, isContainer: false,
    sourceLocation: { filePath: '/a.part.js', line: id.charCodeAt(0), column: 1 },
    sceneShapes: [], ownShapes: [], visible: true } as SceneObjectRender;
}

function doubleClick(container: HTMLElement, index: number): void {
  container.querySelector<HTMLElement>(`[data-index="${index}"]`)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('timeline edit gesture pause', () => {
  it('asks for the acknowledged pause and hands its promise to the dialog', () => {
    const h = mount();
    const rows = [feature('a'), feature('b')];
    h.panel.update(rows, 1, null, {});
    doubleClick(h.container, 1);
    expect(h.editor.pauseAfter).toHaveBeenCalledExactlyOnceWith(rows[1].sourceLocation, undefined);
    expect(h.editor.addBreakpoint).not.toHaveBeenCalled();
    expect(h.panel.onFeatureEdit).toHaveBeenCalledExactlyOnceWith(rows[1], 1, h.pause);
  });

  it('lifts the open dialog\'s stop in the same edit when told one is open', () => {
    const h = mount();
    const rows = [feature('a'), feature('b')];
    h.panel.pauseLiftsActive = vi.fn(() => true);
    h.panel.update(rows, 1, null, {});
    doubleClick(h.container, 0);
    expect(h.panel.pauseLiftsActive).toHaveBeenCalledWith(rows[0]);
    expect(h.editor.pauseAfter).toHaveBeenCalledExactlyOnceWith(rows[0].sourceLocation, { liftActive: true });
  });

  it('skips the pause for rows whose dialog places its own', () => {
    const h = mount();
    const rows = [feature('a', 'offset')];
    h.panel.managesOwnBreakpoint = () => true;
    h.panel.update(rows, 0, null, {});
    doubleClick(h.container, 0);
    expect(h.editor.pauseAfter).not.toHaveBeenCalled();
    expect(h.panel.onFeatureEdit).toHaveBeenCalledExactlyOnceWith(rows[0], 0, undefined);
  });

  it('falls back to the fire-and-forget breakpoint on a host without the acknowledged pause', () => {
    const h = mount({ acked: false });
    const rows = [feature('a')];
    h.panel.update(rows, 0, null, {});
    doubleClick(h.container, 0);
    expect(h.editor.addBreakpoint).toHaveBeenCalledExactlyOnceWith(rows[0].sourceLocation);
    expect(h.panel.onFeatureEdit).toHaveBeenCalledExactlyOnceWith(rows[0], 0, undefined);
  });
});
