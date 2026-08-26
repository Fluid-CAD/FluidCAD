// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { RectTool } from '../src/interactive/tools/rect-tool';
import { ExpressionInput } from '../src/ui/expression-input';

Element.prototype.scrollIntoView = () => {};

type Emitted = {
  geometry: { kind: string; text: string }[];
  constraints: { kind: string; valueExpr?: string }[];
  newVariables?: { name: string; initializer: string }[];
};

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

// Drives a RectTool's expression-commit flow against a real ExpressionInput,
// bypassing the canvas/scene: the tool object is created without its
// constructor and fed the state a started rectangle drag would hold. The
// solved-context stub records the atomic emission.
function makeTool(emitted: Emitted[]): { tool: any; input: HTMLInputElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const expr = new ExpressionInput(container);

  const tool: any = Object.create(RectTool.prototype);
  tool.solvedCtx = {
    emit: async (request: Emitted) => {
      emitted.push(request);
      return { success: true };
    },
    autoConstraints: () => true,
  };
  tool.centered = false;
  tool.cachedVariables = [];
  tool.startPoint = [0, 0];
  // The anchor's two halves are written together by `consumeStart`; the
  // harness skips that, so inject the pick the origin click would have made.
  tool.startPick = {
    value: [0, 0], xExpr: '0', yExpr: '0', newVariables: [], typed: false,
  };
  tool.mousePoint = [30, 20];
  tool.lastClientX = 100;
  tool.lastClientY = 100;
  tool.expressionInput = expr;
  tool.rebuildPreview = () => {};
  tool.dimensionInputAnchor = () => ({ clientX: 100, clientY: 100 });
  tool.expressionPhase = 'width';
  tool.widthExpression = null;
  tool.lockedWidth = null;
  tool.widthIsNumeric = false;
  tool.widthTyped = false;
  tool.heightTyped = false;

  tool.updateDimensionInput();
  return { tool, input: container.querySelector('.expression-input')! };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('rect tool variable declarations', () => {
  it('declaring on height only carries the declaration', async () => {
    const emitted: Emitted[] = [];
    const { tool, input } = makeTool(emitted);

    pressEnter(input); // accept numeric width
    await flushMicrotasks();
    expect(tool.expressionPhase).toBe('height');

    tool.updateDimensionInput(); // mouse keeps moving
    type(input, 'myVar = 50');
    tool.updateDimensionInput();
    pressEnter(input);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].newVariables).toEqual([{ name: 'myVar', initializer: '50' }]);
    // The typed height becomes a dimension carrying the variable.
    expect(emitted[0].constraints.some(c => c.kind === 'distance' && c.valueExpr === 'myVar')).toBe(true);
  });

  it('declaring on width only carries the declaration', async () => {
    const emitted: Emitted[] = [];
    const { tool, input } = makeTool(emitted);

    type(input, 'myVar = 50');
    pressEnter(input);
    await flushMicrotasks();

    tool.updateDimensionInput();
    pressEnter(input); // accept numeric height
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].newVariables).toEqual([{ name: 'myVar', initializer: '50' }]);
  });

  it('declaring on both width and height carries both declarations', async () => {
    const emitted: Emitted[] = [];
    const { tool, input } = makeTool(emitted);

    type(input, 'w = 30');
    pressEnter(input);
    await flushMicrotasks();

    tool.updateDimensionInput();
    type(input, 'h = 20');
    pressEnter(input);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].geometry.length).toBeGreaterThan(0);
    expect(emitted[0].newVariables).toEqual([
      { name: 'w', initializer: '30' },
      { name: 'h', initializer: '20' },
    ]);
  });

  it('declaring via the bare-name dropdown suggestion uses the live seed value', async () => {
    const emitted: Emitted[] = [];
    const { tool, input } = makeTool(emitted);

    pressEnter(input); // accept numeric width
    await flushMicrotasks();

    tool.updateDimensionInput();
    type(input, 'myVar');
    tool.updateDimensionInput(); // mouse moves after typing: seed tracks height 20
    pressEnter(input);
    await flushMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].newVariables).toEqual([{ name: 'myVar', initializer: '20' }]);
  });
});
