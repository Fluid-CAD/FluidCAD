// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { RectTool } from '../src/interactive/tools/rect-tool';
import { RoundedRectTool } from '../src/interactive/tools/rounded-rect-tool';

// Centered rect / rounded rect auto-constraints: the anchor click lands on
// the shape's CENTRE, which no vertex sits on, so a snapped anchor used to
// emit nothing and the "centered" intent was lost the moment the sketch
// re-solved. The gesture now pins the snapped vertex as the midpoint of a
// diagonal vertex pair (corner-arc centres for the rounded rect).

type Emitted = { geometry: { kind: string; text: string }[]; constraints: any[] };

function solvedCtx(emitted: Emitted[]): any {
  return {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => true,
  };
}

/** A RectTool at the state the anchor click leaves, bypassing canvas/scene. */
function makeRectTool(emitted: Emitted[], centered: boolean): any {
  const tool: any = Object.create(RectTool.prototype);
  tool.solvedCtx = solvedCtx(emitted);
  tool.centered = centered;
  tool.cachedVariables = [];
  tool.expressionInput = { hide: () => {}, isTyping: false, isVisible: false };
  tool.startPick = { value: [10, 5], xExpr: '10', yExpr: '5', newVariables: [], typed: false };
  tool.startPoint = [10, 5];
  tool.startSnapRef = null;
  tool.lastSnap = null;
  tool.widthTyped = false;
  tool.heightTyped = false;
  tool.rebuildPreview = () => {};
  return tool;
}

function makeRoundedRectTool(emitted: Emitted[], centered: boolean): any {
  const tool: any = Object.create(RoundedRectTool.prototype);
  tool.solvedCtx = solvedCtx(emitted);
  tool.centered = centered;
  tool.cachedVariables = [];
  tool.expressionInput = { hide: () => {}, isTyping: false, isVisible: false };
  tool.startPick = { value: [10, 5], xExpr: '10', yExpr: '5', newVariables: [], typed: false };
  tool.startPoint = [10, 5];
  tool.startSnapRef = null;
  tool.widthTyped = false;
  tool.heightTyped = false;
  tool.rebuildPreview = () => {};
  return tool;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const midpoints = (e: Emitted) => e.constraints.filter((c: any) => c.kind === 'midpoint');
const snapCoincidents = (e: Emitted) => e.constraints.filter(
  (c: any) => c.kind === 'coincident' && c.targets.some((t: any) => t.line !== undefined || t.datum !== undefined),
);

describe('centered rect tool snap', () => {
  it('a snapped centre pins the diagonal midpoint onto the vertex', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRectTool(emitted, true);
    tool.startSnapRef = { line: 7, role: 'end', featureType: 'line' };

    tool.commitRect(tool.startPick, { expression: '40' }, { expression: '30' });
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    // The centre is the anchor; the emitted corner is centre − half-extent.
    expect(emitted[0].geometry[0].text).toBe('line([-10, -10], [30, -10])');
    expect(midpoints(emitted[0])).toEqual([{
      kind: 'midpoint',
      targets: [
        { line: 7, role: 'end', featureType: 'line' },
        { newIndex: 0, role: 'start' },
        { newIndex: 2, role: 'start' },
      ],
      inferred: true,
    }]);
    // No corner pretends to sit on the centre.
    expect(snapCoincidents(emitted[0])).toHaveLength(0);
  });

  it('the origin datum pins the centre the same way', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRectTool(emitted, true);
    tool.startSnapRef = { datum: 'origin' };

    tool.commitRect(tool.startPick, { expression: '40' }, { expression: '30' });
    await flushMicrotasks();

    expect(midpoints(emitted[0])).toEqual([{
      kind: 'midpoint',
      targets: [{ datum: 'origin' }, { newIndex: 0, role: 'start' }, { newIndex: 2, role: 'start' }],
      inferred: true,
    }]);
  });

  it('an axis-datum centre snap has no point-pair form and emits nothing', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRectTool(emitted, true);
    tool.startSnapRef = { datum: 'x-axis' };

    tool.commitRect(tool.startPick, { expression: '40' }, { expression: '30' });
    await flushMicrotasks();

    expect(midpoints(emitted[0])).toHaveLength(0);
    expect(snapCoincidents(emitted[0])).toHaveLength(0);
  });

  it('the size click still pins the opposite corner alongside the centre', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRectTool(emitted, true);
    tool.startSnapRef = { datum: 'origin' };
    // p2 = centre + half-extent = (30, 20).
    tool.lastSnap = {
      snapType: 'vertex',
      point2d: [30.002, 19.999],
      ref: { line: 9, role: 'center', featureType: 'circle' },
    };

    tool.commitRect(tool.startPick, { expression: '40' }, { expression: '30' });
    await flushMicrotasks();

    expect(midpoints(emitted[0])).toHaveLength(1);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 2, role: 'start' }, { line: 9, role: 'center', featureType: 'circle' }],
      inferred: true,
    });
  });

  it('the non-centered anchor keeps its corner coincident, no midpoint', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRectTool(emitted, false);
    tool.startSnapRef = { line: 7, role: 'end', featureType: 'line' };

    tool.commitRect(tool.startPick, { expression: '40' }, { expression: '30' });
    await flushMicrotasks();

    expect(midpoints(emitted[0])).toHaveLength(0);
    expect(emitted[0].constraints).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'start' }, { line: 7, role: 'end', featureType: 'line' }],
      inferred: true,
    });
  });

  it('the Auto-constraints toggle suppresses the midpoint pin', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRectTool(emitted, true);
    tool.solvedCtx.autoConstraints = () => false;
    tool.startSnapRef = { line: 7, role: 'end', featureType: 'line' };

    tool.commitRect(tool.startPick, { expression: '40' }, { expression: '30' });
    await flushMicrotasks();

    expect(midpoints(emitted[0])).toHaveLength(0);
  });
});

describe('centered rounded rect tool snap', () => {
  it('a snapped centre pins the midpoint of two diagonal corner-arc centres', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRoundedRectTool(emitted, true);
    tool.startSnapRef = { datum: 'origin' };

    tool.commitRoundedRect(
      tool.startPick, { expression: '40' }, { expression: '30' }, { expression: '5' },
    );
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    // Arcs 7 and 3 are the xMin/yMin and xMax/yMax corners.
    expect(emitted[0].geometry[7].text).toBe('arc([-10, -5], [-5, -10], [-5, -5])');
    expect(emitted[0].geometry[3].text).toBe('arc([30, 15], [25, 20], [25, 15])');
    expect(midpoints(emitted[0])).toEqual([{
      kind: 'midpoint',
      targets: [{ datum: 'origin' }, { newIndex: 7, role: 'center' }, { newIndex: 3, role: 'center' }],
      inferred: true,
    }]);
  });

  it('the Auto-constraints toggle suppresses the midpoint pin', async () => {
    const emitted: Emitted[] = [];
    const tool = makeRoundedRectTool(emitted, true);
    tool.solvedCtx.autoConstraints = () => false;
    tool.startSnapRef = { datum: 'origin' };

    tool.commitRoundedRect(
      tool.startPick, { expression: '40' }, { expression: '30' }, { expression: '5' },
    );
    await flushMicrotasks();

    expect(midpoints(emitted[0])).toHaveLength(0);
  });
});
