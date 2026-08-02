// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyTarcToEdge } from '../src/api';
import { LineMode } from '../src/interactive/tools/polyline/mode-line';
import { ALineMode } from '../src/interactive/tools/polyline/mode-aline';
import { ArcMode } from '../src/interactive/tools/polyline/mode-arc';
import { TArcMode } from '../src/interactive/tools/polyline/mode-tarc';
import { PolylineTool } from '../src/interactive/tools/polyline/polyline-tool';
import { PolylinePhase } from '../src/interactive/tools/polyline/types';
import type { ModeContext, Point2D, SegmentCommitResult } from '../src/interactive/tools/polyline/types';
import { ExpressionInput } from '../src/ui/expression-input';
import type { SnapResult } from '../src/snapping/types';

Element.prototype.scrollIntoView = () => {};

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyTarcToEdge: vi.fn(async () => ({ success: true })),
}));

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
  sceneObjects?: unknown[];
};

// The XY plane in scene-payload shape, enough for the 2D edge index.
const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

// Drives a segment mode against a plain-object ModeContext backed by a real
// ExpressionInput, bypassing the tool/canvas/scene entirely.
function makeCtx(opts: CtxOptions = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const expr = new ExpressionInput(container);
  const inserted: Inserted[] = [];
  const committed: SegmentCommitResult[] = [];
  const hints: (string | null)[] = [];

  const state = {
    atCurrent: opts.atCurrent ?? true,
    orthoOverride: opts.orthoOverride ?? false,
  };

  const ctx = {
    plane: PLANE,
    previewGroup: {},
    camera: {},
    planeNormal: {},
    tangent: opts.tangent ?? null,
    sceneObjects: opts.sceneObjects ?? [],
    sketchId: 'sketch',
    startPoint: opts.startPoint ?? [0, 0],
    isAtCurrentPosition: () => state.atCurrent,
    pixelThreshold: (px: number) => px,
    setSnapHint: (hint: string | null) => hints.push(hint),
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
  return { ctx, expr, input, inserted, committed, hints, state };
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

describe('TArcMode', () => {
  it('emits the radius + endpoint overload with the solved radius', () => {
    // Chain at (50, 0) heading +X; endpoint (80, 30) solves to radius 30.
    const { ctx, inserted } = makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
    });
    const mode = new TArcMode();
    mode.enter(ctx);

    const result = mode.handleClick([80, 30], SNAP, ctx);

    expect(inserted).toEqual([{ statement: 'tArc(30, [80, 30])', newVariable: undefined }]);
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
    const { ctx, inserted } = makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
    });
    const mode = new TArcMode();
    mode.enter(ctx);

    const result = mode.handleClick([81.234, 27.891], SNAP, ctx);

    expect(result.kind).toBe('committed');
    const match = inserted[0].statement.match(/^tArc\(([\d.]+), \[([\d.-]+), ([\d.-]+)\]\)$/);
    expect(match).not.toBeNull();
    const radius = parseFloat(match![1]);
    if (result.kind === 'committed') {
      // The chain continues on the circle of the written radius, tangent to
      // the incoming direction (center on the perpendicular at the start).
      const [ex, ey] = result.result.endpoint;
      const centerDist = Math.hypot(ex - 50, ey - radius);
      expect(centerDist).toBeCloseTo(radius, 9);
      // And within statement-rounding distance of the written endpoint.
      expect(Math.hypot(ex - parseFloat(match![2]), ey - parseFloat(match![3]))).toBeLessThan(0.02);
    }
  });

  it('ignores a click collinear with the tangent', () => {
    const { ctx, inserted } = makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
    });
    const mode = new TArcMode();
    mode.enter(ctx);

    const result = mode.handleClick([90, 0], SNAP, ctx);

    expect(inserted).toEqual([]);
    expect(result.kind).toBe('ignored');
  });
});

