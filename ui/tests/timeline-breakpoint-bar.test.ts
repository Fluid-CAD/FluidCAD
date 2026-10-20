// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineBreakpointBar } from '../src/ui/timeline-breakpoint-bar';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { SceneObjectRender } from '../src/types';
import type { EngineClient } from '../src/engine-client';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); document.body.innerHTML = ''; });

function pointer(target: EventTarget, type: string, y: number, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id });
  target.dispatchEvent(event);
}

function mountBar(current = 3, paused = false) {
  const body = document.createElement('div');
  document.body.append(body);
  const rows = Array.from({ length: 3 }, () => body.appendChild(document.createElement('div')));
  const apply = vi.fn().mockResolvedValue({ success: true });
  const bar = new TimelineBreakpointBar(body, apply);
  cleanup.push(() => bar.dispose());
  for (const el of [...rows, bar.element]) {
    Object.defineProperty(el, 'offsetTop', { get: () => Array.from(body.children).indexOf(el) * 30 });
    Object.defineProperty(el, 'offsetHeight', { value: 30 });
  }
  body.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 } as DOMRect);
  const stops = [...rows.map((el, i) => ({ before: el, label: `Before feature ${i}`, source: { line: i + 1, column: 1 } })),
    { before: null, label: 'End of history', source: null }];
  bar.update({ stops, current, paused, disabled: false, revision: 1 });
  const handle = body.querySelector<HTMLElement>('[role="slider"]')!;
  return { body, rows, bar, handle, apply, stops };
}

describe('timeline breakpoint bar interaction', () => {
  it('previews a drag without writing, then applies exactly once on release', async () => {
    const h = mountBar();
    expect(h.body.querySelector<HTMLElement>('.timeline-breakpoint-label')!.hidden).toBe(true);
    pointer(h.handle, 'pointerdown', 95);
    pointer(window, 'pointermove', 30);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.handle.getAttribute('aria-valuetext')).toBe('Before feature 1');
    // Words only while the stop is on the move.
    expect(h.body.querySelector<HTMLElement>('.timeline-breakpoint-label')!.textContent).toBe('Before feature 1');
    pointer(window, 'pointerup', 30);
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(h.stops[1]);
    await Promise.resolve();
    expect(h.handle.getAttribute('aria-disabled')).toBe('true');
    h.bar.prepareRender();
    h.bar.update({ stops: h.stops, current: 1, paused: true, disabled: false, revision: 2 });
    expect(h.handle.getAttribute('aria-disabled')).toBe('false');
    expect(document.activeElement).toBe(h.handle);
  });

  it.each(['escape', 'pointercancel', 'blur', 'rebuild', 'dispose'])('cancels cleanly on %s', mode => {
    const h = mountBar();
    pointer(h.handle, 'pointerdown', 95);
    pointer(window, 'pointermove', 0);
    if (mode === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    if (mode === 'pointercancel') pointer(window, 'pointercancel', 0);
    if (mode === 'blur') window.dispatchEvent(new Event('blur'));
    if (mode === 'rebuild') h.bar.prepareRender();
    if (mode === 'dispose') h.bar.dispose();
    pointer(window, 'pointerup', 0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.bar.element.style.transform).toBe('');
  });

  it('ignores clicks without movement and other pointers', () => {
    const h = mountBar();
    pointer(h.handle, 'pointerdown', 95);
    pointer(window, 'pointermove', 0, 2);
    pointer(window, 'pointerup', 95);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('supports keyboard stepping and Home/End without firing scene shortcuts', () => {
    const h = mountBar();
    const sceneKey = vi.fn();
    window.addEventListener('keydown', sceneKey);
    cleanup.push(() => window.removeEventListener('keydown', sceneKey));
    h.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.handle.getAttribute('aria-valuenow')).toBe('2');
    h.handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }));
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(h.stops[2]);
    expect(sceneKey).not.toHaveBeenCalled();
  });

  it('exposes errors and restores the original position for retry', async () => {
    const h = mountBar();
    h.apply.mockResolvedValue({ success: false, reason: 'The file changed.' });
    h.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    h.handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home' }));
    await Promise.resolve();
    expect(h.handle.getAttribute('aria-valuenow')).toBe('3');
    expect(h.handle.getAttribute('aria-disabled')).toBe('false');
    expect(h.body.querySelector('[role="status"]')?.textContent).toBe('The file changed.');
  });

  it('continues from a cold pause even when the stop is already visually at the end', () => {
    const h = mountBar(3, true);
    h.body.querySelector<HTMLButtonElement>('[aria-label="Continue to end"]')!.click();
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(h.stops[3]);
  });

  it('also resumes a cold pause with the End key', () => {
    const h = mountBar(3, true);
    h.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    h.handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'End' }));
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(h.stops[3]);
  });

  it('keeps stale source targets locked if rebuilding takes longer than the wait notice', async () => {
    vi.useFakeTimers();
    try {
      const h = mountBar();
      h.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
      h.handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home' }));
      await Promise.resolve();
      vi.advanceTimersByTime(15000);
      expect(h.handle.getAttribute('aria-disabled')).toBe('true');
      expect(h.body.querySelector('[role="status"]')?.textContent).toContain('Still waiting');
      h.bar.prepareRender();
      h.bar.update({ stops: h.stops, current: 0, paused: true, disabled: false, revision: 2 });
      expect(h.handle.getAttribute('aria-disabled')).toBe('false');
      expect(h.body.querySelector('[role="status"]')?.textContent).toBe('');
    } finally { vi.useRealTimers(); }
  });
});

