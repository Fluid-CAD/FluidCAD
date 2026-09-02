// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { resolveExpressionValue, type VariableInfo } from '../src/ui/expression-core';
import { LineMode } from '../src/interactive/tools/polyline/mode-line';
import { ALineMode } from '../src/interactive/tools/polyline/mode-aline';
import { ArcMode } from '../src/interactive/tools/polyline/mode-arc';
import { TArcMode } from '../src/interactive/tools/polyline/mode-tarc';
import { PolylineTool } from '../src/interactive/tools/polyline/polyline-tool';
import { PolylinePhase } from '../src/interactive/tools/polyline/types';
import type { ModeContext, Point2D, SegmentCommitResult, SolvedSegmentSpec } from '../src/interactive/tools/polyline/types';
import type { SolvedEmissionTargetParam } from '../src/interactive/tools/solved-emission';
import { ExpressionInput } from '../src/ui/expression-input';
import type { SnapResult } from '../src/snapping/types';

Element.prototype.scrollIntoView = () => {};

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

const SNAP: SnapResult = { snapType: 'none' } as unknown as SnapResult;

type CtxOptions = {
  startPoint?: Point2D;
  tangent?: { direction: Point2D; point: Point2D } | null;
  orthoOverride?: boolean;
  pendingStartText?: string | null;
  variables?: VariableInfo[];
  /** The previous solved chain segment, for junction constraints. */
  prev?: SolvedEmissionTargetParam | null;
  prevKind?: 'line' | 'arc' | null;
  prevDir?: Point2D | null;
  autoConstraints?: boolean;
};

// The XY plane in scene-payload shape.
const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

// Drives a segment mode against a plain-object ModeContext backed by a real
// ExpressionInput, bypassing the tool/canvas/scene entirely. The solved
// context stub records what the mode emits.
function makeCtx(opts: CtxOptions = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const expr = new ExpressionInput(container);
  const emitted: SolvedSegmentSpec[] = [];
  const committed: SegmentCommitResult[] = [];
  const hints: (string | null)[] = [];

  const state = {
    orthoOverride: opts.orthoOverride ?? false,
    pendingStartText: opts.pendingStartText ?? null,
  };
  const variables = opts.variables ?? [];

  const ctx = {
    plane: PLANE,
    previewGroup: {},
    camera: {},
    planeNormal: {},
    tangent: opts.tangent ?? null,
    startPoint: opts.startPoint ?? [0, 0],
    pendingStartText: () => state.pendingStartText,
    setSnapHint: (hint: string | null) => hints.push(hint),
    resolveCommittedValue: (result: { expression: string; newVariable?: { name: string; initializer: string } }) =>
      resolveExpressionValue(result.expression, variables, result.newVariable ?? null),
    formatPoint: (p: Point2D) => `[${p[0]}, ${p[1]}]`,
    requestRender: () => {},
    isOrthoOverride: () => state.orthoOverride,
    showExpressionInput: (o: any) => {
      if (!expr.isVisible) {
        expr.show({ ...o, variables });
      }
    },
    updateExpressionValue: (v: number) => expr.updateValue(v),
    updateExpressionPosition: () => {},
    hideExpressionInput: () => expr.hide(),
    isExpressionVisible: () => expr.isVisible,
    isExpressionTyping: () => expr.isTyping,
    commitExpressionValue: () => expr.commitCurrentValue(),
    onSegmentCommitted: (r: SegmentCommitResult) => committed.push(r),
    solved: {
      prevEntity: () => opts.prev ?? null,
      prevKind: () => opts.prevKind ?? null,
      prevOrientedDir: () => opts.prevDir ?? null,
      emitSegment: (spec: SolvedSegmentSpec) => emitted.push(spec),
      autoConstraints: () => opts.autoConstraints ?? true,
    },
  } as unknown as ModeContext;

  const input = container.querySelector('.expression-input') as HTMLInputElement;
  return { ctx, expr, input, emitted, committed, hints, state };
}

