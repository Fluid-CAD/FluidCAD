// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// The panel scrolls on its own for one reason only: a feature was added, and
// then to that feature's row. Rebuilds, rollbacks, breakpoints placed or
// lifted and edit dialogs opening or closing leave the scroll position alone.

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

describe('timeline scroll policy', () => {
  it('does not scroll on the first load', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 30), 29);
    expect(revealed).toEqual([]);
  });

  it('does not follow the current row on a rebuild of the same features', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 30), 2);
    h.timeline.update(scene('b', 30), 29);
    expect(revealed).toEqual([]);
  });

  it('reveals a feature added at the tip', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 12), 11);
    h.timeline.update(scene('b', 13), 12);
    expect(revealed).toEqual([12]);
  });

  it('does not scroll on a rollback preview of rows that share a call site', () => {
    const revealed = stubLayout();
    const h = mount();
    // A repeat and its clones all report the repeat's own line.
    const doc = (b: string) => [
      ...scene(b, 10),
      { ...feature(10, `${b}-rep`), type: 'repeat', name: 'Repeat 1', isContainer: true },
      ...Array.from({ length: 4 }, (_, i) => ({ ...feature(10, `${b}-c${i}`), name: `clone ${i}`, parentId: `${b}-rep` })),
    ] as SceneObjectRender[];
    h.timeline.update(doc('a'), 14);
    h.timeline.update(doc('b'), 3, null);
    h.timeline.update(doc('c'), 14);
    expect(revealed).toEqual([]);
  });

  it('does not scroll on a rollback preview', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 30), 29);
    h.timeline.update(scene('a', 30), 3, null);
    expect(revealed).toEqual([]);
  });

  it('does not scroll when a breakpoint pauses the build (history retained)', () => {
    const revealed = stubLayout();
    const h = mount();
    const full = scene('a', 30);
    h.timeline.update(full, 29);
    const live = scene('b', 10);
    const timeline = [
      ...live.map((_, index) => ({ kind: 'evaluated', index })),
      ...full.slice(10).map((row) => ({ kind: 'unevaluated', row })),
    ] as never;
    h.timeline.update(live, 9, null, { paused: true, breakpointStop: 9, timeline });
    expect(revealed).toEqual([]);
  });

  it('does not scroll when the render leaves a breakpoint, even away from the paused row', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 13), 12, null, { paused: true });
    h.timeline.update(scene('b', 30), 29);
    expect(revealed).toEqual([]);
  });

  it('reveals a feature added while paused', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 12), 11, null, { paused: true });
    h.timeline.update(scene('b', 13), 12, null, { paused: true });
    expect(revealed).toEqual([12]);
  });

  it('does not scroll when the whole document is replaced', () => {
    const revealed = stubLayout();
    const h = mount();
    h.timeline.update(scene('a', 12), 11);
    const other = scene('b', 30).map((o, i) => ({ ...o, type: 'fillet', name: `fillet ${i}`,
      sourceLocation: { filePath: 'b.fluid.js', line: 100 + i, column: 1 } }) as SceneObjectRender);
    h.timeline.update(other, 29);
    expect(revealed).toEqual([]);
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

    it('reveals a feature added inside the active part, not the tip of the list', () => {
      const revealed = stubLayout();
      const h = mount();
      const doc = (b: string, extra: boolean) => [
        part(`${b}-p1`, 1), ...Array.from({ length: 6 }, (_, i) => child(`${b}-e${i}`, `${b}-p1`, 2 + i)),
        ...(extra ? [child(`${b}-new`, `${b}-p1`, 8)] : []),
        part(`${b}-p2`, 20), child(`${b}-x`, `${b}-p2`, 21),
      ];
      h.timeline.update(doc('a', false), 8);
      h.timeline.update(doc('b', true), 9);
      // Row 7 is the added feature (inside p1); the tip, row 9, stays where it is.
      expect(revealed).toEqual([7]);
    });

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

});
