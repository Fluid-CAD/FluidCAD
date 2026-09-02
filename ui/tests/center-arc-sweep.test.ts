// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CenterArcTool } from '../src/interactive/tools/center-arc-tool';

// `const enum State` is module-private and inlined at compile time; the sweep
// phase — centre and start both down — is its third member.
const START_PLACED = 2;
const RADIUS = 10;

type Emitted = { geometry: { kind: string; text: string }[]; constraints: unknown[] };

/**
 * Drives a CenterArcTool's sweep against its real accumulator, bypassing the
 * canvas/scene: the tool object is created without its constructor and fed
 * the state the centre and start clicks would have left. The solved-context
 * stub records the emission.
 */
function makeTool(emitted: Emitted[]): any {
  const tool: any = Object.create(CenterArcTool.prototype);
  tool.solvedCtx = {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => false,
  };
  tool.state = START_PLACED;
  tool.centerPoint = [0, 0];
  tool.startPoint = [RADIUS, 0];
  tool.centerPick = { value: [0, 0], xExpr: '0', yExpr: '0', newVariables: [], typed: false };
  tool.startPick = {
    value: [RADIUS, 0], xExpr: String(RADIUS), yExpr: '0', newVariables: [], typed: false,
  };
  tool.centerSnapRef = null;
  tool.startSnapRef = null;
  tool.lastSnapRef = null;
  tool.sweepRad = 0;
  tool.mousePoint = [RADIUS, 0];
  tool.expressionInput = { hide: () => {}, isVisible: false };
  tool.rebuildPreview = () => {};
  return tool;
}

function cursorAt(deg: number): [number, number] {
  const a = deg * (Math.PI / 180);
  return [RADIUS * Math.cos(a), RADIUS * Math.sin(a)];
}

/** Walk the cursor round the centre in small steps — the accumulator reads
 * each sample as the shorter way round, which holds for a real mouse. */
function drag(tool: any, fromDeg: number, toDeg: number): void {
  const step = fromDeg <= toDeg ? 5 : -5;
  for (let d = fromDeg + step; step > 0 ? d < toDeg : d > toDeg; d += step) {
    tool.mousePoint = cursorAt(d);
    tool.advanceSweep();
  }
  tool.mousePoint = cursorAt(toDeg);
  tool.advanceSweep();
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('center arc sweep', () => {
  it('carries on past a half turn instead of flipping to the short side', () => {
    const tool = makeTool([]);
    drag(tool, 0, 270);
    expect(tool.getSweepDeg()).toBeCloseTo(270, 6);
    expect(tool.ccw).toBe(true);
  });

  it('emits a major arc counter-clockwise, with no cw() flip', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    drag(tool, 0, 270);
    tool.commitFromMouse(false);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].geometry[0].text).toBe('arc([10, 0], [0, -10], [0, 0])');
  });

  it('emits a major arc clockwise as cw()', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    drag(tool, 0, -200);
    expect(tool.getSweepDeg()).toBeCloseTo(200, 6);
    expect(tool.ccw).toBe(false);

    tool.commitFromMouse(false);
    await flushMicrotasks();
    expect(emitted[0].geometry[0].text).toBe('arc([10, 0], [-9.4, 3.42], [0, 0]).cw()');
  });

  it('reverses through the half turn without changing side', () => {
    const tool = makeTool([]);
    drag(tool, 0, 270);
    drag(tool, 270, 90);
    expect(tool.getSweepDeg()).toBeCloseTo(90, 6);
    expect(tool.ccw).toBe(true);
  });

  it('holds just shy of a full turn however far the cursor keeps going', () => {
    const tool = makeTool([]);
    drag(tool, 0, 800);
    expect(tool.getSweepDeg()).toBeLessThanOrEqual(359.5);
    expect(tool.getSweepDeg()).toBeGreaterThan(359);
    expect(tool.ccw).toBe(true);
  });

  it('takes a typed angle past a half turn', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    drag(tool, 0, 20);
    tool.commitFromExpression({ expression: '300' });
    await flushMicrotasks();
    // 300° counter-clockwise off the +X start ray.
    expect(emitted[0].geometry[0].text).toBe('arc([10, 0], [5, -8.66], [0, 0])');
  });

  it('refuses a typed angle of a full turn or more', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    drag(tool, 0, 20);
    tool.commitFromExpression({ expression: '360' });
    await flushMicrotasks();
    expect(emitted).toHaveLength(0);
  });

  it('will not commit an arc that has not swept', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.commitFromMouse(false);
    await flushMicrotasks();
    expect(emitted).toHaveLength(0);
  });
});

