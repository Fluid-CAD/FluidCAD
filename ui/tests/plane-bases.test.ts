// The rule that separates a real `plane()` statement's row from the implicit
// plane a `sketch('xy', …)` registers: the sketch's plane object is stamped
// with the SKETCH call's own source location, so its line holds no plane()
// call to reference as a base or open an edit dialog on.
import { describe, it, expect } from 'vitest';
import { collectPlaneOptions, isPlaneStatementRow } from '../src/interactive/create-feature/plane-bases';
import type { SceneObjectRender } from '../src/types';

const FILE = '/ws/model.fluid.js';

function row(type: string, line: number | null, over: Partial<SceneObjectRender> = {}): SceneObjectRender {
  return {
    id: `${type}-${line}`,
    name: type,
    type,
    sourceLocation: line === null ? undefined : { filePath: FILE, line, column: 0 },
    ...over,
  } as SceneObjectRender;
}

describe('isPlaneStatementRow', () => {
  it('accepts a plane() statement row', () => {
    const planeRow = row('plane', 3);
    expect(isPlaneStatementRow(planeRow, [planeRow, row('plane', 4), row('sketch', 4)])).toBe(true);
  });

  it('rejects the plane a sketch builds for itself', () => {
    // `sketch('xy', …)` at line 4 registers its plane at that same call site.
    const planeRow = row('plane', 4);
    expect(isPlaneStatementRow(planeRow, [planeRow, row('sketch', 4)])).toBe(false);
  });

  it('rejects rows that are not planes, or carry no location', () => {
    const scene = [row('plane', 4), row('sketch', 4)];
    expect(isPlaneStatementRow(row('sketch', 4), scene)).toBe(false);
    expect(isPlaneStatementRow(row('plane', null), scene)).toBe(false);
  });
});

describe('collectPlaneOptions', () => {
  it('offers plane() statements and excludes a sketch implicit plane', () => {
    const options = collectPlaneOptions([
      row('plane', 3),
      row('plane', 4),
      row('sketch', 4),
      row('extrude', 5),
    ]);
    expect(options).toEqual([{ label: 'Plane', filePath: FILE, line: 3, column: 0 }]);
  });

  it('keeps the last plane object at a statement line — the statement result', () => {
    // A mid plane registers its two inputs before its own result, all at the
    // same call site.
    const options = collectPlaneOptions([
      row('plane', 6, { id: 'input-1' }),
      row('plane', 6, { id: 'input-2' }),
      row('plane', 6, { id: 'result' }),
    ]);
    expect(options).toHaveLength(1);
    expect(options[0].line).toBe(6);
  });
});
