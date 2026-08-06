import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createFeatureGhostRouter } from '../../src/routes/feature-ghost.ts';

// The repeat and copy arms of the live-geometry endpoint: the contract between
// each dialog's slots and the request the kernel receives. The kernel itself is
// covered by lib's ghost tests — what matters here is that the dialog's body
// arrives as resolved numbers and explicit refs, and that a body no kind
// accepts is refused instead of half-built.
let server: http.Server;
let baseUrl: string;

/** The last request the route handed to the kernel. */
let received: any;
let code: string;

const FILE = '/ws/m.fluid.js';

const fakeServer = {
  getCurrentCode: () => code,
  getParamDefinitions: () => [],
  featureGhost: async (request: unknown) => {
    received = request;
    return { status: 200, solids: [] };
  },
};

/** A linear repeat exactly as the dialog sends it. */
function linearBody(overrides: Record<string, unknown> = {}) {
  return {
    feature: 'repeat',
    kind: 'linear',
    targets: [{ filePath: FILE, line: 7 }],
    axes: [{ kind: 'standard', axis: 'x' }],
    plane: null,
    directions: [{ count: 3, offset: 40, length: null }],
    centered: false,
    count: null,
    sweep: null,
    angle: null,
    ...overrides,
  };
}

/** A linear copy exactly as the dialog sends it. */
function copyBody(overrides: Record<string, unknown> = {}) {
  return {
    feature: 'copy',
    kind: 'linear',
    targets: [{ filePath: FILE, line: 7 }],
    axes: [{ kind: 'standard', axis: 'x' }],
    directions: [{ count: 3, offset: 40, length: null }],
    centered: false,
    count: null,
    sweep: null,
    ...overrides,
  };
}

async function postGhost(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/feature-ghost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** The route on a throwaway port, fresh per block — every dialog shares it. */
function useGhostRoute(): void {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createFeatureGhostRouter(fakeServer as never));

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    received = undefined;
    code = '';
  });
}

