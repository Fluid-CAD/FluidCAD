// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LineMode } from '../src/interactive/tools/polyline/mode-line';
import { ALineMode } from '../src/interactive/tools/polyline/mode-aline';
import { ArcMode } from '../src/interactive/tools/polyline/mode-arc';
import { PolylineTool } from '../src/interactive/tools/polyline/polyline-tool';
import { PolylinePhase } from '../src/interactive/tools/polyline/types';
import type { ModeContext, Point2D, SegmentCommitResult } from '../src/interactive/tools/polyline/types';
import { ExpressionInput } from '../src/ui/expression-input';
import type { SnapResult } from '../src/snapping/types';

Element.prototype.scrollIntoView = () => {};

type Inserted = { statement: string; newVariable?: unknown };

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
  atCurrent?: boolean;
  orthoOverride?: boolean;
};

// Drives a segment mode against a plain-object ModeContext backed by a real
// ExpressionInput, bypassing the tool/canvas/scene entirely.
function makeCtx(opts: CtxOptions = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const expr = new ExpressionInput(container);
  const inserted: Inserted[] = [];
  const committed: SegmentCommitResult[] = [];

  const state = {
    atCurrent: opts.atCurrent ?? true,
    orthoOverride: opts.orthoOverride ?? false,
  };

  const ctx = {
    plane: {},
    previewGroup: {},
    camera: {},
    planeNormal: {},
    tangent: opts.tangent ?? null,
    sceneObjects: [],
    sketchId: 'sketch',
    startPoint: opts.startPoint ?? [0, 0],
    isAtCurrentPosition: () => state.atCurrent,
    formatPoint: (p: Point2D) => `[${p[0]}, ${p[1]}]`,
    insertGeometry: (statement: string, newVariable?: unknown) => {
      inserted.push({ statement, newVariable });
    },
    requestRender: () => {},
    isOrthoOverride: () => state.orthoOverride,
    showExpressionInput: (o: any) => {
      if (!expr.isVisible) {
        expr.show({ ...o, variables: [] });
      }
    },
    updateExpressionValue: (v: number) => expr.updateValue(v),
    updateExpressionPosition: () => {},
    hideExpressionInput: () => expr.hide(),
    isExpressionVisible: () => expr.isVisible,
    commitExpressionValue: () => expr.commitCurrentValue(),
    onSegmentCommitted: (r: SegmentCommitResult) => committed.push(r),
  } as unknown as ModeContext;

  const input = container.querySelector('.expression-input') as HTMLInputElement;
  return { ctx, expr, input, inserted, committed, state };
}

