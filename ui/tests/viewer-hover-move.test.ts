// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Viewer } from '../src/viewer';

// The viewer dedups hover by entity: moving along the face/edge already
// hovered never re-fires the hover handler. The hover-move handler is how
// the anchor rails (Connector tool, Hole dialog) still see the cursor move —
// without it the suggestion stuck to whichever edge anchor was nearest on
// entry.

/** A stand-in already hovering edge 3 of `solid`, picking the same edge again. */
function hoveringEdge() {
  const edge = { shapeId: 'solid', sub: { type: 'edge' as const, index: 3 } };
  const hover = vi.fn();
  const move = vi.fn();
  const viewer = {
    selectionHandler: () => {},
    isMouseDown: false,
    hoverSuppressed: () => false,
    pickAt: () => ({ ...edge, instanceId: undefined }),
    standardPlanes: { setHover: () => false },
    standardAxes: { setHover: () => false },
    hoverSuppressForInstance: null,
    hoverState: { ...edge, instanceId: null },
    hoverHandler: hover,
    hoverMoveHandler: move,
  };
  const updateHover = (Viewer.prototype as unknown as {
    updateHover(this: unknown, x: number, y: number): void;
  }).updateHover;
  return { viewer, hover, move, updateHover: (x: number, y: number) => updateHover.call(viewer, x, y) };
}

describe('viewer hover move', () => {
  it('reports cursor moves along the hovered entity to the hover-move handler only', () => {
    const { hover, move, updateHover } = hoveringEdge();

    updateHover(120, 80);
    updateHover(140, 90);

    expect(hover).not.toHaveBeenCalled();
    expect(move.mock.calls).toEqual([
      ['solid', { type: 'edge', index: 3 }, 120, 80],
      ['solid', { type: 'edge', index: 3 }, 140, 90],
    ]);
  });
});