describe('feature-ghost route — repeat', () => {
  useGhostRoute();

  it('passes a linear repeat through as resolved numbers', async () => {
    const { status, body } = await postGhost(linearBody());

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(received).toMatchObject({
      feature: 'repeat',
      kind: 'linear',
      targets: [{ filePath: FILE, line: 7 }],
      axes: [{ kind: 'standard', axis: 'x' }],
      directions: [{ count: 3, offset: 40, length: null }],
      centered: false,
    });
  });

  it('carries the total-span spacing form as it stands', async () => {
    await postGhost(linearBody({
      directions: [{ count: 4, offset: null, length: 120 }],
      centered: true,
    }));

    // The kernel divides the span across the gaps — the route only resolves.
    expect(received.directions).toEqual([{ count: 4, offset: null, length: 120 }]);
    expect(received.centered).toBe(true);
  });

  it('pairs each direction with its own axis', async () => {
    await postGhost(linearBody({
      axes: [{ kind: 'standard', axis: 'x' }, { kind: 'edge', shapeId: 's1', index: 4 }],
      directions: [
        { count: 2, offset: 40, length: null },
        { count: 3, offset: 10, length: null },
      ],
    }));

    expect(received.axes).toEqual([
      { kind: 'standard', axis: 'x' },
      { kind: 'edge', shapeId: 's1', index: 4 },
    ]);
    expect(received.directions).toHaveLength(2);
  });

  it('resolves a spacing bound to a top-level parameter', async () => {
    code = ['const spacing = 25', 'sketch("xy", () => {})'].join('\n');

    await postGhost(linearBody({
      directions: [{ count: 3, offset: 'spacing', length: null }],
    }));

    expect(received.directions[0].offset).toBe(25);
  });

  /**
   * How a parametric model is actually written — `{ count: sides, offset: 360
   * / sides }`. The names come from the file's top-level params; the sum is
   * worked out here so the dialog gets a ghost instead of nothing.
   */
  it('works out arithmetic over the file\'s parameters', async () => {
    code = ['const sides = param("Sides", 6)', 'sketch("xy", () => {})'].join('\n');

    await postGhost(linearBody({
      kind: 'circular',
      directions: [],
      count: 'sides',
      sweep: { mode: 'offset', value: '360 / sides' },
    }));

    expect(received.count).toBe(6);
    expect(received.sweep).toEqual({ mode: 'offset', value: 60 });
  });

  it('handles the rest of the arithmetic a dimension is written with', async () => {
    code = ['const width = 40', 'const gap = 10'].join('\n');

    const cases: [string, number][] = [
      ['width + gap', 50],
      ['width - gap * 2', 20],
      ['(width + gap) / 2', 25],
      ['-gap', -10],
      ['width % 30', 10],
      ['2 ** 5', 32],
    ];
    for (const [expression, expected] of cases) {
      await postGhost(linearBody({
        directions: [{ count: 3, offset: expression, length: null }],
      }));
      expect(received?.directions?.[0]?.offset, expression).toBe(expected);
      received = undefined;
    }
  });

  it('refuses an expression whose names it cannot resolve', async () => {
    const { status, body } = await postGhost(linearBody({
      directions: [{ count: 3, offset: 'spacing * 2', length: null }],
    }));

    // Not an error — the statement preview still works, the ghost just clears.
    // Nor a notice: an unresolvable dimension is a limitation of the preview,
    // not something to tell the user about per keystroke.
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.surface).toBeFalsy();
    expect(received).toBeUndefined();
  });

  /**
   * The evaluator reads text a dialog typed. It must work sums out and
   * nothing else — no call, no member access, no division by zero.
   */
  it('refuses anything that is not arithmetic', async () => {
    code = 'const width = 40';

    for (const expression of [
      'Math.round(3.7)',
      'width.toFixed(0)',
      'width = 1',
      'width / 0',
      '[1][0]',
      'width ? 1 : 2',
    ]) {
      const { status, body } = await postGhost(linearBody({
        directions: [{ count: 3, offset: expression, length: null }],
      }));
      expect(status, expression).toBe(200);
      expect(body.success, expression).toBe(false);
      expect(received, expression).toBeUndefined();
    }
  });

  it('marks the kernel refusals worth reading out loud', async () => {
    const capped = {
      status: 422,
      reason: '299 instances is more than the preview draws.',
      surface: true,
    };
    const previous = fakeServer.featureGhost;
    fakeServer.featureGhost = async () => capped as never;
    try {
      const { status, body } = await postGhost(linearBody());
      expect(status).toBe(422);
      expect(body).toMatchObject({ success: false, reason: capped.reason, surface: true });
    } finally {
      fakeServer.featureGhost = previous;
    }
  });

  it('passes a circular repeat with its count and sweep', async () => {
    await postGhost(linearBody({
      kind: 'circular',
      axes: [{ kind: 'axis', filePath: FILE, line: 3 }],
      directions: [],
      count: 6,
      sweep: { mode: 'angle', value: 360 },
    }));

    expect(received).toMatchObject({
      kind: 'circular',
      count: 6,
      sweep: { mode: 'angle', value: 360 },
      axes: [{ kind: 'axis', filePath: FILE, line: 3 }],
    });
  });

  it('passes a mirror repeat with its plane and no axis', async () => {
    await postGhost(linearBody({
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'face', shapeId: 's1', index: 2 },
    }));

    expect(received).toMatchObject({
      kind: 'mirror',
      axes: [],
      plane: { kind: 'face', shapeId: 's1', index: 2 },
    });
  });

  it('passes a rotate repeat with its angle', async () => {
    await postGhost(linearBody({
      kind: 'rotate',
      axes: [{ kind: 'standard', axis: 'z' }],
      directions: [],
      angle: 45,
    }));

    expect(received).toMatchObject({ kind: 'rotate', angle: 45 });
  });

  it('refuses a body no kind accepts', async () => {
    const bodies: Record<string, unknown>[] = [
      // An unknown kind.
      linearBody({ kind: 'spiral' }),
      // Nothing to repeat.
      linearBody({ targets: [] }),
      // A direction with no axis to walk along.
      linearBody({ axes: [] }),
      // Two spacings for one direction, and none at all.
      linearBody({ directions: [{ count: 3, offset: 40, length: 120 }] }),
      linearBody({ directions: [{ count: 3, offset: null, length: null }] }),
      // A circular repeat missing the angle it distributes.
      linearBody({ kind: 'circular', directions: [], count: 6, sweep: null }),
      // A rotate with no angle to turn by.
      linearBody({ kind: 'rotate', directions: [], angle: null }),
      // A mirror with no plane to reflect across.
      linearBody({ kind: 'mirror', axes: [], directions: [] }),
    ];

    for (const body of bodies) {
      const result = await postGhost(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.success).toBe(false);
    }
    expect(received).toBeUndefined();
  });
});