describe('center arc end-snap coincident', () => {
  const END_COINCIDENT = {
    kind: 'coincident',
    targets: [
      { newIndex: 0, role: 'end' },
      { line: 12, role: 'start', featureType: 'line' },
    ],
    inferred: true,
  };

  function makeSnappedTool(emitted: Emitted[]): any {
    const tool = makeTool(emitted);
    tool.solvedCtx.autoConstraints = () => true;
    tool.lastSnapRef = { line: 12, role: 'start', featureType: 'line' };
    return tool;
  }

  it('a snapped sweep click pins the endpoint onto the vertex', async () => {
    const emitted: Emitted[] = [];
    const tool = makeSnappedTool(emitted);
    drag(tool, 0, 90);
    tool.commitFromMouse(false);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual(END_COINCIDENT);
  });

  it('the ∠ pill commit click keeps the snap provenance too', async () => {
    const emitted: Emitted[] = [];
    const tool = makeSnappedTool(emitted);
    drag(tool, 0, 90);
    tool.commitFromExpression({ expression: '90' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual(END_COINCIDENT);
  });

  it('a vertex far off the circle only locked the sweep angle — no coincident', async () => {
    const emitted: Emitted[] = [];
    const tool = makeSnappedTool(emitted);
    drag(tool, 0, 90);
    // The snapped vertex sits on the 90° bearing but well off the radius.
    tool.mousePoint = [0, 25];
    tool.commitFromMouse(false);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).not.toContainEqual(END_COINCIDENT);
  });

  it('Ctrl on the commit click suppresses the inference', async () => {
    const emitted: Emitted[] = [];
    const tool = makeSnappedTool(emitted);
    drag(tool, 0, 90);
    tool.commitFromMouse(true);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).not.toContainEqual(END_COINCIDENT);
  });
});

describe('center arc axis-datum snaps', () => {
  it('start and end both on the x axis get two distinct coincidents', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.solvedCtx.autoConstraints = () => true;
    // The start click snapped onto the x axis; the sweep click did too.
    tool.startSnapRef = { datum: 'x-axis' };
    tool.lastSnapRef = { datum: 'x-axis' };
    drag(tool, 0, 180);
    tool.commitFromMouse(false);
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
});

describe('center arc axis snap with the cursor far from the endpoint', () => {
  it('keeps the on-axis coincident — the axis snap holds the cursor x, not the meet point', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.solvedCtx.autoConstraints = () => true;
    tool.lastSnapRef = { datum: 'x-axis' };
    drag(tool, 0, 180);
    // The commit click sits ON the axis but well away from where the arc
    // meets it (the axis snap zeroes y and keeps the cursor's x).
    tool.mousePoint = [-5, 0];
    tool.commitFromMouse(false);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'end' }, { datum: 'x-axis' }],
      inferred: true,
    });
  });

  it('an endpoint clearly off the axis still gets no pin', async () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.solvedCtx.autoConstraints = () => true;
    tool.lastSnapRef = { datum: 'x-axis' };
    drag(tool, 0, 90);
    // Endpoint at [0, 10]; the cursor's axis snap can't make that on-axis.
    tool.mousePoint = [0.2, 0];
    tool.commitFromMouse(false);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints.filter(
      (c: any) => c.kind === 'coincident',
    )).toHaveLength(0);
  });
});
