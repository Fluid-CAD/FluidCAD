// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ThreePointArcTool } from '../src/interactive/tools/three-point-arc-tool';

// Three-point-arc auto-constraints: both anchor clicks' snap refs become
// coincidents. Axis-datum refs must not dedupe against each other — the
// naive field comparison read undefined === undefined and swallowed the
// end's pin whenever both anchors snapped onto the same axis.

type Emitted = { geometry: { kind: string; text: string }[]; constraints: any[] };

/**
 * Drives a ThreePointArcTool's emission against the state the two anchor
 * clicks would have left, bypassing the canvas/scene. The solved-context
 * stub records the atomic emission.
 */
function makeTool(emitted: Emitted[]): any {
  const tool: any = Object.create(ThreePointArcTool.prototype);
  tool.solvedCtx = {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => true,
  };
  tool.startPick = { value: [-10, 0], xExpr: '-10', yExpr: '0', newVariables: [], typed: false };
  tool.startPoint = [-10, 0];
  tool.endPick = { value: [10, 0], xExpr: '10', yExpr: '0', newVariables: [], typed: false };
  tool.endPoint = [10, 0];
  tool.startSnapRef = null;
  tool.endSnapRef = null;
  tool.mousePoint = [0, 10];
  tool.expressionInput = { hide: () => {}, isVisible: false };
  tool.rebuildPreview = () => {};
  return tool;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('three-point arc snap coincidents', () => {
  it('pins both snapped anchors onto their vertices', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.startSnapRef = { line: 7, role: 'end', featureType: 'line' };
    tool.endSnapRef = { line: 9, role: 'start', featureType: 'line' };

    tool.emitArc(tool.startPick, tool.endPick, [0, 0], true);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'start' }, { line: 7, role: 'end', featureType: 'line' }],
      inferred: true,
    });
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'end' }, { line: 9, role: 'start', featureType: 'line' }],
      inferred: true,
    });
  });

  it('start and end both on the x axis get two distinct coincidents', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.startSnapRef = { datum: 'x-axis' };
    tool.endSnapRef = { datum: 'x-axis' };

    tool.emitArc(tool.startPick, tool.endPick, [0, 0], true);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'start' }, { datum: 'x-axis' }],
      inferred: true,
    });
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'end' }, { datum: 'x-axis' }],
      inferred: true,
    });
  });

  it('still dedupes both anchors snapped onto ONE statement vertex', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.startSnapRef = { line: 7, role: 'end', featureType: 'line' };
    tool.endSnapRef = { line: 7, role: 'end', featureType: 'line' };

    tool.emitArc(tool.startPick, tool.endPick, [0, 0], true);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints.filter((c: any) => c.kind === 'coincident')).toHaveLength(1);
  });
});
