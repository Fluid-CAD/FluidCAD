// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { BufferGeometry, Group, Line, LineBasicMaterial, PerspectiveCamera, Scene } from 'three';
import { SketchHoverSelectHandler } from '../src/interactive/sketch-hover-select-handler';
import { themeColors } from '../src/scene/theme-colors';

// ---------------------------------------------------------------------------
// Hover/selection tints mutate the line's material colour in place and stash
// the colour to restore on the line's userData. Two routes light an edge —
// the edge hover and a constraint badge hover (which lights the entities the
// badge references). When both reached the same line, the second saved the
// HIGHLIGHT as the colour to restore and the edge stayed lit for good, no
// matter what was clicked afterwards. Both routes now go through one
// idempotent apply.
// ---------------------------------------------------------------------------

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

const BASE = 0x123456;
const HIGHLIGHT = themeColors.highlightColor.getHex();

function harness() {
  const scene = new Scene();
  const group = new Group();
  group.userData.shapeId = 'e1';
  const material = new LineBasicMaterial({ color: BASE });
  const line = new Line(new BufferGeometry(), material);
  group.add(line);
  scene.add(group);
  const ctx = {
    scene,
    camera: new PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    requestRender: () => {},
  } as any;
  const handler = new SketchHoverSelectHandler(ctx, PLANE as any, () => false);
  const h = handler as any;
  return { handler, h, material };
}

function fakeBadge(entityId: number) {
  return {
    objId: 'c9',
    sourceLocation: { filePath: '/x.fluid.js', line: 3 },
    materials: [],
    baseColor: { r: 0, g: 0, b: 0 },
    refEntityIds: [entityId],
    onGeometry: false,
    anchorWorld: { clone: () => ({ project: () => ({ x: 0, y: 0, z: 0 }) }) },
    placement: { visible: true, dx: 0, dy: 0 },
  };
}

describe('sketch hover/select tint bookkeeping', () => {
  it('a second hover apply on a lit edge keeps the saved base colour', () => {
    const { h, material } = harness();
    h.applyHoverHighlight('e1');
    h.applyHoverHighlight('e1');
    h.removeHoverHighlight('e1');
    expect(material.color.getHex()).toBe(BASE);
  });

  it('an edge lit by its hover and by a badge referencing it restores after both clear', () => {
    const { h, material } = harness();
    h.entityShapeIds = new Map([[7, ['e1']]]);
    // The old mouse-move order: edge hover first, badge tint over it, then
    // the edge hover cleared while the badge stays, then the badge cleared.
    h.applyHoverHighlight('e1');
    h.hoveredShapeId = 'e1';
    h.applyBadgeHover(fakeBadge(7));
    expect(material.color.getHex()).toBe(HIGHLIGHT);
    h.clearHover();
    h.clearBadgeHover();
    expect(material.color.getHex()).toBe(BASE);
  });

  it('a plain click on a constraint badge clears the geometry selection first', () => {
    const { handler, h, material } = harness();
    const order: string[] = [];
    handler.onSelectionChange = () => order.push('selection');
    handler.onConstraintPick = (pick) => order.push(`constraint:${pick.objId}`);
    h.selectedShapeIds.add('e1');
    h.pickSequence.push('e:e1');
    h.applySelectionHighlight('e1');
    expect(material.color.getHex()).toBe(HIGHLIGHT);

    h.hoveredBadge = fakeBadge(7);
    h.handleMouseUp({ clientX: 0, clientY: 0, ctrlKey: false, metaKey: false });

    expect(order).toEqual(['selection', 'constraint:c9']);
    expect(handler.selectedIds.size).toBe(0);
    expect(material.color.getHex()).toBe(BASE);
  });

  it('a Ctrl-click on a constraint badge keeps the geometry selection', () => {
    const { handler, h } = harness();
    const order: string[] = [];
    handler.onSelectionChange = () => order.push('selection');
    handler.onConstraintPick = () => order.push('constraint');
    h.selectedShapeIds.add('e1');
    h.applySelectionHighlight('e1');

    h.hoveredBadge = fakeBadge(7);
    h.handleMouseUp({ clientX: 0, clientY: 0, ctrlKey: true, metaKey: false });

    expect(order).toEqual(['constraint']);
    expect(handler.selectedIds.has('e1')).toBe(true);
  });
});
