// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// Leaving a breakpoint moves the current row to the tip of the timeline. The
// panel keeps resting on the row it was paused on instead of following it.

const ROW_HEIGHT = 20;
const VIEW_HEIGHT = 100;

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = { savePreference: vi.fn() } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container, client,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined,
  );
  return { timeline, container };
}

function feature(index: number, id: string): SceneObjectRender {
  return {
    id, name: 'extrude', type: 'extrude', sceneShapes: [], ownShapes: [], visible: true,
    sourceLocation: { filePath: 'a.fluid.js', line: 10 + index, column: 1 },
  } as unknown as SceneObjectRender;
}

/** Fresh ids on every build, the same source lines — what a re-render delivers. */
function scene(build: string, count: number): SceneObjectRender[] {
  return Array.from({ length: count }, (_, i) => feature(i, `${build}-${i}`));
}

/**
 * jsdom has no layout: rows report a rect from their index, everything else
 * (the scrolling body) the fixed viewport. scrollTo records the row revealed.
 */
function stubLayout() {
  const revealed: number[] = [];
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const index = (this as HTMLElement).dataset?.index;
    const top = index === undefined ? 0 : parseInt(index, 10) * ROW_HEIGHT;
    const height = index === undefined ? VIEW_HEIGHT : ROW_HEIGHT;
    return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  Element.prototype.scrollTo = vi.fn(function (this: Element, opts: ScrollToOptions) {
    revealed.push(Math.round(((opts.top ?? 0) + VIEW_HEIGHT) / ROW_HEIGHT) - 1);
  }) as unknown as typeof Element.prototype.scrollTo;
  return revealed;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('timeline hold view', () => {
  it('follows the current row to the tip on an ordinary render', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 30), 2);
    h.timeline.update(scene('b', 30), 29);
    expect(revealed).toEqual([29]);
  });

  it('stays on the paused row when the render leaves a breakpoint', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 3), 2, null, { paused: true });
    h.timeline.update(scene('b', 30), 29);
    expect(revealed).toEqual([]);
  });

  it('brings the paused row back when the user had scrolled away from it', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 13), 12, null, { paused: true });
    revealed.length = 0;
    h.timeline.update(scene('b', 30), 29);
    expect(revealed).toEqual([12]);
  });

  describe('multi-part documents', () => {
    const part = (id: string, line: number): SceneObjectRender => ({
      id, name: `part-${line}`, type: 'part', isContainer: true,
      sceneShapes: [], ownShapes: [], visible: true,
      sourceLocation: { filePath: 'a.fluid.js', line, column: 1 },
    } as unknown as SceneObjectRender);
    const child = (id: string, parentId: string, line: number): SceneObjectRender => ({
      id, name: 'extrude', type: 'extrude', sceneShapes: [], ownShapes: [], visible: true, parentId,
      sourceLocation: { filePath: 'a.fluid.js', line, column: 1 },
    } as unknown as SceneObjectRender);
    /** Two parts with one feature each; the pause lands inside the first. */
    const full = (b: string) => [part(`${b}-p1`, 1), child(`${b}-e1`, `${b}-p1`, 2), part(`${b}-p2`, 10), child(`${b}-e2`, `${b}-p2`, 11)];
    const cutOff = (b: string) => full(b).slice(0, 2);

    it('keeps every part open when the parts the pause cut off return', () => {
      stubLayout();
      const h = mount();
      h.timeline.update(full('a'), 3);
      h.timeline.update(cutOff('b'), 1, null, { paused: true });
      h.timeline.update(full('c'), 3);
      expect(h.container.querySelectorAll('[data-index]').length).toBe(4);
    });

    it('restores a part that was collapsed before the pause', () => {
      stubLayout();
      const h = mount();
      h.timeline.update(full('a'), 3);
      h.container.querySelector<HTMLElement>('[data-toggle="a-p2"]')!.click();
      expect(h.container.querySelector('[data-index="3"]')).toBeNull();
      h.timeline.update(cutOff('b'), 1, null, { paused: true });
      h.timeline.update(full('c'), 3);
      expect(h.container.querySelector('[data-index="1"]')).not.toBeNull();
      expect(h.container.querySelector('[data-index="3"]')).toBeNull();
    });

    it('still focuses a part that is new after the pause', () => {
      stubLayout();
      const h = mount();
      h.timeline.update(full('a'), 3);
      h.timeline.update(cutOff('b'), 1, null, { paused: true });
      h.timeline.update([...full('c'), part('c-p3', 20), child('c-e3', 'c-p3', 21)], 5);
      expect(h.container.querySelector('[data-index="1"]')).toBeNull();
      expect(h.container.querySelector('[data-index="5"]')).not.toBeNull();
    });
  });

  it('falls back to the current row when the paused row is gone', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 3), 2, null, { paused: true });
    const next = scene('b', 30).map((o) => ({ ...o, type: 'fillet', name: 'fillet' }) as SceneObjectRender);
    h.timeline.update(next, 29);
    expect(revealed).toEqual([29]);
  });
});
