// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EllipticalArcTool } from '../src/interactive/tools/elliptical-arc-tool';

// The Elliptical Arc tool emits `eArc(start, end, center, rx, ry)` through
// the solved rail. The gesture is the Ellipse tool's (centre, RX, RY)
// followed by the Center Arc tool's (start, sweep to the end). Nothing is
// inferred beyond the snaps: a centre, start or end that lands on a vertex
// becomes a coincident on that point; typed semi-radii land as
// radius(ea, v, 'x' | 'y') dimensions; the rotation stays free.

type Emitted = { geometry: { kind: string; text: string }[]; constraints: any[]; newVariables?: any[] };

const STAGE = { Center: 0, Radii: 1, Start: 2, End: 3 };

function solvedCtx(emitted: Emitted[], autoConstraints = true): any {
  return {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => autoConstraints,
  };
}

/** An EllipticalArcTool at the state the centre click leaves, bypassing
 * canvas and scene. */
function makeTool(emitted: Emitted[], autoConstraints = true): any {
  const tool: any = Object.create(EllipticalArcTool.prototype);
  tool.solvedCtx = solvedCtx(emitted, autoConstraints);
  tool.cachedVariables = [];
  tool.expressionInput = { hide: () => {}, isTyping: false, isVisible: false };
  tool.stage = STAGE.Radii;
  tool.centerPick = { value: [10, 5], xExpr: '10', yExpr: '5', newVariables: [], typed: false };
  tool.centerPoint = [10, 5];
  tool.centerSnapRef = null;
  tool.mousePoint = null;
  tool.lastSnapRef = null;
  tool.radiusPhase = 'rx';
  tool.rxExpression = null;
  tool.ryExpression = null;
  tool.rxTyped = false;
  tool.ryTyped = false;
  tool.lockedRx = null;
  tool.radii = null;
  tool.startParam = 0;
  tool.startPoint = null;
  tool.startSnapRef = null;
  tool.sweepRad = 0;
  tool.rebuildPreview = () => {};
  tool.syncPointInput = () => {};
  return tool;
}

/** The same tool with a 40 × 20 ellipse set around (10, 5). */
function withEllipse(emitted: Emitted[], autoConstraints = true): any {
  const tool = makeTool(emitted, autoConstraints);
  tool.lockRadii({ expression: '40' }, { expression: '20' }, false, false);
  return tool;
}

/** Move the cursor, as a mouse move does once the ellipse is set. */
function moveTo(tool: any, point: [number, number], ref: any = null): void {
  tool.mousePoint = point;
  tool.lastSnapRef = ref;
  tool.advanceSweep();
}

describe('elliptical arc tool: the ellipse', () => {
  it('a click with no pill in hand takes both semi-radii off the cursor and moves on to the start', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);

    tool.commitRadiiFromCursor([50.004, -15]);

    expect(tool.radii).toEqual({ rx: 40, ry: 20 });
    expect(tool.stage).toBe(STAGE.Start);
    // Nothing is written until the arc has both ends.
    expect(emitted).toHaveLength(0);
  });

  it('a committed RX pill carries into a cursor-sized RY', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.cachedVariables = [{ name: 'w', value: 32 }];
    tool.rxExpression = { expression: 'w' };
    tool.rxTyped = true;
    tool.lockedRx = 32;
    tool.radiusPhase = 'ry';

    tool.commitRadiiFromCursor([10, 17]);

    expect(tool.radii).toEqual({ rx: 32, ry: 12 });
    expect(tool.rxExpression).toEqual({ expression: 'w' });
    expect(tool.rxTyped).toBe(true);
    expect(tool.ryTyped).toBe(false);
  });

  it('refuses a degenerate cursor radius and stays where it is', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);

    tool.commitRadiiFromCursor([10, 20]);

    expect(tool.radii).toBeNull();
    expect(tool.stage).toBe(STAGE.Radii);
  });
});

