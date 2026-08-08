import { describe, it, expect } from 'vitest';
import { applySegmentSwap, type SegmentSwapSpec } from '../src/segment-swap.ts';

function spec(overrides: Partial<SegmentSwapSpec> = {}): SegmentSwapSpec {
  return {
    edit: { filePath: '/ws/model.fluid.js', line: 4 },
    expectedStatement: 'line([250, 0])',
    newStatement: 'aLine(0, 250)',
    ...overrides,
  };
}

describe('applySegmentSwap', () => {
  const code = [
    `import { sketch, line } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => {`,
    `  line([250, 0]);`,
    `});`,
    ``,
  ].join('\n');

  it('swaps the chain and adds the new callee import once', async () => {
    const result = await applySegmentSwap(code, spec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('  aLine(0, 250);');
    expect(result.newCode).not.toContain('line([250, 0])');
    expect(result.newCode.match(/\baLine\b/g)).toHaveLength(2);
    expect(result.newCode).toContain(`import {aLine, sketch, line } from 'fluidcad/core'`);
  });

  it('preserves a const binding and the trailing semicolon', async () => {
    const bound = code.replace('  line([250, 0]);', '  const a = line([250, 0]);');
    const result = await applySegmentSwap(bound, spec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('  const a = aLine(0, 250);');
  });

  it('does not duplicate an already-present import', async () => {
    const withImport = code.replace(
      `import { sketch, line } from 'fluidcad/core'`,
      `import { sketch, line, aLine } from 'fluidcad/core'`,
    );
    const result = await applySegmentSwap(withImport, spec());
    expect(result.error).toBeUndefined();
    expect(result.newCode.match(/\baLine\b/g)).toHaveLength(2);
  });

  it('swaps a whole member chain (arc → tArc)', async () => {
    const arcCode = code.replace('  line([250, 0]);', `  arc([20, 40]).center([10, 10]).cw();`);
    const result = await applySegmentSwap(arcCode, spec({
      expectedStatement: 'arc([20, 40]).center([10, 10]).cw()',
      newStatement: 'tArc([20, 40])',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('  tArc([20, 40]);');
    expect(result.newCode).not.toContain('.center(');
  });

  it('refuses when the statement drifted since the dialog opened', async () => {
    const result = await applySegmentSwap(code, spec({ expectedStatement: 'line([9, 9])' }));
    expect(result.error).toContain('changed since');
    expect(result.newCode).toBe(code);
  });

  it('refuses a non-segment callee at the line', async () => {
    const rectCode = code.replace('  line([250, 0]);', '  rect(10, 20);');
    const result = await applySegmentSwap(rectCode, spec({ expectedStatement: 'rect(10, 20)' }));
    expect(result.error).toContain('not a sketch segment call');
    expect(result.newCode).toBe(rectCode);
  });

  it('refuses when no call exists at the line', async () => {
    const result = await applySegmentSwap(code, spec({ edit: { filePath: '/ws/model.fluid.js', line: 6 } }));
    expect(result.error).toContain('no call found');
  });

  it('refuses a replacement that is not a segment call', async () => {
    const result = await applySegmentSwap(code, spec({ newStatement: 'rect(1, 2)' }));
    expect(result.error).toContain('malformed');
    expect(result.newCode).toBe(code);
  });
});
