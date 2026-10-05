import { describe, it, expect } from 'vitest';
import { collectSectionRows, sectionSpecOf } from '../src/interactive/section-view/section-rows';
import type { SceneObjectRender } from '../src/types';

function row(overrides: Partial<SceneObjectRender>): SceneObjectRender {
  return { sceneShapes: [], ownShapes: [], ...overrides };
}

describe('collectSectionRows', () => {
  it('lists the section rows in statement order, keyed by file and name', () => {
    const rows = collectSectionRows([
      row({ type: 'extrude', name: 'Extrude' }),
      row({
        type: 'section', name: 'Section', internal: true,
        object: { name: 'A-A', origin: [0, 0, 0], normal: [0, -1, 0], offset: 5, flip: false },
        sourceLocation: { filePath: '/ws/m.fluid.js', line: 9, column: 0 },
      }),
      row({
        type: 'section', name: 'Section', internal: true,
        object: { name: 'Top', origin: [0, 0, 10], normal: [0, 0, 1], offset: 0, flip: true },
        sourceLocation: { filePath: '/ws/m.fluid.js', line: 12, column: 0 },
      }),
    ]);
    expect(rows.map(r => [r.key, r.name, r.offset, r.flip, r.error])).toEqual([
      ['/ws/m.fluid.js:A-A#0', 'A-A', 5, false, null],
      ['/ws/m.fluid.js:Top#0', 'Top', 0, true, null],
    ]);
    expect(rows[1].origin).toEqual([0, 0, 10]);
  });

  it('keeps a row\'s key when a statement added above it moves its line, and tells same-named views apart', () => {
    const section = (name: string, line: number) => row({
      type: 'section', object: { name, origin: [0, 0, 0], normal: [0, 0, 1], offset: 0, flip: false },
      sourceLocation: { filePath: '/ws/m.fluid.js', line, column: 0 },
    });
    const before = collectSectionRows([section('A-A', 9), section('A-A', 10)]);
    const after = collectSectionRows([row({ type: 'extrude' }), section('A-A', 12), section('A-A', 13)]);
    expect(after.map(r => r.key)).toEqual(before.map(r => r.key));
    expect(new Set(after.map(r => r.key)).size).toBe(2);
  });

  it('keeps a failed row with its error, and a row without a location keyed by name', () => {
    const rows = collectSectionRows([
      row({
        type: 'section', name: 'Section', hasError: true, errorMessage: 'Plane: Selected shape is not a face',
        object: {},
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(':Section#0');
    expect(rows[0].error).toContain('not a face');
  });

  it('flags a built-looking row whose plane is missing', () => {
    const rows = collectSectionRows([
      row({ type: 'section', object: { name: 'X', origin: [0, 0, 0], normal: [0, 0, 0] } }),
    ]);
    expect(rows[0].error).toMatch(/no plane/);
  });
});

describe('sectionSpecOf', () => {
  it('builds the clip spec from the row, at its offset or a live override', () => {
    const [r] = collectSectionRows([
      row({
        type: 'section',
        object: { name: 'A-A', origin: [1, 2, 3], normal: [0, 0, 1], offset: 4, flip: true },
        sourceLocation: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
      }),
    ]);
    expect(sectionSpecOf(r)).toEqual({ plane: { origin: [1, 2, 3], normal: [0, 0, 1] }, offset: 4, flip: true });
    expect(sectionSpecOf(r, -2).offset).toBe(-2);
  });
});