describe('LineMode H/V auto-snap', () => {
  it('emits a free line for a clearly diagonal click', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    const result = mode.handleClick([30, 40], SNAP, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('line([0, 0], [30, 40])');
    expect(emitted[0].constraints ?? []).toEqual([]);
    expect(result.kind).toBe('committed');
    if (result.kind === 'committed') {
      expect(result.result.endpoint).toEqual([30, 40]);
      expect(result.result.exitTangent?.direction[0]).toBeCloseTo(0.6);
      expect(result.result.exitTangent?.direction[1]).toBeCloseTo(0.8);
    }
  });

  it('snaps a 4.9-degree click to a horizontal line', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    const result = mode.handleClick([100, 8.57], SNAP, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('line([0, 0], [100, 0])');
    expect(emitted[0].constraints).toEqual([{ kind: 'horizontal', targets: [{ newIndex: 0 }], inferred: true }]);
    expect(result.kind).toBe('committed');
    if (result.kind === 'committed') {
      expect(result.result.endpoint).toEqual([100, 0]);
      expect(result.result.exitTangent?.direction).toEqual([1, 0]);
    }
  });

  it('keeps a 5.1-degree click as a free line', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([100, 8.93], SNAP, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('line([0, 0], [100, 8.93])');
    expect(emitted[0].constraints ?? []).toEqual([]);
  });

  it('snaps a near-vertical click to a vertical line with the signed distance', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    const result = mode.handleClick([1, -50], SNAP, ctx);

    expect(emitted[0].text).toBe('line([0, 0], [0, -50])');
    expect(emitted[0].constraints).toEqual([{ kind: 'vertical', targets: [{ newIndex: 0 }], inferred: true }]);
    if (result.kind === 'committed') {
      expect(result.result.endpoint).toEqual([0, -50]);
      expect(result.result.exitTangent?.direction).toEqual([0, -1]);
    }
  });

  it('Ctrl override forces a free line on an axial click', () => {
    const { ctx, emitted } = makeCtx({ orthoOverride: true });
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([100, 0], SNAP, ctx);

    expect(emitted[0].text).toBe('line([0, 0], [100, 0])');
    expect(emitted[0].constraints ?? []).toEqual([]);
  });

  it('Auto-constraints off keeps the ortho quantization but writes no H/V', () => {
    const { ctx, emitted } = makeCtx({ autoConstraints: false });
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([100, 8.57], SNAP, ctx);

    expect(emitted[0].text).toBe('line([0, 0], [100, 0])');
    expect(emitted[0].constraints).toEqual([]);
  });

  it('spends a pending typed start as the line start', () => {
    const { ctx, emitted } = makeCtx({ pendingStartText: '[w / 2, 10]' });
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([50, 0], SNAP, ctx);

    expect(emitted[0].text).toBe('line([w / 2, 10], [50, 0])');
  });

  it('shows the H: input while snapped and a typed commit becomes a dimension', () => {
    const { ctx, expr, input, emitted, committed } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleMouseMove([50, 1], SNAP, 0, 0, ctx);
    expect(expr.isVisible).toBe(true);
    expect(input.value).toBe('50');

    type(input, 'w = 50');
    pressEnter(input);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('line([0, 0], [50, 0])');
    expect(emitted[0].constraints).toEqual([
      // The auto-ortho row is inference; the typed dimension is explicit.
      { kind: 'horizontal', targets: [{ newIndex: 0 }], inferred: true },
      {
        kind: 'distance',
        targets: [{ newIndex: 0, role: 'start' }, { newIndex: 0, role: 'end' }],
        valueExpr: 'w',
      },
    ]);
    expect(emitted[0].newVariable).toEqual({ name: 'w', initializer: '50' });
    expect(committed).toHaveLength(1);
    expect(committed[0].endpoint).toEqual([50, 0]);
    expect(committed[0].exitTangent?.direction).toEqual([1, 0]);
  });

  it('hides the input again when the direction goes free', () => {
    const { ctx, expr } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleMouseMove([50, 1], SNAP, 0, 0, ctx);
    expect(expr.isVisible).toBe(true);

    mode.handleMouseMove([50, 50], SNAP, 0, 0, ctx);
    expect(expr.isVisible).toBe(false);
  });
});

