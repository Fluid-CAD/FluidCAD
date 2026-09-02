import { describe, it, expect } from 'vitest';
import { TRANSFORMS, targetPathOf } from '../src/editor/host/transforms';

// The in-page editor host is a third implementation of the host contract, and
// the thing that can silently diverge from the VS Code one is not the plumbing
// — it's the request body each message turns into. So each case below is the
// exact `{ endpoint, body }` `extension/vscode/src/{code-edits,code-api}.ts`
// produces for the same message. A drift here shows up in the product as a
// transform that quietly does nothing.

const SOURCE_LOCATION = { line: 12, column: 3 };

type Case = {
  message: Record<string, unknown>;
  endpoint: string;
  target: 'current' | 'path' | 'source-location';
  body: Record<string, unknown>;
};

const CASES: Record<string, Case> = {
  'insert-point': {
    message: { point: [4, 5], sourceLocation: SOURCE_LOCATION },
    endpoint: 'insert-point',
    target: 'current',
    body: { sourceLine: 12, point: [4, 5] },
  },
  'remove-point': {
    message: { point: [4, 5], sourceLocation: SOURCE_LOCATION },
    endpoint: 'remove-point',
    target: 'current',
    body: { sourceLine: 12, point: [4, 5] },
  },
  'add-pick': {
    message: { sourceLocation: SOURCE_LOCATION },
    endpoint: 'add-pick',
    target: 'current',
    body: { sourceLine: 12 },
  },
  'remove-pick': {
    message: { sourceLocation: SOURCE_LOCATION },
    endpoint: 'remove-pick',
    target: 'current',
    body: { sourceLine: 12 },
  },
  'add-guide': {
    message: { sourceLocation: SOURCE_LOCATION },
    endpoint: 'add-guide',
    target: 'current',
    body: { sourceLine: 12 },
  },
  'remove-guide': {
    message: { sourceLocation: SOURCE_LOCATION },
    endpoint: 'remove-guide',
    target: 'current',
    body: { sourceLine: 12 },
  },
  'set-pick-points': {
    message: { points: [[1, 2], [3, 4]], sourceLocation: SOURCE_LOCATION },
    endpoint: 'set-pick-points',
    target: 'current',
    body: { sourceLine: 12, points: [[1, 2], [3, 4]] },
  },
  'insert-geometry': {
    message: {
      statement: 'hLine([0, 0], 40)',
      sketchSourceLocation: { line: 7, column: 0 },
      newVariable: { name: 'w', initializer: '40' },
    },
    endpoint: 'insert-geometry',
    target: 'current',
    body: { sketchSourceLine: 7, statement: 'hLine([0, 0], 40)', newVariable: { name: 'w', initializer: '40' } },
  },
  'update-position': {
    message: { newPosition: [8, 9], sourceLocation: SOURCE_LOCATION, pointIndex: 2, oldPosition: [1, 1] },
    endpoint: 'update-position',
    target: 'current',
    body: { sourceLine: 12, newPosition: [8, 9], pointIndex: 2, oldPosition: [1, 1] },
  },
  'update-point-expression': {
    message: {
      xExpr: 'w / 2',
      yExpr: 'h',
      sourceLocation: SOURCE_LOCATION,
      sketchSourceLine: 7,
      newVariable: [{ name: 'w', initializer: '40' }],
      pointIndex: 1,
      oldPosition: [0, 0],
    },
    endpoint: 'update-point-expression',
    target: 'current',
    body: {
      sourceLine: 12,
      xExpr: 'w / 2',
      yExpr: 'h',
      sketchSourceLine: 7,
      newVariable: [{ name: 'w', initializer: '40' }],
      pointIndex: 1,
      oldPosition: [0, 0],
    },
  },
  'set-line-position': {
    message: { newStart: [0, 0], newEnd: [10, 0], sourceLocation: SOURCE_LOCATION },
    endpoint: 'set-line-position',
    target: 'current',
    body: { sourceLine: 12, newStart: [0, 0], newEnd: [10, 0] },
  },
  'set-chain-positions': {
    message: { updates: [{ pointIndex: 0, position: [1, 2] }], sourceLocation: SOURCE_LOCATION },
    endpoint: 'set-chain-positions',
    target: 'current',
    body: { sourceLine: 12, updates: [{ pointIndex: 0, position: [1, 2] }] },
  },
  'set-rect-dimensions': {
    message: {
      startPoint: [1, 1],
      width: 40,
      height: 20,
      sourceLocation: SOURCE_LOCATION,
      oldStartPoint: [0, 0],
    },
    endpoint: 'set-rect-dimensions',
    target: 'current',
    body: { sourceLine: 12, startPoint: [1, 1], width: 40, height: 20, oldStartPoint: [0, 0] },
  },
  'update-dimension': {
    message: { newValue: 31.5, sourceLocation: SOURCE_LOCATION },
    endpoint: 'update-dimension',
    target: 'current',
    body: { sourceLine: 12, newValue: 31.5 },
  },
  'update-dimension-expression': {
    message: {
      expression: 'r * 2',
      sourceLocation: SOURCE_LOCATION,
      dimensionOffset: 1,
      dimensionCall: 'tArc',
      dimensionInsert: true,
      dimensionPoint: [3, 4],
    },
    endpoint: 'update-dimension-expression',
    target: 'current',
    body: {
      sourceLine: 12,
      expression: 'r * 2',
      sketchSourceLine: null,
      newVariable: null,
      dimensionOffset: 1,
      dimensionCall: 'tArc',
      dimensionInsert: true,
      dimensionPoint: [3, 4],
    },
  },

  // Assembly instance edits (parts panel) rewrite the insert() chain at the
  // statement's own location — the file comes from `sourceLocation`, as in
  // the Neovim bridge.
  'update-insert-chain': {
    message: {
      sourceLocation: { filePath: '/ws/robot.assembly.js', ...SOURCE_LOCATION },
      edit: { ground: true, name: 'Base' },
    },
    endpoint: 'update-insert-chain',
    target: 'source-location',
    body: { sourceLine: 12, edit: { ground: true, name: 'Base' } },
  },

  // Timeline edits name their own file — a feature can live in an import.
  'remove-feature': {
    message: { filePath: '/ws/other.fluid.js', line: 20 },
    endpoint: 'remove-statement',
    target: 'path',
    body: { sourceLine: 20 },
  },
  'rename-feature': {
    message: { filePath: '/ws/other.fluid.js', line: 20, name: 'Body' },
    endpoint: 'set-feature-name',
    target: 'path',
    body: { sourceLine: 20, name: 'Body' },
  },
  'insert-load': {
    message: { filePath: '/ws/m.fluid.js', fileName: 'part.step' },
    endpoint: 'insert-load',
    target: 'path',
    body: { fileName: 'part.step' },
  },

  'add-breakpoint': {
    message: { filePath: '/ws/m.fluid.js', line: 9 },
    endpoint: 'add-breakpoint',
    target: 'path',
    // 0-based: passing the raw 1-based line lands the breakpoint one
    // statement too late.
    body: { referenceRow: 8 },
  },
  'clear-breakpoints': {
    message: {},
    endpoint: 'clear-breakpoints',
    target: 'current',
    body: {},
  },

  // The unit chip: the path rides along so the server can refuse an
  // assembly file.
  'set-unit': {
    message: { filePath: '/ws/m.part.js', unit: 'in' },
    endpoint: 'set-unit',
    target: 'path',
    body: { unit: 'in', filePath: '/ws/m.part.js' },
  },
};

