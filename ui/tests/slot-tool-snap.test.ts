// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { SlotTool } from '../src/interactive/tools/slot-tool';

// Slot auto-constraints: the anchor click's snap pins the first cap centre,
// the distance click's snap pins the second — the slot previously emitted no
// snap coincidents at all.

type Emitted = { geometry: { kind: string; text: string }[]; constraints: any[] };

/**
 * Drives a SlotTool's commit against the state the anchor + distance clicks
 * would have left, bypassing the canvas/scene. The solved-context stub
 * records the atomic emission.
 */
function makeTool(emitted: Emitted[]): any {
  const tool: any = Object.create(SlotTool.prototype);
  tool.solvedCtx = {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => true,
  };
  tool.centered = false;
  tool.cachedVariables = [];
  tool.expressionInput = { hide: () => {}, isTyping: false, isVisible: false };
  tool.startPick = { value: [0, 0], xExpr: '0', yExpr: '0', newVariables: [], typed: false };
  tool.startPoint = [0, 0];
  tool.startSnapRef = null;
  tool.distSnap = null;
  tool.lockedDir = [1, 0];
  tool.lockedDistance = 40;
  tool.distanceTyped = false;
  tool.rebuildPreview = () => {};
  return tool;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('slot tool snap coincidents', () => {
  it('a snapped anchor pins the first cap centre', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.startSnapRef = { line: 7, role: 'end', featureType: 'line' };

    tool.commitSlot(tool.startPick, { expression: '40' }, { expression: '5' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 3, role: 'center' }, { line: 7, role: 'end', featureType: 'line' }],
      inferred: true,
    });
  });

  it('a snapped distance click pins the second cap centre, off-grid vertex included', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.distSnap = {
      snapType: 'vertex',
      point2d: [40.003, 0.001],
      ref: { line: 9, role: 'center', featureType: 'circle' },
    };

    tool.commitSlot(tool.startPick, { expression: '40' }, { expression: '5' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 1, role: 'center' }, { line: 9, role: 'center', featureType: 'circle' }],
      inferred: true,
    });
  });

  it('drops the distance snap when the committed length moved p1 off the vertex', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.distSnap = {
      snapType: 'vertex',
      point2d: [45, 2],
      ref: { line: 9, role: 'center', featureType: 'circle' },
    };

    tool.commitSlot(tool.startPick, { expression: '40' }, { expression: '5' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    const pins = emitted[0].constraints.filter(
      (c: any) => c.kind === 'coincident' && c.targets.some((t: any) => t.line === 9),
    );
    expect(pins).toHaveLength(0);
  });

  it('the Auto-constraints toggle suppresses both pins', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.solvedCtx.autoConstraints = () => false;
    tool.startSnapRef = { line: 7, role: 'end', featureType: 'line' };
    tool.distSnap = {
      snapType: 'vertex',
      point2d: [40, 0],
      ref: { line: 9, role: 'center', featureType: 'circle' },
    };

    tool.commitSlot(tool.startPick, { expression: '40' }, { expression: '5' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    const pins = emitted[0].constraints.filter(
      (c: any) => c.kind === 'coincident' && c.targets.some((t: any) => t.line !== undefined),
    );
    expect(pins).toHaveLength(0);
  });
});

describe('centered slot tool snap', () => {
  it('a snapped centre pins the midpoint between the two cap centres', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.centered = true;
    tool.startSnapRef = { datum: 'origin' };

    tool.commitSlot(tool.startPick, { expression: '40' }, { expression: '5' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'midpoint',
      targets: [{ datum: 'origin' }, { newIndex: 3, role: 'center' }, { newIndex: 1, role: 'center' }],
      inferred: true,
    });
    // No cap centre pretends to sit on the anchor.
    const pins = emitted[0].constraints.filter(
      (c: any) => c.kind === 'coincident' && c.targets.some((t: any) => t.datum !== undefined),
    );
    expect(pins).toHaveLength(0);
  });
});

describe('slot tool axis-datum snaps', () => {
  it('both cap centres on the x axis get two distinct coincidents', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.startSnapRef = { datum: 'x-axis' };
    tool.distSnap = { snapType: 'vertex', point2d: [40, 0], ref: { datum: 'x-axis' } };

    tool.commitSlot(tool.startPick, { expression: '40' }, { expression: '5' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 3, role: 'center' }, { datum: 'x-axis' }],
      inferred: true,
    });
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 1, role: 'center' }, { datum: 'x-axis' }],
      inferred: true,
    });
  });
});