describe('ALineMode', () => {
  it('snaps the angle to 15-degree multiples within tolerance', () => {
    const { ctx, input } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    mode.handleMouseMove([100, 24.93], SNAP, 0, 0, ctx); // raw ~14 degrees
    expect(input.value).toBe('15');

    mode.handleMouseMove([100, 36.4], SNAP, 0, 0, ctx); // raw ~20 degrees, outside tolerance
    expect(input.value).toBe('20');
  });

  it('measures the angle from the previous segment tangent', () => {
    const { ctx, input } = makeCtx({ tangent: { direction: [0, 1], point: [0, 0] } });
    const mode = new ALineMode();
    mode.enter(ctx);

    // Mouse along +X is -90 degrees from a +Y tangent.
    mode.handleMouseMove([100, 0], SNAP, 0, 0, ctx);
    expect(input.value).toBe('-90');
  });

  it('commits a two-stage click gesture as a line along the locked direction', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    mode.handleMouseMove([100, 24.93], SNAP, 0, 0, ctx); // snapped to 15
    const first = mode.handleClick([100, 24.93], SNAP, ctx);
    expect(first.kind).toBe('consumed');
    expect(emitted).toHaveLength(0);

    mode.handleMouseMove([9.66, 2.59], SNAP, 0, 0, ctx); // ~10 along the locked direction
    mode.handleClick([9.66, 2.59], SNAP, ctx);

    expect(emitted).toHaveLength(1);
    const end = emitted[0].text.match(/^line\(\[0, 0\], \[([\d.-]+), ([\d.-]+)\]\)$/);
    expect(end).not.toBeNull();
    expect(parseFloat(end![1])).toBeCloseTo(10 * Math.cos((15 * Math.PI) / 180), 1);
    expect(parseFloat(end![2])).toBeCloseTo(10 * Math.sin((15 * Math.PI) / 180), 1);
    // A click-committed length stays a guess — no dimension.
    expect((emitted[0].constraints ?? []).some(c => c.kind === 'distance')).toBe(false);
  });

  it('writes the angle intent as an angle constraint against a previous line', () => {
    const { ctx, emitted } = makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
      prev: { line: 7, featureType: 'line' } as SolvedEmissionTargetParam,
      prevKind: 'line',
      prevDir: [1, 0],
    });
    const mode = new ALineMode();
    mode.enter(ctx);

    // Lock 45° off the incoming +X tangent, then a length of ~10.
    expect(mode.handleClick([60, 10], SNAP, ctx).kind).toBe('consumed');
    mode.handleClick([57.07, 7.07], SNAP, ctx);

    expect(emitted).toHaveLength(1);
    const angle = (emitted[0].constraints ?? []).find(c => c.kind === 'angle');
    expect(angle).toBeDefined();
    // 45° CCW from the previous line's direction; ≤180° so target order is prev, next.
    expect(angle!.valueExpr).toBe('45');
    expect(angle!.targets).toEqual([{ line: 7, featureType: 'line' }, { newIndex: 0 }]);
  });

  it('forwards a typed length as a distance dimension with its declaration', () => {
    const { ctx, input, emitted, committed } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    mode.handleMouseMove([100, 36.4], SNAP, 0, 0, ctx);
    type(input, 'ang = 30');
    pressEnter(input);

    mode.handleMouseMove([10, 5], SNAP, 0, 0, ctx);
    type(input, 'len = 20');
    pressEnter(input);

    expect(emitted).toHaveLength(1);
    const dim = (emitted[0].constraints ?? []).find(c => c.kind === 'distance');
    expect(dim).toBeDefined();
    expect(dim!.valueExpr).toBe('len');
    expect(emitted[0].newVariable).toEqual({ name: 'len', initializer: '20' });
    expect(committed).toHaveLength(1);
    // The declared variable's value drives the drawn direction — falling
    // back to the mouse-derived angle here once made the preview disagree
    // with what the kernel builds.
    expect(committed[0].exitTangent?.direction[0]).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 3);
    expect(committed[0].exitTangent?.direction[1]).toBeCloseTo(Math.sin((30 * Math.PI) / 180), 3);
  });

  it('resolves an expression angle for the locked direction', () => {
    // Regression: parseFloat('(-45)') is NaN, and the old fallback silently
    // locked the mouse-derived angle instead — the preview and endpoint math
    // then drew along a direction the kernel never builds.
    const { ctx, input, emitted, committed } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    mode.handleMouseMove([100, 0], SNAP, 0, 0, ctx); // mouse says 0 degrees
    type(input, '(-45)');
    pressEnter(input);

    mode.handleMouseMove([10, -10], SNAP, 0, 0, ctx);
    type(input, '10');
    pressEnter(input);

    expect(emitted).toHaveLength(1);
    expect(committed[0].exitTangent?.direction[0]).toBeCloseTo(Math.cos(-Math.PI / 4), 3);
    expect(committed[0].exitTangent?.direction[1]).toBeCloseTo(Math.sin(-Math.PI / 4), 3);
  });

  it('ignores a zero-length second click', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    // No mouse move, so no expression input: the click locks the angle directly.
    expect(mode.handleClick([10, 0], SNAP, ctx).kind).toBe('consumed');
    expect(mode.handleClick([0, 0], SNAP, ctx).kind).toBe('ignored');
    // Points behind the start project to a clamped zero length.
    expect(mode.handleClick([-5, 0], SNAP, ctx).kind).toBe('ignored');
    expect(emitted).toHaveLength(0);
  });

  it('Escape backs out from length to angle, then reports unhandled', () => {
    const { ctx } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    expect(mode.handleClick([10, 0], SNAP, ctx).kind).toBe('consumed');
    expect(mode.handleEscape(ctx)).toBe(true);   // length -> angle
    expect(mode.handleEscape(ctx)).toBe(false);  // angle stage, no input showing
  });
});

