// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { LineTool } from '../src/interactive/tools/line-tool';
import type { VariableInfo } from '../src/ui/expression-core';

// A drawing tool reads the sketch's scope when it arms. The read queues
// behind whatever the server is rendering — the recompute a parameter edit
// just triggered — so it lands after the pill or the dimension input is
// already open; both take the list then. An older read never overwrites a
// newer one.

const VARS: VariableInfo[] = [{ name: 'width', initializer: 'param("width", 40)' }];

type Deferred = { promise: Promise<VariableInfo[]>; resolve: (v: VariableInfo[]) => void };
function deferred(): Deferred {
  let resolve!: (v: VariableInfo[]) => void;
  const promise = new Promise<VariableInfo[]>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A LineTool with only the scope-read plumbing, bypassing canvas/scene. */
function makeTool(reads: Deferred[]): any {
  const tool: any = Object.create(LineTool.prototype);
  tool.cachedVariables = [];
  tool.variablesRead = 0;
  tool.fetchVariablesFn = () => reads.shift()!.promise;
  tool.pointInput = { setVariables: vi.fn() };
  tool.expressionInput = { setVariables: vi.fn() };
  return tool;
}

describe('sketch tool late variable list', () => {
  it('pushes a read that lands late into the pill and the dimension input', async () => {
    const read = deferred();
    const tool = makeTool([read]);
    tool.refreshVariables();
    expect(tool.cachedVariables).toEqual([]);

    read.resolve(VARS);
    await read.promise;

    expect(tool.cachedVariables).toEqual(VARS);
    expect(tool.pointInput.setVariables).toHaveBeenCalledWith(VARS);
    expect(tool.expressionInput.setVariables).toHaveBeenCalledWith(VARS);
  });

  it('drops an older read that lands after a newer one', async () => {
    const first = deferred();
    const second = deferred();
    const tool = makeTool([first, second]);
    tool.refreshVariables();
    tool.refreshVariables();

    second.resolve(VARS);
    await second.promise;
    first.resolve([]);
    await first.promise;

    expect(tool.cachedVariables).toEqual(VARS);
    expect(tool.pointInput.setVariables).toHaveBeenCalledTimes(1);
  });
});
