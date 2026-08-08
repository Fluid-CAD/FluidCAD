// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { RectTool } from '../src/interactive/tools/rect-tool';
import { ExpressionInput } from '../src/ui/expression-input';

Element.prototype.scrollIntoView = () => {};

type Inserted = { statement: string; newVariable?: unknown };

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

// Drives a RectTool's expression-commit flow against a real ExpressionInput,
// bypassing the canvas/scene: the tool object is created without its
// constructor and fed the state a started rectangle drag would hold.
function makeTool(inserted: Inserted[]): { tool: any; input: HTMLInputElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const expr = new ExpressionInput(container);

  const tool: any = Object.create(RectTool.prototype);
  tool.insertGeometry = (statement: string, newVariable?: unknown) => {
    inserted.push({ statement, newVariable });
  };
  tool.centered = false;
  tool.cachedVariables = [];
  tool.currentPosition = null;
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

  tool.updateDimensionInput();
  return { tool, input: container.querySelector('.expression-input')! };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('rect tool variable declarations', () => {
  it('declaring on height only carries the declaration', async () => {
    const inserted: Inserted[] = [];
    const { tool, input } = makeTool(inserted);

    pressEnter(input); // accept numeric width
    await flushMicrotasks();
    expect(tool.expressionPhase).toBe('height');

    tool.updateDimensionInput(); // mouse keeps moving
    type(input, 'myVar = 50');
    tool.updateDimensionInput();
    pressEnter(input);
    await flushMicrotasks();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].statement).toContain('myVar');
    expect(inserted[0].newVariable).toEqual([{ name: 'myVar', initializer: '50' }]);
  });

  it('declaring on width only carries the declaration', async () => {
    const inserted: Inserted[] = [];
    const { tool, input } = makeTool(inserted);

    type(input, 'myVar = 50');
    pressEnter(input);
    await flushMicrotasks();

    tool.updateDimensionInput();
    pressEnter(input); // accept numeric height
    await flushMicrotasks();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].newVariable).toEqual([{ name: 'myVar', initializer: '50' }]);
  });

  it('declaring on both width and height carries both declarations', async () => {
    const inserted: Inserted[] = [];
    const { tool, input } = makeTool(inserted);

    type(input, 'w = 30');
    pressEnter(input);
    await flushMicrotasks();

    tool.updateDimensionInput();
    type(input, 'h = 20');
    pressEnter(input);
    await flushMicrotasks();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].statement).toContain('rect');
    expect(inserted[0].newVariable).toEqual([
      { name: 'w', initializer: '30' },
      { name: 'h', initializer: '20' },
    ]);
  });

  it('declaring via the bare-name dropdown suggestion uses the live seed value', async () => {
    const inserted: Inserted[] = [];
    const { tool, input } = makeTool(inserted);

    pressEnter(input); // accept numeric width
    await flushMicrotasks();

    tool.updateDimensionInput();
    type(input, 'myVar');
    tool.updateDimensionInput(); // mouse moves after typing: seed tracks height 20
    pressEnter(input);
    await flushMicrotasks();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].newVariable).toEqual([{ name: 'myVar', initializer: '20' }]);
  });
});
