// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LineTool } from '../src/interactive/tools/line-tool';

// Line auto-constraints: the H/V pill claims the commit click of any
// near-ortho line, and previously dropped the end's snap provenance — most
// drawn lines only auto-constrained their start vertex.

type Emitted = { geometry: { kind: string; text: string }[]; constraints: any[] };

/**
 * Drives a LineTool's pill commit against the state a start click and a
 * near-horizontal hover would have left, bypassing the canvas/scene. The
 * solved-context stub records the atomic emission.
 */
function makeTool(emitted: Emitted[]): any {
  const tool: any = Object.create(LineTool.prototype);
  tool.solvedCtx = {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => true,
  };
  tool.startPick = { value: [0, 0], xExpr: '0', yExpr: '0', newVariables: [], typed: false };
  tool.startPoint = [0, 0];
  tool.startSnapRef = null;
  tool.lastSnapRef = null;
  tool.lastSnapPoint = null;
  tool.mousePoint = [40.003, 0.001];
  tool.ctrlHeld = false;
  tool.expressionInput = { hide: () => {}, isTyping: false, isVisible: true };
  tool.rebuildPreview = () => {};
  return tool;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('line tool H/V pill end-snap coincident', () => {
  it('a snapped commit click pins the ortho endpoint onto the vertex', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.lastSnapRef = { line: 12, role: 'end', featureType: 'line' };
    tool.lastSnapPoint = [40.003, 0.001];

    tool.commitWithDimension({ expression: '40' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].geometry[0].text).toBe('line([0, 0], [40, 0])');
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'end' }, { line: 12, role: 'end', featureType: 'line' }],
      inferred: true,
    });
    expect(emitted[0].constraints).toContainEqual({
      kind: 'horizontal',
      targets: [{ newIndex: 0 }],
      inferred: true,
    });
  });

  it('drops the pin when the ortho quantization moved the endpoint off the vertex', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    // A vertex clearly off the horizontal through the start.
    tool.mousePoint = [40, 1.5];
    tool.lastSnapRef = { line: 12, role: 'end', featureType: 'line' };
    tool.lastSnapPoint = [40, 1.5];

    tool.commitWithDimension({ expression: '40' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints.filter((c: any) => c.kind === 'coincident')).toHaveLength(0);
  });
});

describe('line tool axis-datum snaps', () => {
  it('pins BOTH endpoints onto the x axis; the implied horizontal rides as inferred', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.startSnapRef = { datum: 'x-axis' };
    tool.mousePoint = [40, 0];
    tool.lastSnapRef = { datum: 'x-axis' };
    tool.lastSnapPoint = [40, 0];

    tool.commitWithDimension({ expression: '40' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    const coincidents = emitted[0].constraints.filter((c: any) => c.kind === 'coincident');
    // Axis datums are lines, not points — the second on-axis pin must not be
    // deduped against the first. The H the two pins imply together is
    // emitted INFERRED: the rail's redundancy trial (emission-redundancy)
    // is what drops it, with the solver's rank as the verdict.
    expect(coincidents).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'start' }, { datum: 'x-axis' }],
      inferred: true,
    });
    expect(coincidents).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'end' }, { datum: 'x-axis' }],
      inferred: true,
    });
    expect(emitted[0].constraints).toContainEqual({
      kind: 'horizontal',
      targets: [{ newIndex: 0 }],
      inferred: true,
    });
  });

  it('keeps the horizontal when only the end sits on the axis', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.mousePoint = [40, 0];
    tool.lastSnapRef = { datum: 'x-axis' };
    tool.lastSnapPoint = [40, 0];

    tool.commitWithDimension({ expression: '40' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'end' }, { datum: 'x-axis' }],
      inferred: true,
    });
    expect(emitted[0].constraints).toContainEqual({
      kind: 'horizontal',
      targets: [{ newIndex: 0 }],
      inferred: true,
    });
  });
});

describe('line tool axis snap with the cursor far from the endpoint', () => {
  it('a vertical drop onto the x axis pins even when the snapped cursor x is off', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.startPick = { value: [0, 10], xExpr: '0', yExpr: '10', newVariables: [], typed: false };
    tool.startPoint = [0, 10];
    // The axis snap zeroed y but kept the cursor's x, which drifted off the
    // vertical — the resolved endpoint [0, 0] is still ON the axis.
    tool.mousePoint = [0.8, 0];
    tool.lastSnapRef = { datum: 'x-axis' };
    tool.lastSnapPoint = [0.8, 0];

    tool.commitWithDimension({ expression: '10' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].geometry[0].text).toBe('line([0, 10], [0, 0])');
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'end' }, { datum: 'x-axis' }],
      inferred: true,
    });
    expect(emitted[0].constraints).toContainEqual({
      kind: 'vertical',
      targets: [{ newIndex: 0 }],
      inferred: true,
    });
  });
});