describe('TArcMode', () => {
  it('emits a fully-specified arc for the solved tangent gesture', () => {
    // Chain at (50, 0) heading +X; endpoint (80, 30) solves to radius 30
    // around center (50, 30), CCW.
    const { ctx, emitted } = makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
      prev: { line: 4, featureType: 'line' } as SolvedEmissionTargetParam,
      prevKind: 'line',
      prevDir: [1, 0],
    });
    const mode = new TArcMode();
    mode.enter(ctx);

    const result = mode.handleClick([80, 30], SNAP, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('arc([50, 0], [80, 30], [50, 30])');
    expect(emitted[0].constraints).toEqual([
      { kind: 'tangent', targets: [{ line: 4, featureType: 'line' }, { newIndex: 0 }] },
    ]);
    expect(result.kind).toBe('committed');
    if (result.kind === 'committed') {
      expect(result.result.endpoint[0]).toBeCloseTo(80, 9);
      expect(result.result.endpoint[1]).toBeCloseTo(30, 9);
      // End tangent at (80, 30) around center (50, 30), CCW: straight up.
      expect(result.result.exitTangent?.direction[0]).toBeCloseTo(0);
      expect(result.result.exitTangent?.direction[1]).toBeCloseTo(1);
    }
  });

  it('continues the chain from the exact end the kernel will build', () => {
    // An awkward click whose solved radius rounds: the committed endpoint
    // must land on the written-radius circle, and the returned chain
    // position must be that endpoint's exact re-projection — not the click.
    const { ctx, emitted } = makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
    });
    const mode = new TArcMode();
    mode.enter(ctx);

    const result = mode.handleClick([81.234, 27.891], SNAP, ctx);

    expect(result.kind).toBe('committed');
    const match = emitted[0].text.match(/^arc\(\[50, 0\], \[([\d.-]+), ([\d.-]+)\], \[([\d.-]+), ([\d.-]+)\]\)/);
    expect(match).not.toBeNull();
    const center: Point2D = [parseFloat(match![3]), parseFloat(match![4])];
    const radius = Math.hypot(50 - center[0], 0 - center[1]);
    if (result.kind === 'committed') {
      // The chain continues on the written circle, tangent to the incoming
      // direction (center on the perpendicular at the start).
      const [ex, ey] = result.result.endpoint;
      expect(Math.hypot(ex - center[0], ey - center[1])).toBeCloseTo(radius, 9);
      // And within statement-rounding distance of the written endpoint.
      expect(Math.hypot(ex - parseFloat(match![1]), ey - parseFloat(match![2]))).toBeLessThan(0.02);
    }
  });

  it('ignores a click collinear with the tangent', () => {
    const { ctx, emitted } = makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
    });
    const mode = new TArcMode();
    mode.enter(ctx);

    const result = mode.handleClick([90, 0], SNAP, ctx);

    expect(emitted).toEqual([]);
    expect(result.kind).toBe('ignored');
  });
});

describe('ArcMode explicit start', () => {
  it('spends a pending typed start as the arc start', () => {
    const { ctx, emitted } = makeCtx({ pendingStartText: '[p, q]' });
    const mode = new ArcMode();
    mode.enter(ctx);

    expect(mode.handleClick([10, 0], SNAP, ctx).kind).toBe('consumed'); // end point
    mode.handleClick([5, -5], SNAP, ctx);                               // through point

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('arc([p, q], [10, 0], [5, 0])');
  });
});

