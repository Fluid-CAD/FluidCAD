// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Viewer } from '../src/viewer';

// A sketch wire under the cursor on the opt-in sketch-pick channel (an armed
// split's cut slot, an extrude's profile) paints like a hovered edge, so the
// dialog shows which sketched line, arc or circle a click would take. A wire
// the dialog already picked keeps its selection tint instead.

/** A stand-in hovering nothing yet, picking the sketch wire `line-3`. */
function hoveringWire(selectedWires: string[]) {
  const paint = vi.fn();
  const clear = vi.fn();
  const viewer = {
    selectionHandler: () => {},
    isMouseDown: false,
    hoverSuppressed: () => false,
    pickAt: () => ({ shapeId: 'line-3', sub: { type: 'sketch' as const, index: 0 }, instanceId: undefined }),
    standardPlanes: { setHover: () => false },
    standardAxes: { setHover: () => false },
    hoverSuppressForInstance: null,
    hoverState: null as unknown,
    highlightedEntities: [],
    highlightedSketchWires: selectedWires,
    highlightedInstanceId: null,
    clearHover: clear,
    applyHoverSketchWire: paint,
    hoverHandler: vi.fn(),
    ctx: { renderer: { domElement: { style: { cursor: '' } } } },
  };
  const updateHover = (Viewer.prototype as unknown as {
    updateHover(this: unknown, x: number, y: number): void;
  }).updateHover;
  return { viewer, paint, clear, updateHover: (x: number, y: number) => updateHover.call(viewer, x, y) };
}

describe('viewer sketch wire hover', () => {
  it('paints the hovered sketch wire and records it as the hover', () => {
    const { viewer, paint, updateHover } = hoveringWire([]);

    updateHover(120, 80);

    expect(paint).toHaveBeenCalledWith('line-3');
    expect(viewer.hoverState).toEqual({ shapeId: 'line-3', sub: { type: 'sketch', index: 0 }, instanceId: null });
    expect(viewer.ctx.renderer.domElement.style.cursor).toBe('pointer');
  });

  it('leaves a selected sketch wire on its selection tint', () => {
    const { viewer, paint, updateHover } = hoveringWire(['line-3']);

    updateHover(120, 80);

    expect(paint).not.toHaveBeenCalled();
    expect(viewer.hoverState).toBeNull();
  });
});