describe('feature-ghost route — copy', () => {
  useGhostRoute();

  it('passes a linear copy through as resolved numbers', async () => {
    const { status, body } = await postGhost(copyBody());

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(received).toMatchObject({
      feature: 'copy',
      kind: 'linear',
      targets: [{ filePath: FILE, line: 7 }],
      axes: [{ kind: 'standard', axis: 'x' }],
      directions: [{ count: 3, offset: 40, length: null }],
      centered: false,
    });
  });

  it('carries the total-span spacing form as it stands', async () => {
    await postGhost(copyBody({
      directions: [{ count: 4, offset: null, length: 120 }],
      centered: true,
    }));

    // The kernel divides the span across the gaps — the route only resolves.
    expect(received.directions).toEqual([{ count: 4, offset: null, length: 120 }]);
    expect(received.centered).toBe(true);
  });

  it('pairs each direction with its own axis', async () => {
    await postGhost(copyBody({
      axes: [{ kind: 'standard', axis: 'x' }, { kind: 'edge', shapeId: 's1', index: 4 }],
      directions: [
        { count: 2, offset: 40, length: null },
        { count: 3, offset: 10, length: null },
      ],
    }));

    expect(received.axes).toEqual([
      { kind: 'standard', axis: 'x' },
      { kind: 'edge', shapeId: 's1', index: 4 },
    ]);
    expect(received.directions).toHaveLength(2);
  });

  it('passes a circular copy with its count and sweep', async () => {
    await postGhost(copyBody({
      kind: 'circular',
      axes: [{ kind: 'axis', filePath: FILE, line: 3 }],
      directions: [],
      count: 6,
      sweep: { mode: 'angle', value: 360 },
    }));

    expect(received).toMatchObject({
      kind: 'circular',
      count: 6,
      sweep: { mode: 'angle', value: 360 },
      axes: [{ kind: 'axis', filePath: FILE, line: 3 }],
    });
  });

  /**
   * A skip list names literal positions, so it crosses as it stands — nothing
   * here goes near the expression resolver.
   */
  it('carries the skip list through untouched', async () => {
    await postGhost(copyBody({
      axes: [{ kind: 'standard', axis: 'x' }, { kind: 'standard', axis: 'y' }],
      directions: [
        { count: 3, offset: 40, length: null },
        { count: 2, offset: 30, length: null },
      ],
      skip: [[1, 0], [2]],
    }));

    expect(received.skip).toEqual([[1, 0], [2]]);
  });

  it('reads an absent skip list as skipping nothing', async () => {
    await postGhost(copyBody());

    expect(received.skip).toEqual([]);
  });

  it('refuses a skip list that is not whole index tuples', async () => {
    const bodies: Record<string, unknown>[] = [
      copyBody({ skip: [[1.5]] }),
      copyBody({ skip: [[-1]] }),
      copyBody({ skip: [[]] }),
      // One direction, so no cell has a second index.
      copyBody({ skip: [[1, 0]] }),
      // The tuple form is the wire's, for both kinds.
      copyBody({ skip: [1] }),
      copyBody({ kind: 'circular', directions: [], count: 6, sweep: { mode: 'angle', value: 360 }, skip: [[1, 0]] }),
    ];

    for (const body of bodies) {
      const result = await postGhost(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.reason).toContain('skip');
    }
    expect(received).toBeUndefined();
  });

  it('resolves a copy\'s dimensions against the file\'s parameters', async () => {
    code = ['const sides = param("Sides", 6)', 'sketch("xy", () => {})'].join('\n');

    await postGhost(copyBody({
      kind: 'circular',
      directions: [],
      count: 'sides',
      sweep: { mode: 'offset', value: '360 / sides' },
    }));

    expect(received.count).toBe(6);
    expect(received.sweep).toEqual({ mode: 'offset', value: 60 });
  });

  it('refuses a body no kind accepts', async () => {
    const bodies: Record<string, unknown>[] = [
      // A repeat kind the copy doesn't have — copy walks or spins, nothing else.
      copyBody({ kind: 'mirror', axes: [], directions: [] }),
      copyBody({ kind: 'rotate', directions: [], angle: 45 }),
      // Nothing to copy.
      copyBody({ targets: [] }),
      // A direction with no axis to walk along.
      copyBody({ axes: [] }),
      // Two spacings for one direction, and none at all.
      copyBody({ directions: [{ count: 3, offset: 40, length: 120 }] }),
      copyBody({ directions: [{ count: 3, offset: null, length: null }] }),
      // A circular copy missing the angle it divides, and its count.
      copyBody({ kind: 'circular', directions: [], count: 6, sweep: null }),
      copyBody({
        kind: 'circular', directions: [], count: null, sweep: { mode: 'angle', value: 360 },
      }),
    ];

    for (const body of bodies) {
      const result = await postGhost(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.success).toBe(false);
    }
    expect(received).toBeUndefined();
  });
});

