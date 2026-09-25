// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import { viewerSettings } from '../src/scene/viewer-settings';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// The Settings dialog's Timeline tab decides which rows the History panel
// lists under a sketch: every child or only the editable features, the
// "N constraints" group, and the "N regions" group. The store is live: a
// change re-renders the open timeline.

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  document.body.innerHTML = '';
  viewerSettings.update({ timelineSketchChildren: 'all', timelineShowConstraints: true, timelineShowRegions: false });
});

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
  return {
    timeline,
    container,
    rowOf: (index: number) => container.querySelector<HTMLElement>(`[data-index="${index}"]`),
    constraintToggle: (sketchId: string) => container.querySelector<HTMLElement>(`[data-constraints-toggle="${sketchId}"]`),
    groupToggle: (key: string) => container.querySelector<HTMLElement>(`[data-group-toggle="${key}"]`),
    chevronOf: (id: string) => container.querySelector<HTMLElement>(`[data-toggle="${id}"]`),
  };
}

function row(index: number, overrides: Partial<SceneObjectRender>): SceneObjectRender {
  return {
    id: `id-${index}`,
    name: overrides.type ?? overrides.uniqueType ?? 'row',
    sceneShapes: [],
    ownShapes: [],
    visible: true,
    sourceLocation: { filePath: '/a.fluid.js', line: index + 1, column: 1 },
    ...overrides,
  } as SceneObjectRender;
}

// sketch > [line, offset, region, region, constraint], extrude
function sketchScene(): SceneObjectRender[] {
  return [
    row(0, { type: 'sketch', isContainer: true }),
    row(1, { uniqueType: 'solved-line', parentId: 'id-0' }),
    row(2, { type: 'offset', parentId: 'id-0' }),
    row(3, { type: 'region', parentId: 'id-0' }),
    row(4, { type: 'region', parentId: 'id-0' }),
    row(5, { uniqueType: 'constraint-distance', parentId: 'id-0' }),
    row(6, { type: 'extrude' }),
  ];
}

describe('timeline display settings', () => {
  it('lists every sketch child and the constraints group by default, and no regions', () => {
    const h = mount();
    h.timeline.update(sketchScene(), 6);
    expect(h.rowOf(1)).not.toBeNull();
    expect(h.rowOf(2)).not.toBeNull();
    expect(h.constraintToggle('id-0')).not.toBeNull();
    expect(h.rowOf(3)).toBeNull();
    expect(h.groupToggle('id-0:regions')).toBeNull();
  });

  it('"only editable features" keeps the rows with an edit dialog and drops the rest', () => {
    const h = mount();
    h.timeline.isFeatureEditable = (obj) => obj.type === 'offset';
    viewerSettings.update({ timelineSketchChildren: 'editable' });
    h.timeline.update(sketchScene(), 6);
    expect(h.rowOf(1)).toBeNull();
    expect(h.rowOf(2)).not.toBeNull();
    // The constraints group has its own switch and stays.
    expect(h.constraintToggle('id-0')).not.toBeNull();
    expect(h.rowOf(6)).not.toBeNull();
  });

  it('a host that never says which rows are editable keeps listing them all', () => {
    const h = mount();
    viewerSettings.update({ timelineSketchChildren: 'editable' });
    h.timeline.update(sketchScene(), 6);
    expect(h.rowOf(1)).not.toBeNull();
    expect(h.rowOf(2)).not.toBeNull();
  });

  it('a sketch whose every child is unlisted loses its chevron', () => {
    const h = mount();
    h.timeline.isFeatureEditable = () => false;
    viewerSettings.update({ timelineSketchChildren: 'editable', timelineShowConstraints: false });
    h.timeline.update(sketchScene(), 6);
    expect(h.rowOf(0)).not.toBeNull();
    expect(h.chevronOf('id-0')).toBeNull();
    expect(h.constraintToggle('id-0')).toBeNull();
  });

  it('the constraints switch hides the group, and a pick on a hidden constraint lands on its sketch', () => {
    const h = mount();
    viewerSettings.update({ timelineShowConstraints: false });
    h.timeline.update(sketchScene(), 6);
    expect(h.constraintToggle('id-0')).toBeNull();
    h.timeline.setPickedFeature('id-5');
    expect(h.rowOf(0)!.dataset.picked).toBe('true');
  });

  it('a failing constraint still flags its sketch while the group is hidden', () => {
    const h = mount();
    viewerSettings.update({ timelineShowConstraints: false });
    const items = sketchScene();
    items[5].hasError = true;
    h.timeline.update(items, 6);
    expect(h.rowOf(0)!.className.split(' ')).toContain('text-error');
  });

  it('regions fold into an "N regions" group that opens on click and on a pick', () => {
    const h = mount();
    viewerSettings.update({ timelineShowRegions: true });
    h.timeline.update(sketchScene(), 6);
    const toggle = h.groupToggle('id-0:regions')!;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toContain('2 regions');
    expect(h.rowOf(3)).toBeNull();
    toggle.click();
    expect(h.rowOf(3)).not.toBeNull();
    expect(h.rowOf(4)).not.toBeNull();
    h.groupToggle('id-0:regions')!.click();
    expect(h.rowOf(3)).toBeNull();
    h.timeline.setPickedFeature('id-4');
    expect(h.rowOf(4)!.dataset.picked).toBe('true');
  });

  it('a settings change re-renders the open timeline', () => {
    const h = mount();
    h.timeline.update(sketchScene(), 6);
    expect(h.groupToggle('id-0:regions')).toBeNull();
    viewerSettings.update({ timelineShowRegions: true });
    expect(h.groupToggle('id-0:regions')).not.toBeNull();
    viewerSettings.update({ timelineShowConstraints: false });
    expect(h.constraintToggle('id-0')).toBeNull();
  });

  it('dispose stops listening to the store', () => {
    const h = mount();
    h.timeline.update(sketchScene(), 6);
    h.timeline.dispose();
    expect(() => viewerSettings.update({ timelineShowRegions: true })).not.toThrow();
    expect(h.groupToggle('id-0:regions')).toBeNull();
  });
});
