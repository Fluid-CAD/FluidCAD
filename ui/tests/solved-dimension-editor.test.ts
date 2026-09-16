// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Double-clicking a dimension opens its value input on the statement's own
// expression. Committed unchanged, that expression rewrites as it stands —
// never as a fresh declaration, however stale the variable list is — and the
// scope read that follows the open lands in the open input, not the next.

vi.mock('../src/api', () => ({
  getDimensionExpression: vi.fn(),
  updateDimensionExpression: vi.fn(),
}));

import { getDimensionExpression, updateDimensionExpression } from '../src/api';
import { SolvedDimensionEditor } from '../src/interactive/solved-dimension-editor';
import { ParamDeclareMode } from '../src/ui/expression-core';
import type { VariableInfo } from '../src/ui/expression-input';

const LOC = { filePath: '/ws/m.fluid.js', line: 9, column: 4 };

function constraint(value = 3) {
  return {
    kind: 'distance',
    value,
    obj: { id: 'c1', sourceLocation: LOC },
    spec: { kind: 'distance' },
  } as never;
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function mount(variables: Deferred<VariableInfo[]>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new SolvedDimensionEditor(container, () => variables.promise, () => 4);
  const input = () => container.querySelector<HTMLInputElement>('input')!;
  const enter = () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  const paramBtn = () => container.querySelector<HTMLButtonElement>('.expression-param-btn')!;
  return { editor, input, enter, paramBtn };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  ParamDeclareMode.set(true);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('SolvedDimensionEditor', () => {
  it('rewrites the seeded expression as it stands, with no declaration, even before the scope read lands', async () => {
    vi.mocked(getDimensionExpression).mockResolvedValue({ expression: 'wall' });
    const variables = deferred<VariableInfo[]>();
    const { editor, input, enter, paramBtn } = mount(variables);
    expect(editor.show(constraint(), 0, 0)).toBe(true);
    await flush();
    expect(input().value).toBe('wall');
    // Nothing to declare: the P toggle stays out of the way.
    expect(paramBtn().classList.contains('hidden')).toBe(true);

    enter();
    expect(vi.mocked(updateDimensionExpression)).toHaveBeenCalledWith('wall', LOC, 4, undefined, 0, 'distance');
  });

  it('pushes the scope read into the open input, so a just-declared name counts as known', async () => {
    vi.mocked(getDimensionExpression).mockResolvedValue({ expression: 'wall' });
    const variables = deferred<VariableInfo[]>();
    const { editor, input, enter, paramBtn } = mount(variables);
    editor.show(constraint(), 0, 0);
    await flush();
    variables.resolve([{ name: 'wall', initializer: 'param("wall", 3)' }]);
    await flush();

    // Retyping the same name — no longer the untouched seed — still resolves
    // to the known variable rather than a declaration.
    input().value = 'wall';
    input().dispatchEvent(new Event('input'));
    expect(paramBtn().classList.contains('hidden')).toBe(true);
    enter();
    expect(vi.mocked(updateDimensionExpression)).toHaveBeenCalledWith('wall', LOC, 4, undefined, 0, 'distance');
  });

  it('still declares a genuinely new name typed over the seed', async () => {
    vi.mocked(getDimensionExpression).mockResolvedValue({ expression: 'wall' });
    const variables = deferred<VariableInfo[]>();
    variables.resolve([{ name: 'wall', initializer: 'param("wall", 3)' }]);
    const { editor, input, enter } = mount(variables);
    editor.show(constraint(), 0, 0);
    await flush();

    input().value = 'lip';
    input().dispatchEvent(new Event('input'));
    enter();
    expect(vi.mocked(updateDimensionExpression)).toHaveBeenCalledWith(
      'lip', LOC, 4, { name: 'lip', initializer: 'param("lip", 3)' }, 0, 'distance',
    );
  });

  // A statement-owned dimension (an ellipse's RX/RY) has no constraint row:
  // the input opens on the geometry statement's own argument, addressed by
  // the callee plus the arg offset from the end, and the read and the
  // rewrite both filter on that callee — so `ellipse(...).name('cam')`
  // edits the radius, never the name.
  it('opens a statement-owned dimension on its callee + offset and rewrites through the same filter', async () => {
    vi.mocked(getDimensionExpression).mockResolvedValue({ expression: 'w / 2' });
    const variables = deferred<VariableInfo[]>();
    const { editor, input, enter } = mount(variables);
    const rx = {
      obj: { id: 'el1', sourceLocation: LOC },
      call: 'ellipse',
      offset: 1,
      label: 'RX',
      value: 20,
      from: [0, 0],
      to: [20, 0],
      refEntityIds: [0],
    } as never;
    expect(editor.showStatementDimension(rx, 0, 0)).toBe(true);
    expect(input().value).toBe('20');
    expect(vi.mocked(getDimensionExpression)).toHaveBeenCalledWith(LOC.line, 1, 'ellipse');
    await flush();
    expect(input().value).toBe('w / 2');

    enter();
    expect(vi.mocked(updateDimensionExpression)).toHaveBeenCalledWith('w / 2', LOC, 4, undefined, 1, 'ellipse');
  });

  it('refuses a statement-owned dimension whose statement has no source location', () => {
    const variables = deferred<VariableInfo[]>();
    const { editor } = mount(variables);
    const ry = {
      obj: { id: 'el1' }, call: 'ellipse', offset: 0, label: 'RY', value: 10,
      from: [0, 0], to: [0, 10], refEntityIds: [0],
    } as never;
    expect(editor.showStatementDimension(ry, 0, 0)).toBe(false);
    expect(editor.isVisible).toBe(false);
  });
});