describe('PolylineTool typed chain start', () => {
  function makeBareTool() {
    const tool: any = Object.create(PolylineTool.prototype);
    tool.phase = PolylinePhase.IDLE;
    tool.startPoint = null;
    tool.tangent = null;
    tool.pendingStart = null;
    tool.solvedPrev = null;
    tool.solvedStartRef = null;
    tool.solvedCtx = {
      emit: async () => ({ success: true }),
      autoConstraints: () => true,
    };
    tool.modes = [new LineMode()];
    tool.currentModeIndex = 0;
    tool.modeIndicator = { update: () => {}, setHint: () => {} };
    tool.sceneObjects = [];
    tool.sketchId = 's';
    tool.ctx = { camera: {} };
    tool.plane = PLANE;
    tool.previewGroup = {};
    tool.expressionInput = { hide: () => {}, get isVisible() { return false; } };
    tool.pointInput = { handleEscape: () => false };
    tool.syncPointInput = () => {};
    tool.rebuildPreview = () => {};
    return { tool };
  }

  it('defers an absolute typed start onto the first segment', () => {
    const { tool } = makeBareTool();

    tool.beginChainAt({
      value: [5, 10],
      xExpr: 'w / 2',
      yExpr: '10',
      newVariables: [{ name: 'w', initializer: '10' }],
      typed: true,
    });

    // Nothing written yet, and tangent modes are off.
    expect(tool.phase).toBe(PolylinePhase.DRAWING);
    expect(tool.tangent).toBeNull();

    // Modes see the typed address through the context.
    const ctx = tool.buildModeContext();
    expect(ctx.pendingStartText()).toBe('[w / 2, 10]');
  });

  it('drops an unspent typed start when Escape ends the chain', () => {
    const { tool } = makeBareTool();

    tool.beginChainAt({
      value: [5, 10],
      xExpr: '5',
      yExpr: '10',
      newVariables: [],
      typed: true,
    });
    expect(tool.pendingStart).not.toBeNull();

    expect(tool.handleEscape()).toBe(true);
    expect(tool.phase).toBe(PolylinePhase.IDLE);
    expect(tool.pendingStart).toBeNull();
  });
});

describe('PolylineTool Escape delegation', () => {
  function makeTool(modes: any[]) {
    const { ctx } = makeCtx();
    const tool: any = Object.create(PolylineTool.prototype);
    tool.modes = modes;
    tool.currentModeIndex = 0;
    tool.phase = PolylinePhase.DRAWING;
    tool.startPoint = [0, 0];
    tool.tangent = null;
    tool.pendingStart = null;
    tool.solvedPrev = null;
    tool.solvedStartRef = null;
    tool.expressionInput = { hide: () => {} };
    // The coordinate pill declines a clean Escape, so the chain-ending path
    // below is reached exactly as it is with a real one.
    tool.pointInput = { handleEscape: () => false };
    tool.buildModeContext = () => (tool.startPoint ? ctx : null);
    tool.rebuildPreview = () => {};
    return { tool, ctx };
  }

  it('delegates to the mode, then ends the chain, then disarms', () => {
    const arc = new ArcMode();
    const { tool, ctx } = makeTool([arc]);
    arc.enter(ctx);
    expect(arc.handleClick([10, 0], SNAP, ctx).kind).toBe('consumed'); // awaiting through-point

    expect(tool.handleEscape()).toBe(true); // arc backs out to awaiting-end
    expect(tool.phase).toBe(PolylinePhase.DRAWING);

    expect(tool.handleEscape()).toBe(true); // chain ends, tool stays armed
    expect(tool.phase).toBe(PolylinePhase.IDLE);
    expect(tool.startPoint).toBeNull();
    expect(tool.tangent).toBeNull();

    expect(tool.handleEscape()).toBe(false); // idle: toolbar disarms the tool
  });
});