describe('elliptical arc tool: the arc', () => {
  it('reads the start click onto the ellipse', () => {
    const tool = withEllipse([]);

    // Straight right of the centre, well outside the ellipse.
    moveTo(tool, [90, 5]);
    tool.placeStart(false);

    expect(tool.stage).toBe(STAGE.End);
    expect(tool.startPoint[0]).toBeCloseTo(50, 9);
    expect(tool.startPoint[1]).toBeCloseTo(5, 9);
    expect(tool.sweepRad).toBe(0);
  });

  it('emits a counter-clockwise quarter with 2dp literals and no constraints', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);
    moveTo(tool, [90, 5]);
    tool.placeStart(false);

    // Up to the top of the ellipse, the short way round.
    moveTo(tool, [10, 60]);
    tool.commitArc(false);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].geometry).toEqual([{ kind: 'eArc', text: 'eArc([50, 5], [10, 25], [10, 5], 40, 20)' }]);
    expect(emitted[0].constraints).toEqual([]);
    expect(emitted[0].newVariables).toBeUndefined();
    // The gesture is over: the next click lands a new centre.
    expect(tool.stage).toBe(STAGE.Center);
    expect(tool.centerPoint).toBeNull();
    expect(tool.radii).toBeNull();
  });

  it('writes .cw() when the cursor goes round the other way', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);
    moveTo(tool, [90, 5]);
    tool.placeStart(false);

    moveTo(tool, [10, -60]);
    tool.commitArc(false);

    expect(emitted[0].geometry[0].text).toBe('eArc([50, 5], [10, -15], [10, 5], 40, 20).cw()');
  });

  it('carries the sweep past a half turn instead of flipping to the short side', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);
    moveTo(tool, [90, 5]);
    tool.placeStart(false);

    // Counter-clockwise through the top, the left, and on to the bottom.
    moveTo(tool, [10, 60]);
    moveTo(tool, [-60, 5]);
    moveTo(tool, [10, -60]);
    expect(tool.sweepRad).toBeCloseTo(1.5 * Math.PI, 9);
    tool.commitArc(false);

    // Three quarters, still counter-clockwise: no .cw().
    expect(emitted[0].geometry[0].text).toBe('eArc([50, 5], [10, -15], [10, 5], 40, 20)');
  });

  it('holds just shy of a whole turn', () => {
    const tool = withEllipse([]);
    moveTo(tool, [90, 5]);
    tool.placeStart(false);

    for (const p of [[10, 60], [-60, 5], [10, -60], [90, 4.9], [90, 20]] as [number, number][]) {
      moveTo(tool, p);
    }

    expect(tool.sweepRad).toBeLessThan(2 * Math.PI);
    expect(tool.sweepRad).toBeGreaterThan(1.99 * Math.PI);
  });

  it('refuses an end click that has not swept anything', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);
    moveTo(tool, [90, 5]);
    tool.placeStart(false);

    tool.commitArc(false);

    expect(emitted).toHaveLength(0);
    expect(tool.stage).toBe(STAGE.End);
  });
});

