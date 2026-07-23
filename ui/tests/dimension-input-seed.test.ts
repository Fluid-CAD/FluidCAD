// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateDimensionExpression = vi.fn();
const getDimensionExpression = vi.fn();

vi.mock('../src/api', () => ({
  updateDimensionExpression: (...args: unknown[]) => updateDimensionExpression(...args),
  getDimensionExpression: (...args: unknown[]) => getDimensionExpression(...args),
}));

const { DimensionInputController } = await import('../src/interactive/drag-move-handler/dimension-input');

Element.prototype.scrollIntoView = () => {};

type Ctl = InstanceType<typeof DimensionInputController>;

function makeController(): { controller: Ctl; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const controller = new DimensionInputController(
    container,
    async () => [{ name: 'var1', initializer: '50', numeric: true }],
    () => 3,
  );
  return { controller, container };
}

function inputOf(container: HTMLElement): HTMLInputElement {
  return container.querySelector('.expression-input')!;
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function clickParamToggle(container: HTMLElement): void {
  const btn = container.querySelector<HTMLButtonElement>('.expression-param-btn')!;
  expect(btn.classList.contains('hidden')).toBe(false);
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// A circle whose diameter is currently driven by `var1` — 50 on screen.
const CIRCLE_HIT = {
  sourceLocation: { line: 5, column: 2 },
  uniqueType: 'circle',
  hitZone: 'body' as const,
  anchorPoint: [0, 0] as [number, number],
  initialValue: 50,
};

describe('double-click dimension edit over an existing expression', () => {
  beforeEach(() => {
    updateDimensionExpression.mockClear();
    getDimensionExpression.mockClear();
    getDimensionExpression.mockResolvedValue({ expression: 'var1' });
  });

  it('seeds a new param() with the numeric value, not the referenced variable', async () => {
    const { controller, container } = makeController();
    await controller.refreshVariables();

    controller.showForDoubleClick(CIRCLE_HIT, 100, 100);
    await flushMicrotasks();

    const input = inputOf(container);
    expect(input.value).toBe('var1');

    type(input, 'var2');
    clickParamToggle(container);
    pressEnter(input);

    expect(updateDimensionExpression).toHaveBeenCalledTimes(1);
    const [expression, , sketchSourceLine, newVariable] = updateDimensionExpression.mock.calls[0];
    expect(expression).toBe('var2');
    expect(sketchSourceLine).toBe(3);
    expect(newVariable).toEqual({ name: 'var2', initializer: 'param("var2", 50)' });
  });

  it('seeds a plain new variable with the numeric value too', async () => {
    const { controller, container } = makeController();
    await controller.refreshVariables();

    controller.showForDoubleClick(CIRCLE_HIT, 100, 100);
    await flushMicrotasks();

    const input = inputOf(container);
    type(input, 'var2');
    pressEnter(input);

    expect(updateDimensionExpression).toHaveBeenCalledTimes(1);
    const [expression, , , newVariable] = updateDimensionExpression.mock.calls[0];
    expect(expression).toBe('var2');
    expect(newVariable).toEqual({ name: 'var2', initializer: '50' });
  });

  it('still commits a referenced existing variable as a plain expression', async () => {
    const { controller, container } = makeController();
    await controller.refreshVariables();

    controller.showForDoubleClick(CIRCLE_HIT, 100, 100);
    await flushMicrotasks();

    const input = inputOf(container);
    pressEnter(input);

    expect(updateDimensionExpression).toHaveBeenCalledTimes(1);
    const [expression, , , newVariable] = updateDimensionExpression.mock.calls[0];
    expect(expression).toBe('var1');
    expect(newVariable).toBeUndefined();
  });
});
