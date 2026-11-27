import { describe, it, expect } from 'vitest';
import { parseDirection, parseOperandRefs, parseOperandRows } from '../src/routes/feature-ghost/refs.ts';

const FILE = '/ws/model.fluid.js';

describe('parseOperandRefs', () => {
  it('reads a curve row: whole objects by statement and edges by their viewport address', () => {
    const picks = [
      { kind: 'statement', filePath: FILE, line: 3, column: 14, label: 'Helix 1' },
      { kind: 'edge', shapeId: 'solid-1', index: 4 },
    ];
    expect(parseOperandRefs(picks, 'curve')).toEqual([
      { kind: 'statement', filePath: FILE, line: 3 },
      { kind: 'edge', shapeId: 'solid-1', index: 4 },
    ]);
  });

  it('reads a surface row: whole objects by statement and faces by their viewport address', () => {
    const picks = [{ kind: 'face', shapeId: 'solid-1', index: 0 }, { kind: 'statement', filePath: FILE, line: 7 }];
    expect(parseOperandRefs(picks, 'surface')).toEqual(picks);
  });

  it('reads an empty row as no pick', () => {
    expect(parseOperandRefs([], 'curve')).toEqual([]);
  });

  it('refuses a face in a curve row and an edge in a surface row', () => {
    expect(parseOperandRefs([{ kind: 'face', shapeId: 'solid-1', index: 0 }], 'curve')).toBeNull();
    expect(parseOperandRefs([{ kind: 'edge', shapeId: 'solid-1', index: 0 }], 'surface')).toBeNull();
  });

  it('refuses a pick the client could not address, and a value that is no list', () => {
    expect(parseOperandRefs([{ kind: 'statement', filePath: FILE }], 'curve')).toBeNull();
    expect(parseOperandRefs([{ kind: 'edge', shapeId: 'solid-1', index: -1 }], 'curve')).toBeNull();
    expect(parseOperandRefs([{ kind: 'keep', text: 'spine' }], 'curve')).toBeNull();
    expect(parseOperandRefs([null], 'surface')).toBeNull();
    expect(parseOperandRefs({ kind: 'statement', filePath: FILE, line: 3 }, 'curve')).toBeNull();
  });
});

describe('parseOperandRows', () => {
  const kinds = { left: 'curve', right: 'surface' } as const;
  const edge = { kind: 'edge', shapeId: 'solid-1', index: 4 };
  const face = { kind: 'face', shapeId: 'solid-1', index: 0 };

  it('reads each row by its name as a row of its kind', () => {
    expect(parseOperandRows({ left: [edge], right: [face] }, kinds)).toEqual({ left: [edge], right: [face] });
  });

  it('answers null when a row is missing, of the wrong kind or empty', () => {
    expect(parseOperandRows({ left: [edge] }, kinds)).toBeNull();
    expect(parseOperandRows({ left: [face], right: [face] }, kinds)).toBeNull();
    expect(parseOperandRows({ left: [edge], right: [] }, kinds)).toBeNull();
  });
});

describe('parseDirection', () => {
  it('reads every axis form a direction takes', () => {
    expect(parseDirection({ kind: 'standard', axis: 'z' })).toEqual({ kind: 'standard', axis: 'z' });
    expect(parseDirection({ kind: 'axis', filePath: FILE, line: 3 })).toEqual({ kind: 'axis', filePath: FILE, line: 3 });
    expect(parseDirection({ kind: 'edge', shapeId: 'solid-1', index: 2 })).toEqual({ kind: 'edge', shapeId: 'solid-1', index: 2 });
    expect(parseDirection({ kind: 'connector', filePath: FILE, line: 5, slot: 2 }))
      .toEqual({ kind: 'connector', filePath: FILE, line: 5, slot: 2 });
  });

  it('reads every plane form, each standing for its normal', () => {
    expect(parseDirection({ kind: 'standard-plane', plane: 'xy' })).toEqual({ kind: 'standard-plane', plane: 'xy' });
    expect(parseDirection({ kind: 'plane', filePath: FILE, line: 4 })).toEqual({ kind: 'plane', filePath: FILE, line: 4 });
    expect(parseDirection({ kind: 'face', shapeId: 'solid-1', index: 0 })).toEqual({ kind: 'face', shapeId: 'solid-1', index: 0 });
  });

  it('refuses a plane named as an axis, an unknown name and an unaddressed pick', () => {
    expect(parseDirection({ kind: 'standard', axis: 'xy' })).toBeNull();
    expect(parseDirection({ kind: 'standard-plane', plane: 'z' })).toBeNull();
    expect(parseDirection({ kind: 'plane', filePath: FILE })).toBeNull();
    expect(parseDirection({ kind: 'face', shapeId: 'solid-1' })).toBeNull();
    expect(parseDirection({ kind: 'vector', x: 0, y: 0, z: 1 })).toBeNull();
    expect(parseDirection(null)).toBeNull();
  });
});
