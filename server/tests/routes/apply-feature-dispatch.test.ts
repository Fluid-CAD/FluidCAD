import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';

// The preflight + ack layer around apply-feature-edit dispatch: a spec that
// cannot transform against the server's copy of the file is refused before it
// reaches the editor; a delivered spec answers with the editor round-trip's
// real outcome instead of fire-and-forget success; a round-trip that never
// arrives reports a timeout instead of silence.
let server: http.Server;
let baseUrl: string;

let relayed: any[];
/** What sendToExtension reports: true = a host process received the message. */
let delivered: boolean;

const CODE = [
  `import { sketch, circle, line, point } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => {`,
  `  circle([0, 0], 80)`,
  `  point([0, 60])`,
  `  line([0, 0], [135, 30])`,
  `})`,
  ``,
].join('\n');

/** A spec the transform accepts against CODE (the walking-skeleton fillet). */
const GOOD_SPEC = {
  feature: 'fillet',
  value: 4,
  filePath: '/ws/m.fluid.js',
  producers: [
    { line: 4, column: 2, featureType: 'circle', nameHint: 'r', bind: true },
    { line: 6, column: 2, featureType: 'line', nameHint: 'l', bind: true },
  ],
  parts: [
    { producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" },
    { producer: 1, accessor: '', indices: null, filterArgs: null },
  ],
  imports: [],
};

/** Same statement lines, wrong featureType — the transform refuses this. */
const BAD_SPEC = {
  ...GOOD_SPEC,
  producers: [
    { line: 4, column: 2, featureType: 'line', nameHint: 'l', bind: true },
    { line: 6, column: 2, featureType: 'line', nameHint: 'l', bind: true },
  ],
};

let currentSynthesis: any;

const fakeServer = {
  getCurrentCode: () => CODE,
  getCurrentFileName: () => '/ws/m.fluid.js',
  getParamDefinitions: () => [],
  synthesizeSketchApplyFeature: () => currentSynthesis,
};

function synthesisFor(spec: unknown) {
  return {
    ok: true,
    spec,
    preview: "fillet(4, r.edge('top'), l)",
    args: "r.edge('top'), l",
    alternatives: [],
  };
}

async function postApply(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/apply-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature: 'fillet', value: 4, sketchEntities: [{ shapeId: 'e1' }] }),
  });
  return { status: res.status, body: await res.json() };
}

/** The host's round-trip: run the relayed spec through /code/apply-feature. */
async function postRoundTrip(code: string, spec: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/code/apply-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, spec }),
  });
  return { status: res.status, body: await res.json() };
}

async function untilRelayed(): Promise<any> {
  for (let i = 0; i < 100; i++) {
    if (relayed.length > 0) {
      return relayed[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('nothing was relayed to the extension');
}

describe('apply-feature dispatch preflight and ack', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createApplyFeatureRouter(
      fakeServer as any,
      (msg) => {
        relayed.push(msg);
        return delivered;
      },
      { ackTimeoutMs: 300 },
    ));

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    relayed = [];
    delivered = true;
    currentSynthesis = synthesisFor(GOOD_SPEC);
  });

  it('preflight refuses a spec the transform rejects, before any dispatch', async () => {
    currentSynthesis = synthesisFor(BAD_SPEC);
    const { status, body } = await postApply();
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('expected a line()-producing call');
    expect(relayed).toEqual([]);
  });

  it('answers success once the editor round-trip confirms the transform', async () => {
    const applied = postApply();
    const msg = await untilRelayed();
    expect(msg.type).toBe('apply-feature-edit');
    expect(typeof msg.spec.editId).toBe('string');

    const roundTrip = await postRoundTrip(CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain("fillet(4, r.edge('top'), l)");

    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('answers the transform error when the editor buffer drifted', async () => {
    const applied = postApply();
    const msg = await untilRelayed();

    // The host's buffer no longer holds the statements the spec addresses.
    const drifted = CODE.replace('circle([0, 0], 80)', 'line([0, 0], [30, 0])');
    const roundTrip = await postRoundTrip(drifted, msg.spec);
    expect(roundTrip.body.error).toContain('expected a circle()-producing call');

    const { status, body } = await applied;
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('expected a circle()-producing call');
  });

  it('reports a timeout when the editor never round-trips', async () => {
    const { status, body } = await postApply();
    expect(status).toBe(504);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('did not apply the edit');
  });

  it('keeps the legacy immediate success when no host process is attached', async () => {
    delivered = false;
    const { status, body } = await postApply();
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });
});
