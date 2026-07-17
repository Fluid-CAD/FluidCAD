import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createTextRouter } from '../../src/routes/text.ts';

// The route works on the lib/dist module graph (the one the running server
// shares with executed models), so this test initializes that graph — not
// the lib-source one the rest of the suite uses.
import { init } from '../../../lib/dist/index.js';

let server: http.Server;
let baseUrl: string;

const XY_PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
};

function postPreview(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/text-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('text routes', () => {
  beforeAll(async () => {
    await init();

    const app = express();
    app.use(express.json());
    app.use('/api', createTextRouter());

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

  it('GET /api/fonts lists font families sorted', async () => {
    const res = await fetch(`${baseUrl}/api/fonts`);
    expect(res.status).toBe(200);
    const body = await res.json() as { families: string[] };
    expect(Array.isArray(body.families)).toBe(true);
    expect(body.families.length).toBeGreaterThan(0);
    const sorted = [...body.families].sort((a, b) => a.localeCompare(b));
    expect(body.families).toEqual(sorted);
  });

  it('POST /api/text-preview rejects a missing text string', async () => {
    const res = await postPreview({ position: [0, 0], plane: XY_PLANE, options: {} });
    expect(res.status).toBe(400);
  });

  it('POST /api/text-preview rejects a malformed position', async () => {
    const res = await postPreview({ text: 'Hi', position: [0], plane: XY_PLANE, options: {} });
    expect(res.status).toBe(400);
  });

  it('POST /api/text-preview rejects an incomplete plane', async () => {
    const res = await postPreview({
      text: 'Hi',
      position: [0, 0],
      plane: { origin: XY_PLANE.origin },
      options: {},
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/text-preview rejects a non-positive size', async () => {
    const res = await postPreview({
      text: 'Hi',
      position: [0, 0],
      plane: XY_PLANE,
      options: { size: 0 },
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/text-preview returns outline polylines on the plane', async () => {
    const res = await postPreview({
      text: 'Hi',
      position: [5, -3],
      plane: XY_PLANE,
      options: { size: 12, weight: 700, align: 'left', lineSpacing: 1, letterSpacing: 0 },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { polylines: number[][] };
    expect(body.polylines.length).toBeGreaterThan(0);

    for (const line of body.polylines) {
      // Flat xyz runs with at least two points each.
      expect(line.length % 3).toBe(0);
      expect(line.length).toBeGreaterThanOrEqual(6);
      // Everything lies in the XY plane.
      for (let i = 2; i < line.length; i += 3) {
        expect(Math.abs(line[i])).toBeLessThan(1e-6);
      }
    }

    // The glyphs start at the requested anchor: every x is right of it and
    // some y reaches above the baseline.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const line of body.polylines) {
      for (let i = 0; i < line.length; i += 3) {
        xs.push(line[i]);
        ys.push(line[i + 1]);
      }
    }
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(5 - 1);
    expect(Math.max(...ys)).toBeGreaterThan(-3);
  });

  it('POST /api/text-preview returns no polylines for whitespace text', async () => {
    const res = await postPreview({
      text: ' ',
      position: [0, 0],
      plane: XY_PLANE,
      options: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { polylines: number[][] };
    expect(body.polylines).toEqual([]);
  });
});