function row(id: string, line: number, type = 'extrude', parentId?: string): SceneObjectRender {
  return { id, name: id, type, parentId, isContainer: type === 'part' || type === 'sketch', closed: true,
    sourceLocation: { filePath: '/model.part.js', line, column: 1 }, sceneShapes: [], ownShapes: [], visible: true } as SceneObjectRender;
}

function mountPanel(editable = true) {
  const container = document.body.appendChild(document.createElement('div'));
  const editor = { moveTimelineBreakpoint: vi.fn().mockResolvedValue({ success: true }), addBreakpoint: vi.fn(), gotoSource: vi.fn() };
  const client = { editor: editable ? editor : null, savePreference: vi.fn(), rollback: vi.fn() };
  const panel = new TimelinePanel(container, client as unknown as EngineClient,
    () => {}, () => {}, () => {}, () => false, () => {}, () => 1, () => {});
  cleanup.push(() => panel.dispose());
  return { container, panel, client, editor };
}

describe('timeline breakpoint targets', () => {
  it('keeps the source breakpoint fixed while a click previews an earlier feature', () => {
    const h = mountPanel();
    const live = [row('base', 3), row('fillet', 5)];
    h.panel.update(live, 0, null, { paused: true, breakpointStop: 1, timeline: [
      { kind: 'evaluated', index: 0 }, { kind: 'evaluated', index: 1 },
      { kind: 'unevaluated', row: row('shell', 8) },
    ] });
    expect(h.container.querySelector('[data-current="true"]')?.textContent).toContain('base');
    expect(h.container.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('Before shell');
  });

  it('moves into retained history without opening an editor or rolling back stale geometry', () => {
    const h = mountPanel();
    const live = [row('part', 1, 'part'), row('base', 3, 'extrude', 'part'), row('other', 10)];
    h.panel.update(live, 1, 'part', { paused: true, timeline: [
      { kind: 'evaluated', index: 0 }, { kind: 'evaluated', index: 1 },
      { kind: 'unevaluated', row: row('fillet', 5, 'fillet', 'part') },
      { kind: 'unevaluated', row: row('shell', 7, 'shell', 'part') }, { kind: 'evaluated', index: 2 },
    ] });
    const handle = h.container.querySelector<HTMLElement>('[role="slider"]')!;
    expect(handle.getAttribute('aria-valuetext')).toBe('Before fillet');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));
    expect(h.editor.moveTimelineBreakpoint).toHaveBeenCalledExactlyOnceWith('/model.part.js', { line: 7, column: 1 }, 'passed');
    expect(h.editor.addBreakpoint).not.toHaveBeenCalled();
    expect(h.client.rollback).not.toHaveBeenCalled();
  });

  it('skips collapsed descendants and preserves the bar when collapsing a paused part', () => {
    const h = mountPanel();
    h.panel.update([row('part', 1, 'part'), row('base', 3, 'extrude', 'part'), row('other', 10)], 1, 'part', { paused: true });
    h.container.querySelector<HTMLElement>('[data-toggle="part"]')!.click();
    const handle = h.container.querySelector('[role="slider"]')!;
    expect(handle.getAttribute('aria-valuemax')).toBe('2');
    expect(handle.getAttribute('aria-valuetext')).toBe('Before other');
  });

  it('marks every pending breakpoint besides the paused one, at the gap before the statement after it', () => {
    const h = mountPanel();
    const live = [row('base', 3), row('fillet', 5)];
    h.panel.update(live, 1, null, { paused: true, breakpointStop: 1, timeline: [
      { kind: 'evaluated', index: 0 }, { kind: 'evaluated', index: 1 },
      { kind: 'unevaluated', row: row('shell', 8) }, { kind: 'unevaluated', row: row('chamfer', 11) },
    ], breakpoints: [{ line: 6, column: 1 }, { line: 9, column: 1 }, { line: 12, column: 1 }] });
    // Line 6 is the paused stop (the bar sits before shell); 9 and 12 are pending.
    const markers = [...h.container.querySelectorAll<HTMLElement>('[data-pending-breakpoint]')];
    expect(markers.map(m => m.dataset.pendingBreakpoint)).toEqual(['9', '12']);
    expect(markers[0].nextElementSibling?.textContent).toContain('chamfer');
    expect(markers[1].nextElementSibling).toBeNull();
    expect(h.container.querySelector('.timeline-breakpoint')?.nextElementSibling?.textContent).toContain('shell');
    // The markers and the bar add no height of their own: no resting label.
    expect(h.container.querySelector<HTMLElement>('.timeline-breakpoint-label')?.hidden).toBe(true);
  });

  it('keeps the last breakpoint list across a render that carries none', () => {
    const h = mountPanel();
    h.panel.update([row('base', 3), row('fillet', 5)], 1, null, { breakpoints: [{ line: 4, column: 1 }] });
    expect(h.container.querySelectorAll('[data-pending-breakpoint]')).toHaveLength(1);
    h.panel.update([row('base', 3), row('fillet', 5)], 1, null, {});
    expect(h.container.querySelectorAll('[data-pending-breakpoint]')).toHaveLength(1);
    h.panel.update([row('base', 3), row('fillet', 5)], 1, null, { breakpoints: [] });
    expect(h.container.querySelectorAll('[data-pending-breakpoint]')).toHaveLength(0);
  });

  it('moves with passed-stop removal and continues to the end with a full clear', async () => {
    const h = mountPanel();
    h.panel.update([row('base', 3), row('fillet', 5)], 0, null, { paused: true, breakpointStop: 0 });
    const handle = h.container.querySelector<HTMLElement>('[role="slider"]')!;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));
    expect(h.editor.moveTimelineBreakpoint).toHaveBeenLastCalledWith('/model.part.js', null, 'all');
    // The panel's apply wraps the client call in its own async step: let the ack settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.panel.update([row('base', 3), row('fillet', 5)], 1, null, { paused: true, breakpointStop: 1 });
    const again = h.container.querySelector<HTMLElement>('[role="slider"]')!;
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    again.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' }));
    expect(h.editor.moveTimelineBreakpoint).toHaveBeenLastCalledWith('/model.part.js', { line: 5, column: 1 }, 'passed');
  });

  it('hides the bar in a read-only viewer and an empty document', () => {
    const h = mountPanel(false);
    h.panel.update([row('base', 3)], 0);
    expect(h.container.querySelector('[role="slider"]')).toBeNull();
    const empty = mountPanel();
    empty.panel.update([], -1);
    expect(empty.container.querySelector('[role="slider"]')).toBeNull();
  });

  it('locks navigation during a running sketch but allows moving out of a paused sketch', () => {
    const h = mountPanel();
    const sketch = { ...row('sketch', 1, 'sketch'), closed: false };
    h.panel.update([sketch], 0);
    expect(h.container.querySelector('[role="slider"]')?.getAttribute('aria-disabled')).toBe('true');
    h.panel.update([sketch], 0, null, { paused: true });
    expect(h.container.querySelector('[role="slider"]')?.getAttribute('aria-disabled')).toBe('false');
  });
});
