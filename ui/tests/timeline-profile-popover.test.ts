// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// The build-time breakdown popover opens on row hover and must never outlive
// the hover. Its row's own mouseleave covers the plain hover-off; these cover
// the ways the row and the pointer part company without that event firing.

Element.prototype.scrollIntoView = vi.fn();

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = { savePreference: vi.fn() } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container,
    client,
    () => undefined,
    () => undefined,
    () => undefined,
    () => false,
    () => undefined,
    () => 1,
    () => undefined,
  );
  timeline.setShowBuildTimings(true);
  const rowEl = (index: number) => container.querySelector<HTMLElement>(`[data-index="${index}"]`)!;
  const popover = () => Array.from(container.querySelectorAll('div'))
    .find((el) => el.textContent?.includes('Build Time Breakdown')) ?? null;
  return { container, timeline, rowEl, popover };
}

function scene(): SceneObjectRender[] {
  return [0, 1].map((index) => ({
    id: `id-${index}`,
    name: 'extrude',
    type: 'extrude',
    sceneShapes: [],
    ownShapes: [],
    visible: true,
    buildDurationMs: 12,
    profileCategories: [{ category: 'boolean', durationMs: 10 }],
  } as unknown as SceneObjectRender));
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
}

describe('timeline profile popover lifetime', () => {
  it('opens on row hover and closes on row mouseleave', () => {
    const h = mount();
    h.timeline.update(scene(), 1);
    hover(h.rowEl(0));
    expect(h.popover()).not.toBeNull();
    h.rowEl(0).dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(h.popover()).toBeNull();
  });

  it('closes when the timeline re-renders under the hovered row', () => {
    const h = mount();
    h.timeline.update(scene(), 1);
    hover(h.rowEl(0));
    expect(h.popover()).not.toBeNull();
    // A scene-rendered update rebuilds the rows: the hovered element is
    // gone, so its mouseleave can never fire.
    h.timeline.update(scene(), 1);
    expect(h.popover()).toBeNull();
    expect(h.container.querySelectorAll('[data-index="0"]')).toHaveLength(1);
  });

  it('closes when the list scrolls under a still pointer', () => {
    const h = mount();
    h.timeline.update(scene(), 1);
    hover(h.rowEl(1));
    expect(h.popover()).not.toBeNull();
    h.rowEl(1).parentElement!.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(h.popover()).toBeNull();
  });

  it('closes when the pointer leaves the panel', () => {
    const h = mount();
    h.timeline.update(scene(), 1);
    hover(h.rowEl(0));
    expect(h.popover()).not.toBeNull();
    h.container.firstElementChild!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(h.popover()).toBeNull();
  });

  it('closes when the panel is hidden', () => {
    const h = mount();
    h.timeline.update(scene(), 1);
    hover(h.rowEl(0));
    expect(h.popover()).not.toBeNull();
    h.timeline.togglePanel();
    expect(h.popover()).toBeNull();
  });

  it('re-hovering swaps the popover rather than stacking', () => {
    const h = mount();
    h.timeline.update(scene(), 1);
    hover(h.rowEl(0));
    hover(h.rowEl(1));
    const all = Array.from(h.container.querySelectorAll('div'))
      .filter((el) => el.firstElementChild?.textContent === 'Build Time Breakdown');
    expect(all).toHaveLength(1);
  });
});