describe('set-unit transform body', () => {
  it('keeps a null unit ("Same as project") as an explicit null, not a dropped key', () => {
    const body = TRANSFORMS['set-unit'].body({ filePath: '/ws/m.part.js', unit: null });
    expect(body).toEqual({ unit: null, filePath: '/ws/m.part.js' });
    expect(JSON.parse(JSON.stringify(body))).toEqual({ unit: null, filePath: '/ws/m.part.js' });
  });
});

describe('editor host transform table', () => {
  for (const [type, expected] of Object.entries(CASES)) {
    it(`${type} → POST /api/code/${expected.endpoint}`, () => {
      const spec = TRANSFORMS[type];
      expect(spec, `no transform registered for ${type}`).toBeDefined();
      expect(spec.endpoint).toBe(expected.endpoint);
      expect(spec.target).toBe(expected.target);
      expect(spec.body(expected.message)).toEqual(expected.body);
    });
  }

  it('covers exactly the transforms the host contract lists', () => {
    expect(Object.keys(TRANSFORMS).sort()).toEqual(Object.keys(CASES).sort());
  });

  it('defaults the optional arguments the way the VS Code host does', () => {
    // Every one of these has a default in `code-api.ts`; sending `undefined`
    // instead would make the server read a missing field rather than the
    // documented default.
    expect(TRANSFORMS['update-position'].body({
      newPosition: [1, 2],
      sourceLocation: SOURCE_LOCATION,
    })).toEqual({ sourceLine: 12, newPosition: [1, 2], pointIndex: 0, oldPosition: null });

    expect(TRANSFORMS['insert-geometry'].body({
      statement: 'x',
      sketchSourceLocation: { line: 3 },
    })).toEqual({ sketchSourceLine: 3, statement: 'x', newVariable: null });

    expect(TRANSFORMS['set-rect-dimensions'].body({
      startPoint: null,
      width: 1,
      height: 2,
      sourceLocation: SOURCE_LOCATION,
    })).toEqual({ sourceLine: 12, startPoint: null, width: 1, height: 2, oldStartPoint: null });
  });

  it('resolves the target file per target flavour', () => {
    expect(targetPathOf(TRANSFORMS['add-pick'], { sourceLocation: { filePath: '/ws/a.part.js', line: 1 } })).toBeNull();
    expect(targetPathOf(TRANSFORMS['remove-feature'], { filePath: '/ws/other.part.js', line: 2 })).toBe('/ws/other.part.js');
    expect(targetPathOf(TRANSFORMS['update-insert-chain'], {
      sourceLocation: { filePath: '/ws/robot.assembly.js', line: 3 },
      edit: {},
    })).toBe('/ws/robot.assembly.js');
    // A named target that is missing falls back to the current model rather
    // than throwing inside the socket handler.
    expect(targetPathOf(TRANSFORMS['update-insert-chain'], { edit: {} })).toBeNull();
  });

  it('never lets a 1-based line reach a 0-based row argument', () => {
    expect(TRANSFORMS['add-breakpoint'].body({ line: 1 })).toEqual({ referenceRow: 0 });
    // A malformed line 0 must not become -1.
    expect(TRANSFORMS['add-breakpoint'].body({ line: 0 })).toEqual({ referenceRow: 0 });
  });
});