describe('feature-ghost route — offset', () => {
  useGhostRoute();

  it('passes the offset dialog through as a resolved number and explicit picks', async () => {
    code = 'const wall = 3';
    const { status, body } = await postGhost({
      feature: 'offset',
      distance: 'wall',
      close: true,
      entities: [{ shapeId: 'e1' }, { shapeId: 'e2' }],
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(received).toEqual({
      feature: 'offset',
      distance: 3,
      close: true,
      entities: [{ shapeId: 'e1' }, { shapeId: 'e2' }],
    });
  });

  it('carries the whole-sketch form as an empty pick list', async () => {
    await postGhost({ feature: 'offset', distance: -2, close: false, entities: [] });

    expect(received).toEqual({
      feature: 'offset',
      distance: -2,
      close: false,
      entities: [],
    });
  });

  it('refuses a missing, zero, or unresolvable-pick body', async () => {
    const bodies = [
      // No distance at all, and one the sign check refuses.
      { feature: 'offset', entities: [{ shapeId: 'e1' }] },
      { feature: 'offset', distance: 0, entities: [{ shapeId: 'e1' }] },
      // Malformed picks: not a list, and an entry without a shapeId.
      { feature: 'offset', distance: 2 },
      { feature: 'offset', distance: 2, entities: [{ index: 1 }] },
    ];

    for (const body of bodies) {
      const result = await postGhost(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.success).toBe(false);
    }
    expect(received).toBeUndefined();
  });

  it('clears the ghost on an expression the file cannot resolve', async () => {
    code = '';
    const { status, body } = await postGhost({
      feature: 'offset',
      distance: 'wall',
      close: false,
      entities: [{ shapeId: 'e1' }],
    });

    // A 200 refusal: the dialog silently clears rather than erroring.
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(received).toBeUndefined();
  });
});

describe('feature-ghost route — fillet2d', () => {
  useGhostRoute();

  it('passes the fillet dialog through as a resolved number and explicit picks', async () => {
    code = 'const r = 3';
    const { status, body } = await postGhost({
      feature: 'fillet2d',
      radius: 'r',
      entities: [{ shapeId: 'e1' }, { shapeId: 'e2' }],
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(received).toEqual({
      feature: 'fillet2d',
      radius: 3,
      entities: [{ shapeId: 'e1' }, { shapeId: 'e2' }],
    });
  });

  it('carries the whole-sketch form as an empty pick list', async () => {
    await postGhost({ feature: 'fillet2d', radius: 4, entities: [] });

    expect(received).toEqual({
      feature: 'fillet2d',
      radius: 4,
      entities: [],
    });
  });

  it('refuses a missing, non-positive, or unresolvable-pick body', async () => {
    const bodies = [
      // No radius at all, and two the sign check refuses.
      { feature: 'fillet2d', entities: [{ shapeId: 'e1' }] },
      { feature: 'fillet2d', radius: 0, entities: [{ shapeId: 'e1' }] },
      { feature: 'fillet2d', radius: -2, entities: [{ shapeId: 'e1' }] },
      // Malformed picks: not a list, and an entry without a shapeId.
      { feature: 'fillet2d', radius: 2 },
      { feature: 'fillet2d', radius: 2, entities: [{ index: 1 }] },
    ];

    for (const body of bodies) {
      const result = await postGhost(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.success).toBe(false);
    }
    expect(received).toBeUndefined();
  });

  it('clears the ghost on an expression the file cannot resolve', async () => {
    code = '';
    const { status, body } = await postGhost({
      feature: 'fillet2d',
      radius: 'r',
      entities: [{ shapeId: 'e1' }],
    });

    // A 200 refusal: the dialog silently clears rather than erroring.
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(received).toBeUndefined();
  });
});