describe('TArcMode edge snap', () => {
  beforeEach(() => {
    vi.mocked(applyTarcToEdge).mockClear();
  });

  /** A single-edge sketch object (one real edge shape) for the edge index. */
  function edgeObj(shapeId: string, a: Point2D, b: Point2D, uniqueType = 'line-two-points') {
    return {
      parentId: 'sketch',
      uniqueType,
      sourceLocation: { filePath: 'f.fluid.js', line: 3, column: 0 },
      sceneShapes: [{
        shapeId,
        meshes: [{ vertices: [a[0], a[1], 0, b[0], b[1], 0], indices: [0, 1] }],
      }],
    };
  }

  function makeSnapCtx(sceneObjects: unknown[]) {
    return makeCtx({
      startPoint: [50, 0],
      tangent: { direction: [1, 0], point: [50, 0] },
      sceneObjects,
    });
  }

  it('snaps to a hovered edge and commits the radius + target overload', async () => {
    // Chain at (50, 0) heading +X; a vertical line at x=80. Hovering near
    // (80, 30) projects onto the line and solves radius 30, CCW.
    const { ctx, committed, hints } = makeSnapCtx([edgeObj('t1', [80, -50], [80, 50])]);
    const mode = new TArcMode();
    mode.enter(ctx);

    mode.handleMouseMove([79.5, 30], SNAP, 0, 0, ctx);
    expect(hints[hints.length - 1]).toBe('Tangent arc up to intersection');

    const result = mode.handleClick([79.5, 30], SNAP, ctx);
    expect(result.kind).toBe('consumed');
    expect(applyTarcToEdge).toHaveBeenCalledWith(30, 't1');

    await vi.waitFor(() => expect(committed).toHaveLength(1));
    expect(committed[0].endpoint[0]).toBeCloseTo(80);
    expect(committed[0].endpoint[1]).toBeCloseTo(30);
    // Exit tangent at (80, 30) around center (50, 30), CCW: straight up.
    expect(committed[0].exitTangent?.direction[0]).toBeCloseTo(0);
    expect(committed[0].exitTangent?.direction[1]).toBeCloseTo(1);
  });

  it('writes a negative radius for a clockwise sweep', () => {
    const { ctx } = makeSnapCtx([edgeObj('t1', [80, -50], [80, 50])]);
    const mode = new TArcMode();
    mode.enter(ctx);

    mode.handleMouseMove([79.5, -30], SNAP, 0, 0, ctx);
    mode.handleClick([79.5, -30], SNAP, ctx);

    expect(applyTarcToEdge).toHaveBeenCalledWith(-30, 't1');
  });

  it('snaps to guide edges too', () => {
    const guide = {
      parentId: 'sketch',
      uniqueType: 'line-two-points',
      sourceLocation: { filePath: 'f.fluid.js', line: 3, column: 0 },
      sceneShapes: [{
        shapeId: 'g1',
        isGuide: true,
        meshes: [{ vertices: [80, -50, 0, 80, 50, 0], indices: [0, 1] }],
      }],
    };
    const { ctx, hints } = makeSnapCtx([guide]);
    const mode = new TArcMode();
    mode.enter(ctx);

    mode.handleMouseMove([79.5, 30], SNAP, 0, 0, ctx);
    expect(hints[hints.length - 1]).toBe('Tangent arc up to intersection');
    mode.handleClick([79.5, 30], SNAP, ctx);

    expect(applyTarcToEdge).toHaveBeenCalledWith(30, 'g1');
  });

  it('never snaps to the edge the chain leaves from', () => {
    // The previous segment ends at the chain start — hovering over it must
    // not offer the intersection snap.
    const { ctx, hints } = makeSnapCtx([edgeObj('prev', [0, 0], [50, 0])]);
    const mode = new TArcMode();
    mode.enter(ctx);

    mode.handleMouseMove([40, 0.4], SNAP, 0, 0, ctx);
    mode.handleClick([40, 0.4], SNAP, ctx);

    expect(hints.filter((h) => h !== null)).toHaveLength(0);
    expect(applyTarcToEdge).not.toHaveBeenCalled();
  });

  it('ignores multi-edge owners (the kernel targets the first shape only)', () => {
    const rectish = {
      parentId: 'sketch',
      uniqueType: 'rect',
      sourceLocation: { filePath: 'f.fluid.js', line: 3, column: 0 },
      sceneShapes: [
        { shapeId: 'r1', meshes: [{ vertices: [80, -50, 0, 80, 50, 0], indices: [0, 1] }] },
        { shapeId: 'r2', meshes: [{ vertices: [80, 50, 0, 120, 50, 0], indices: [0, 1] }] },
      ],
    };
    const { ctx, hints } = makeSnapCtx([rectish]);
    const mode = new TArcMode();
    mode.enter(ctx);

    mode.handleMouseMove([79.5, 30], SNAP, 0, 0, ctx);
    mode.handleClick([79.5, 30], SNAP, ctx);

    expect(hints.filter((h) => h !== null)).toHaveLength(0);
    expect(applyTarcToEdge).not.toHaveBeenCalled();
  });

  it('falls back to the endpoint overload when the server refuses', async () => {
    vi.mocked(applyTarcToEdge).mockResolvedValueOnce({ success: false, reason: 'clone' });
    const { ctx, inserted, committed } = makeSnapCtx([edgeObj('t1', [80, -50], [80, 50])]);
    const mode = new TArcMode();
    mode.enter(ctx);

    mode.handleMouseMove([79.5, 30], SNAP, 0, 0, ctx);
    mode.handleClick([79.5, 30], SNAP, ctx);

    await vi.waitFor(() => expect(committed).toHaveLength(1));
    expect(inserted).toEqual([{ statement: 'tArc(30, [80, 30])', newVariable: undefined }]);
    expect(committed[0].endpoint[0]).toBeCloseTo(80);
    expect(committed[0].endpoint[1]).toBeCloseTo(30);
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
