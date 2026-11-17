import { describe, expect, it } from 'vitest';
import { withSelectionHidden } from '../src/ui/measure/selection-hidden';
import type { SelectedEntity } from '../src/viewer';

// The Agent's references capture (§11.2) shows only the references' own
// colours: a selection made since the last Add (the idle selection's amber
// highlight, and its measure overlay) is off while the capture renders, and
// back on screen right after, unchanged.

function fakeViewer() {
  const log: string[] = [];
  let shown: SelectedEntity[] = [];
  return {
    log,
    shown: () => shown,
    clearHighlight() {
      log.push('clear');
      shown = [];
    },
    highlightEntities(entities: SelectedEntity[]) {
      log.push(`highlight ${entities.length}`);
      shown = entities;
    },
  };
}

function fakeOverlay(log: string[]) {
  let hidden = false;
  return {
    hidden: () => hidden,
    setHidden(value: boolean) {
      log.push(value ? 'overlay off' : 'overlay on');
      hidden = value;
    },
  };
}

const selection: SelectedEntity[] = [
  { shapeId: 's1', sub: { type: 'face', index: 3 } },
  { shapeId: 's1', sub: { type: 'edge', index: 7 } },
];

describe('withSelectionHidden', () => {
  it('captures without the selection, then shows the same selection again', () => {
    const viewer = fakeViewer();
    const overlay = fakeOverlay(viewer.log);
    viewer.highlightEntities(selection);
    viewer.log.length = 0;
    const during = withSelectionHidden(viewer, selection, () => {
      viewer.log.push('capture');
      return { highlighted: viewer.shown().length, overlayHidden: overlay.hidden() };
    }, overlay);
    expect(during).toEqual({ highlighted: 0, overlayHidden: true });
    expect(viewer.log).toEqual(['clear', 'overlay off', 'capture', 'overlay on', 'highlight 2']);
    expect(viewer.shown()).toEqual(selection);
    expect(overlay.hidden()).toBe(false);
  });

  it('puts the selection back when the capture throws', () => {
    const viewer = fakeViewer();
    expect(() => withSelectionHidden(viewer, selection, () => {
      throw new Error('no WebGL');
    })).toThrow('no WebGL');
    expect(viewer.shown()).toEqual(selection);
  });

  it('leaves the highlight alone when nothing is selected (another tool may own it)', () => {
    const viewer = fakeViewer();
    const value = withSelectionHidden(viewer, [], () => 'png');
    expect(value).toBe('png');
    expect(viewer.log).toEqual([]);
  });
});
