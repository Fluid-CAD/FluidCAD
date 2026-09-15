// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EllipseTool } from '../src/interactive/tools/ellipse-tool';

// The Ellipse tool emits `ellipse(center, rx, ry)` through the solved rail.
// The centre is the only solver entity an ellipse registers, so a snapped
// centre becomes a coincident on `newTarget(0, 'center')`; the radii are
// literals (or typed expressions) and never a dimension row.

type Emitted = { geometry: { kind: string; text: string }[]; constraints: any[]; newVariables?: any[] };

function solvedCtx(emitted: Emitted[], autoConstraints = true): any {
  return {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => autoConstraints,
  };
}

/** An EllipseTool at the state the centre click leaves, bypassing canvas/scene. */
function makeTool(emitted: Emitted[], autoConstraints = true): any {
  const tool: any = Object.create(EllipseTool.prototype);
  tool.solvedCtx = solvedCtx(emitted, autoConstraints);
  tool.cachedVariables = [];
  tool.expressionInput = { hide: () => {}, isTyping: false, isVisible: false };
  tool.centerPick = { value: [10, 5], xExpr: '10', yExpr: '5', newVariables: [], typed: false };
  tool.centerPoint = [10, 5];
  tool.centerSnapRef = null;
  tool.mousePoint = null;
  tool.rxExpression = null;
  tool.lockedRx = null;
  tool.expressionPhase = 'rx';
  tool.rebuildPreview = () => {};
  tool.syncPointInput = () => {};
  return tool;
}

describe('ellipse tool emission', () => {
  it('emits the ellipse statement with 2dp literal radii and no constraints', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);

    tool.commitEllipse(tool.centerPick, { expression: '20' }, { expression: '12.5' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].geometry).toEqual([{ kind: 'ellipse', text: 'ellipse([10, 5], 20, 12.5)' }]);
    expect(emitted[0].constraints).toEqual([]);
    expect(emitted[0].newVariables).toBeUndefined();
  });

  it('a snapped centre pins the centre point with an inferred coincident', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.centerSnapRef = { line: 7, role: 'end', featureType: 'line' };

    tool.commitEllipse(tool.centerPick, { expression: '20' }, { expression: '12' });

    expect(emitted[0].constraints).toEqual([{
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'center' }, { line: 7, role: 'end', featureType: 'line' }],
      inferred: true,
    }]);
    // The provenance is consumed by the emission.
    expect(tool.centerSnapRef).toBeNull();
  });

  it('the origin datum pins the centre the same way', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.centerSnapRef = { datum: 'origin' };

    tool.commitEllipse(tool.centerPick, { expression: '20' }, { expression: '12' });

    expect(emitted[0].constraints).toEqual([{
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'center' }, { datum: 'origin' }],
      inferred: true,
    }]);
  });

  it('the Auto-constraints toggle gates the snap coincident', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted, false);
    tool.centerSnapRef = { datum: 'origin' };

    tool.commitEllipse(tool.centerPick, { expression: '20' }, { expression: '12' });

    expect(emitted[0].constraints).toEqual([]);
  });

  it('typed radii land verbatim as the statement arguments, declaring new variables', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.centerPick = { value: [0, 0], xExpr: 'cx', yExpr: '0', newVariables: [{ name: 'cx', initializer: '0' }], typed: true };

    tool.commitEllipse(
      tool.centerPick,
      { expression: 'rx', newVariable: { name: 'rx', initializer: '20' } },
      { expression: 'rx / 2' },
    );

    expect(emitted[0].geometry).toEqual([{ kind: 'ellipse', text: 'ellipse([cx, 0], rx, rx / 2)' }]);
    // No dimension row: the radii are not solver parameters.
    expect(emitted[0].constraints).toEqual([]);
    expect(emitted[0].newVariables).toEqual([
      { name: 'cx', initializer: '0' },
      { name: 'rx', initializer: '20' },
    ]);
  });

  it('a signed numeric radius is written as its magnitude', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);

    tool.commitEllipse(tool.centerPick, { expression: '-20' }, { expression: '-12' });

    expect(emitted[0].geometry[0].text).toBe('ellipse([10, 5], 20, 12)');
  });

  it('a click with no pill in hand takes both semi-radii off the cursor', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.centerSnapRef = { datum: 'origin' };

    tool.commitFromGeometry([30.004, -3]);

    expect(emitted[0].geometry[0].text).toBe('ellipse([10, 5], 20, 8)');
    expect(emitted[0].constraints).toHaveLength(1);
    // The gesture is over: the next click lands a new centre.
    expect(tool.centerPoint).toBeNull();
    expect(tool.centerPick).toBeNull();
    expect(tool.expressionPhase).toBe('rx');
  });

  it('a committed RX pill carries into a cursor-sized RY click', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);
    tool.rxExpression = { expression: 'w' };
    tool.expressionPhase = 'ry';

    tool.commitFromGeometry([10, 11]);

    expect(emitted[0].geometry[0].text).toBe('ellipse([10, 5], w, 6)');
  });

  it('refuses a degenerate cursor radius without emitting', () => {
    const emitted: Emitted[] = [];
    const tool = makeTool(emitted);

    tool.commitFromGeometry([10, 20]);

    expect(emitted).toHaveLength(0);
    expect(tool.centerPoint).toEqual([10, 5]);
  });
});