describe('LineMode end-snap provenance', () => {
  const VERTEX_SNAP = {
    snapType: 'vertex',
    point2d: [40.003, 0.001] as Point2D,
    ref: { line: 12, role: 'end', featureType: 'line' },
  } as unknown as SnapResult;

  it('free-direction click carries the snap through to the spec', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([30, 40], VERTEX_SNAP, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].endSnap).toBe(VERTEX_SNAP);
  });

  it('the H/V pill commit click keeps the snap provenance too', () => {
    const { ctx, emitted, expr } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    // A near-horizontal hover shows the H: pill, which then claims the click.
    mode.handleMouseMove([40.003, 0.001], VERTEX_SNAP, 0, 0, ctx);
    expect(expr.isVisible).toBe(true);
    mode.handleClick([40.003, 0.001], VERTEX_SNAP, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('line([0, 0], [40, 0])');
    expect(emitted[0].endSnap).toBe(VERTEX_SNAP);
    expect(emitted[0].endPoint).toEqual([40, 0]);
  });
});

describe('PolylineTool end-snap coincident', () => {
  function makeEmitTool(emitted: any[]) {
    const tool: any = Object.create(PolylineTool.prototype);
    tool.phase = PolylinePhase.DRAWING;
    tool.startPoint = [0, 0];
    tool.pendingStart = null;
    tool.solvedPrev = null;
    tool.solvedStartRef = null;
    tool.solvedEmitChain = Promise.resolve();
    tool.solvedEmitsPending = 0;
    tool.ctrlHeld = false;
    tool.solvedCtx = {
      emit: async (request: any) => {
        emitted.push(request);
        return { success: true, geometryLines: [20] };
      },
      autoConstraints: () => true,
    };
    return tool;
  }

  it('keeps the end coincident when the snapped vertex is off the 2dp grid', async () => {
    const emitted: any[] = [];
    const tool = makeEmitTool(emitted);

    tool.emitSolvedSegment({
      kind: 'line',
      text: 'line([0, 0], [40, 0])',
      endSnap: {
        snapType: 'vertex',
        point2d: [40.003, 0.001],
        ref: { line: 12, role: 'end', featureType: 'line' },
      },
      endPoint: [40, 0],
    });
    await tool.solvedEmitChain;

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [
        { newIndex: 0, role: 'end' },
        { line: 12, role: 'end', featureType: 'line' },
      ],
      inferred: true,
    });
  });

  it('still drops the coincident when a quantization moved the endpoint off the vertex', async () => {
    const emitted: any[] = [];
    const tool = makeEmitTool(emitted);

    tool.emitSolvedSegment({
      kind: 'line',
      text: 'line([0, 0], [40, 0])',
      endSnap: {
        snapType: 'vertex',
        point2d: [40, 1.5],
        ref: { line: 12, role: 'end', featureType: 'line' },
      },
      endPoint: [40, 0],
    });
    await tool.solvedEmitChain;

    expect(emitted).toHaveLength(1);
    expect(emitted[0].constraints.filter((c: any) => c.kind === 'coincident')).toHaveLength(0);
  });
});

describe('PolylineTool axis-datum end snaps', () => {
  function makeEmitTool(emitted: any[]) {
    const tool: any = Object.create(PolylineTool.prototype);
    tool.phase = PolylinePhase.DRAWING;
    tool.startPoint = [0, 0];
    tool.pendingStart = null;
    tool.solvedPrev = null;
    tool.solvedStartRef = null;
    tool.solvedEmitChain = Promise.resolve();
    tool.solvedEmitsPending = 0;
    tool.ctrlHeld = false;
    tool.solvedCtx = {
      emit: async (request: any) => {
        emitted.push(request);
        return { success: true, geometryLines: [20] };
      },
      autoConstraints: () => true,
    };
    return tool;
  }

  it('chain start and end both on the x axis get two inferred coincidents; the H rides through for the trial', async () => {
    const emitted: any[] = [];
    const tool = makeEmitTool(emitted);
    tool.solvedStartRef = { datum: 'x-axis' };

    tool.emitSolvedSegment({
      kind: 'line',
      text: 'line([0, 0], [40, 0])',
      constraints: [{ kind: 'horizontal', targets: [{ newIndex: 0 }] }],
      endSnap: { snapType: 'vertex', point2d: [40, 0], ref: { datum: 'x-axis' } },
      endPoint: [40, 0],
    });
    await tool.solvedEmitChain;

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
    // The tool passes the mode's H through untouched — the emission rail's
    // redundancy trial (emission-redundancy) is where it gets dropped.
    expect(emitted[0].constraints).toContainEqual({ kind: 'horizontal', targets: [{ newIndex: 0 }] });
  });
});