describe('elliptical arc tool: snaps and dimensions', () => {
  const lineEnd = { line: 7, role: 'end', featureType: 'line' };
  const arcStart = { line: 9, role: 'start', featureType: 'arc' };

  it('a snapped centre, start and end each pin their own point of the arc', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);
    tool.centerSnapRef = { datum: 'origin' };

    // Vertices sitting on the ellipse, where the cursor snapped to them.
    moveTo(tool, [50, 5], lineEnd);
    tool.placeStart(false);
    moveTo(tool, [10, 25], arcStart);
    tool.commitArc(false);

    expect(emitted[0].constraints).toEqual([
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'center' }, { datum: 'origin' }], inferred: true },
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, lineEnd], inferred: true },
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'end' }, arcStart], inferred: true },
    ]);
  });

  it('a snapped vertex far off the ellipse only picks the place, not a join', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);

    moveTo(tool, [90, 5], lineEnd);
    tool.placeStart(false);
    moveTo(tool, [10, 60], arcStart);
    tool.commitArc(false);

    expect(emitted[0].constraints).toEqual([]);
  });

  it('an end on a sketch axis is judged by its own distance to the axis', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);
    tool.centerPick = { value: [0, 0], xExpr: '0', yExpr: '0', newVariables: [], typed: false };
    tool.centerPoint = [0, 0];

    moveTo(tool, [70, 0], { datum: 'x-axis' });
    tool.placeStart(false);
    moveTo(tool, [0, 44], { datum: 'y-axis' });
    tool.commitArc(false);

    expect(emitted[0].constraints).toEqual([
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, { datum: 'x-axis' }], inferred: true },
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'end' }, { datum: 'y-axis' }], inferred: true },
    ]);
  });

  it('Ctrl on a click leaves that end unjoined', () => {
    const emitted: Emitted[] = [];
    const tool = withEllipse(emitted);

    moveTo(tool, [50, 5], lineEnd);
    tool.placeStart(true);
    moveTo(tool, [10, 25], arcStart);
    tool.commitArc(true);

    expect(emitted[0].constraints).toEqual([]);
  });

  it('the Auto-constraints toggle gates the snap coincidents but not a typed radius', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted, false);
    tool.centerSnapRef = { datum: 'origin' };
    tool.lockRadii({ expression: '40' }, { expression: '20' }, true, false);

    moveTo(tool, [50, 5], lineEnd);
    tool.placeStart(false);
    moveTo(tool, [10, 25]);
    tool.commitArc(false);

    expect(emitted[0].constraints).toEqual([
      { kind: 'radius', targets: [{ newIndex: 0 }], valueExpr: '40', axis: 'x' },
    ]);
  });

  it('typed radii land verbatim as the statement arguments and as dimensions, declaring new variables', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.centerPick = { value: [0, 0], xExpr: 'cx', yExpr: '0', newVariables: [{ name: 'cx', initializer: '0' }], typed: true };
    tool.centerPoint = [0, 0];
    tool.cachedVariables = [{ name: 'rx', value: 40 }];
    tool.lockRadii(
      { expression: 'rx', newVariable: { name: 'rx', initializer: '40' } },
      { expression: '20' },
      true,
      true,
    );

    moveTo(tool, [90, 0]);
    tool.placeStart(false);
    moveTo(tool, [0, 60]);
    tool.commitArc(false);

    expect(emitted[0].geometry).toEqual([{ kind: 'eArc', text: 'eArc([40, 0], [0, 20], [cx, 0], rx, 20)' }]);
    expect(emitted[0].constraints).toEqual([
      { kind: 'radius', targets: [{ newIndex: 0 }], valueExpr: 'rx', axis: 'x' },
      { kind: 'radius', targets: [{ newIndex: 0 }], valueExpr: '20', axis: 'y' },
    ]);
    expect(emitted[0].newVariables).toEqual([
      { name: 'cx', initializer: '0' },
      { name: 'rx', initializer: '40' },
    ]);
  });
});

describe('elliptical arc tool: Escape', () => {
  it('steps back one stage at a time: the sweep, the start, the radii, the centre', () => {
    const tool = withEllipse([]);
    tool.handlePointInputEscape = () => false;
    moveTo(tool, [90, 5]);
    tool.placeStart(false);
    moveTo(tool, [10, 60]);

    tool.handleKeyDown({ key: 'Escape' });
    expect(tool.stage).toBe(STAGE.Start);
    expect(tool.startPoint).toBeNull();
    expect(tool.radii).toEqual({ rx: 40, ry: 20 });

    tool.handleKeyDown({ key: 'Escape' });
    expect(tool.stage).toBe(STAGE.Radii);
    expect(tool.radii).toBeNull();
    expect(tool.centerPoint).toEqual([10, 5]);

    tool.handleKeyDown({ key: 'Escape' });
    expect(tool.stage).toBe(STAGE.Center);
    expect(tool.centerPoint).toBeNull();
  });

  it('a typed coordinate clears first', () => {
    const tool = makeTool([]);
    tool.handlePointInputEscape = () => true;

    tool.handleKeyDown({ key: 'Escape' });

    expect(tool.stage).toBe(STAGE.Radii);
    expect(tool.centerPoint).toEqual([10, 5]);
  });
});