describe('LineMode H/V auto-snap', () => {
  it('emits a free line for a clearly diagonal click', () => {
    const { ctx, inserted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    const result = mode.handleClick([30, 40], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'line([30, 40])', newVariable: undefined }]);
    expect(result.kind).toBe('committed');
    if (result.kind === 'committed') {
      expect(result.result.endpoint).toEqual([30, 40]);
      expect(result.result.exitTangent?.direction[0]).toBeCloseTo(0.6);
      expect(result.result.exitTangent?.direction[1]).toBeCloseTo(0.8);
    }
  });

  it('snaps a 4.9-degree click to hLine', () => {
    const { ctx, inserted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    const result = mode.handleClick([100, 8.57], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'hLine(100)', newVariable: undefined }]);
    expect(result.kind).toBe('committed');
    if (result.kind === 'committed') {
      expect(result.result.endpoint).toEqual([100, 0]);
      expect(result.result.exitTangent?.direction).toEqual([1, 0]);
    }
  });

  it('keeps a 5.1-degree click as a free line', () => {
    const { ctx, inserted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([100, 8.93], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'line([100, 8.93])', newVariable: undefined }]);
  });

  it('snaps a near-vertical click to vLine with the signed distance', () => {
    const { ctx, inserted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    const result = mode.handleClick([1, -50], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'vLine(-50)', newVariable: undefined }]);
    if (result.kind === 'committed') {
      expect(result.result.endpoint).toEqual([0, -50]);
      expect(result.result.exitTangent?.direction).toEqual([0, -1]);
    }
  });

  it('Ctrl override forces a free line on an axial click', () => {
    const { ctx, inserted } = makeCtx({ orthoOverride: true });
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([100, 0], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'line([100, 0])', newVariable: undefined }]);
  });

  it('uses the explicit-start form when away from the current position', () => {
    const { ctx, inserted } = makeCtx({ startPoint: [10, 20], atCurrent: false });
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleClick([60, 20], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'hLine([10, 20], 50)', newVariable: undefined }]);
  });

  it('keeps the legacy free emission for a zero-delta click', () => {
    const { ctx, inserted } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    const result = mode.handleClick([0, 0], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'line([0, 0])', newVariable: undefined }]);
    if (result.kind === 'committed') {
      expect(result.result.exitTangent).toBeNull();
    }
  });

  it('shows the H: input while snapped and a typed commit carries the variable', () => {
    const { ctx, expr, input, inserted, committed } = makeCtx();
    const mode = new LineMode();
    mode.enter(ctx);

    mode.handleMouseMove([50, 1], SNAP, 0, 0, ctx);
    expect(expr.isVisible).toBe(true);
    expect(input.value).toBe('50');

    type(input, 'w = 50');
    pressEnter(input);

    expect(inserted).toEqual([{ statement: 'hLine(w)', newVariable: { name: 'w', initializer: '50' } }]);
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
  it('is unavailable away from the current position', () => {
    const { ctx } = makeCtx({ atCurrent: false });
    const mode = new ALineMode();
    expect(mode.isAvailable(ctx)).toBe(false);
  });

  it('is available at the current position', () => {
    const { ctx } = makeCtx();
    const mode = new ALineMode();
    expect(mode.isAvailable(ctx)).toBe(true);
  });

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

  it('commits a two-stage click gesture as aLine(angle, length)', () => {
    const { ctx, inserted } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    mode.handleMouseMove([100, 24.93], SNAP, 0, 0, ctx); // snapped to 15
    const first = mode.handleClick([100, 24.93], SNAP, ctx);
    expect(first.kind).toBe('consumed');
    expect(inserted).toHaveLength(0);

    mode.handleMouseMove([9.66, 2.59], SNAP, 0, 0, ctx); // ~10 along the locked direction
    const second = mode.handleClick([9.66, 2.59], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'aLine(15, 10)', newVariable: undefined }]);
    expect(second.kind).toBe('ignored'); // click routed through the expression commit
  });

  it('forwards typed expressions from both stages with the variables as an array', () => {
    const { ctx, input, inserted, committed } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    mode.handleMouseMove([100, 36.4], SNAP, 0, 0, ctx);
    type(input, 'ang = 30');
    pressEnter(input);

    mode.handleMouseMove([10, 5], SNAP, 0, 0, ctx);
    type(input, 'len = 20');
    pressEnter(input);

    expect(inserted).toEqual([{
      statement: 'aLine(ang, len)',
      newVariable: [
        { name: 'ang', initializer: '30' },
        { name: 'len', initializer: '20' },
      ],
    }]);
    expect(committed).toHaveLength(1);
    // The numeric preview fallback for a variable angle is the mouse-derived
    // angle (20 degrees here), not the variable's initializer.
    expect(committed[0].exitTangent?.direction[0]).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3);
    expect(committed[0].exitTangent?.direction[1]).toBeCloseTo(Math.sin((20 * Math.PI) / 180), 3);
  });

  it('ignores a zero-length second click', () => {
    const { ctx, inserted } = makeCtx();
    const mode = new ALineMode();
    mode.enter(ctx);

    // No mouse move, so no expression input: the click locks the angle directly.
    expect(mode.handleClick([10, 0], SNAP, ctx).kind).toBe('consumed');
    expect(mode.handleClick([0, 0], SNAP, ctx).kind).toBe('ignored');
    // Points behind the start project to a clamped zero length.
    expect(mode.handleClick([-5, 0], SNAP, ctx).kind).toBe('ignored');
    expect(inserted).toHaveLength(0);
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

describe('PolylineTool Escape delegation', () => {
  function makeTool(modes: any[]) {
    const { ctx } = makeCtx();
    const tool: any = Object.create(PolylineTool.prototype);
    tool.modes = modes;
    tool.currentModeIndex = 0;
    tool.phase = PolylinePhase.DRAWING;
    tool.startPoint = [0, 0];
    tool.tangent = null;
    tool.expressionInput = { hide: () => {} };
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
