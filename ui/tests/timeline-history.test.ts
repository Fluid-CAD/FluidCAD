// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { SceneObjectRender } from '../src/types';
import type { EngineClient } from '../src/engine-client';
import type { TimelineEntry, TimelineRow } from '../../lib/common/timeline.js';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = { gotoSource: vi.fn(), addBreakpoint: vi.fn(), removeFeature: vi.fn() };
  const client = { editor, rollback: vi.fn(), savePreference: vi.fn() };
  const panel = new TimelinePanel(container, client as unknown as EngineClient,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined);
  panel.onFeatureEdit = vi.fn();
  panel.onFeatureIntercept = vi.fn();
  panel.onFeatureShow = vi.fn();
  panel.onToggleRowShown = vi.fn();
  panel.onMoveToPart = vi.fn();
  panel.setActivePart = vi.fn();
  return { panel, container, client, editor };
}

function feature(id: string, type = 'extrude', parentId: string | null = null): SceneObjectRender {
  return { id, type, uniqueType: type, name: id, parentId, isContainer: type === 'part' || type === 'sketch',
    sourceLocation: { filePath: '/a.part.js', line: id.charCodeAt(0), column: 1 },
    sceneShapes: [], ownShapes: [], visible: true } as SceneObjectRender;
}

function historical(id: string, type = 'fillet', parentId: string | null = null): TimelineEntry {
  const { sceneShapes, ownShapes, visible, ...row } = feature(id, type, parentId);
  return { kind: 'unevaluated', row: row as TimelineRow };
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('paused timeline history display', () => {
  it('restores historical rows on a fresh panel, without a prior UI render', () => {
    const h = mount();
    const live = [feature('a')];
    h.panel.update(live, 0, null, { paused: true, timeline: [{ kind: 'evaluated', index: 0 }, historical('b')] });
    expect(h.container.querySelector('[data-history-index="1"]')?.textContent).toContain('b');
    expect(h.container.querySelectorAll('[data-index]')).toHaveLength(1);
    expect(live).toHaveLength(1);
  });

  it('keeps actual runtime rollback targets when history is interleaved', () => {
    const h = mount();
    const live = [feature('a'), feature('c')];
    h.panel.update(live, 1, null, { paused: true, timeline: [
      { kind: 'evaluated', index: 0 }, historical('b'), { kind: 'evaluated', index: 1 },
    ] });
    h.container.querySelector<HTMLElement>('[data-index="1"]')!.click();
    expect(h.client.rollback).toHaveBeenCalledWith(1, 'part');
    expect(h.container.querySelector('[data-index="1"]')?.textContent).toContain('c');
    expect(h.container.querySelector('[data-history-index]')?.getAttribute('data-current')).toBe('false');
  });

  it('restricts historical rows to source navigation, including modifiers and double-click', () => {
    const h = mount();
    const entry = historical('b', 'part');
    h.panel.update([], -1, null, { paused: true, timeline: [entry] });
    const el = h.container.querySelector<HTMLElement>('[data-history-index]')!;
    for (const event of [new MouseEvent('click', { bubbles: true, ctrlKey: true }),
      new MouseEvent('dblclick', { bubbles: true }), new MouseEvent('contextmenu', { bubbles: true }),
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })]) el.dispatchEvent(event);
    expect(h.editor.gotoSource).toHaveBeenCalledWith((entry as { row: TimelineRow }).row.sourceLocation, { revealEditor: false });
    expect(h.client.rollback).not.toHaveBeenCalled();
    expect(h.editor.addBreakpoint).not.toHaveBeenCalled();
    expect(h.panel.onFeatureEdit).not.toHaveBeenCalled();
    expect(h.panel.onFeatureIntercept).not.toHaveBeenCalled();
    expect(h.panel.setActivePart).not.toHaveBeenCalled();
    expect(el.querySelector('[data-row-menu], [data-show-eye]')).toBeNull();
    expect(el.hasAttribute('draggable')).toBe(false);
    expect(el.hasAttribute('data-drop-part')).toBe(false);
    expect(el.title).toContain('last complete evaluation');
  });

  it('keeps historical children expandable without activating their part', () => {
    const h = mount();
    h.panel.update([], -1, null, { paused: true, timeline: [historical('p', 'part'), historical('b', 'extrude', 'p')] });
    expect(h.container.querySelectorAll('[data-history-index]')).toHaveLength(2);
    h.container.querySelector<HTMLElement>('[data-toggle="p"]')!.click();
    expect(h.container.querySelectorAll('[data-history-index]')).toHaveLength(1);
    expect(h.editor.gotoSource).not.toHaveBeenCalled();
    expect(h.panel.setActivePart).not.toHaveBeenCalled();
    h.container.querySelector<HTMLElement>('[data-toggle="p"]')!.click();
    expect(h.container.querySelectorAll('[data-history-index]')).toHaveLength(2);
  });

  it('preserves a collapsed historical part when Continue brings it back', () => {
    const h = mount();
    h.panel.update([], -1, null, { paused: true, timeline: [historical('p', 'part'), historical('b', 'extrude', 'p')] });
    h.container.querySelector<HTMLElement>('[data-toggle="p"]')!.click();
    const p = feature('p', 'part');
    h.panel.update([{ ...p, id: 'new-p' }, { ...feature('b', 'extrude', 'new-p'), id: 'new-b' }], 1);
    expect(h.container.querySelector('[data-history-index]')).toBeNull();
    expect(h.container.querySelectorAll('[data-index]')).toHaveLength(1);
  });

  it('does not extend a live sketch rollback or turn history into an active sketch', () => {
    const h = mount();
    const live = [feature('s', 'sketch'), feature('l', 'line', 's')];
    live[0].closed = true;
    h.panel.update(live, 1, null, { paused: true, timeline: [
      { kind: 'evaluated', index: 0 }, { kind: 'evaluated', index: 1 }, historical('c', 'circle', 's'), historical('z', 'sketch'),
    ] });
    h.container.querySelector<HTMLElement>('[data-index="0"]')!.click();
    expect(h.client.rollback).toHaveBeenCalledWith(1, 'part');
  });

  it('escapes historical computed names instead of interpreting them as markup', () => {
    const h = mount();
    const entry = historical('b');
    if (entry.kind === 'unevaluated') entry.row.name = '<img src=x onerror=alert(1)>';
    h.panel.update([], -1, null, { paused: true, timeline: [entry] });
    const el = h.container.querySelector('[data-history-index]')!;
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img[src="x"]')).toBeNull();
  });
});
