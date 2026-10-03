import { describe, expect, it, vi } from 'vitest';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

const CODE = "import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\n";
const FILE = '/model.part.js';

function harness() {
  const server = { getCurrentCode: () => CODE, getCurrentFileName: () => FILE } as unknown as FluidCadServer;
  const dispatch = vi.fn(async (res, spec, success) => {
    const result = await applyFeatureEdit(CODE, spec);
    if (result.error) res.status(422).json({ success: false, reason: result.error });
    else res.json(success);
  });
  const router = createTimelineRouter(server, vi.fn(), vi.fn(), { dispatcher: { dispatch } as unknown as FeatureEditDispatcher });
  const handler = router.stack.find(layer => layer.route?.path === '/timeline-breakpoint')!.route.stack[0].handle;
  async function post(body: unknown) {
    const res = { statusCode: 200, body: undefined as any,
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { this.body = value; return this; } };
    await handler({ body } as any, res as any, vi.fn());
    return res;
  }
  return { post, dispatch };
}

describe('timeline breakpoint route', () => {
  it('hands an atomic move to the existing acknowledged dispatcher', async () => {
    const h = harness();
    const response = await h.post({ filePath: FILE, before: { line: 4, column: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true });
    const spec = h.dispatch.mock.calls[0][1];
    expect(spec.filePath).toBe(FILE);
    expect(spec.timelineBreakpoint.before).toEqual({ line: 4, column: 1 });
    expect(spec.timelineBreakpoint.sourceHash).toHaveLength(64);
  });

  it('uses the same edit for continue-to-end', async () => {
    const h = harness();
    expect((await h.post({ filePath: FILE, before: null })).body).toEqual({ success: true });
    const spec = h.dispatch.mock.calls[0][1];
    expect((await applyFeatureEdit(CODE, spec)).newCode).not.toContain('breakpoint();');
  });

  it.each([undefined, {}, { before: null }, { filePath: FILE },
    { filePath: FILE, before: { line: -1, column: 1 } },
    { filePath: FILE, before: { line: 1.5, column: 1 } },
    { filePath: FILE, before: { line: 1, column: 0 } }])('rejects malformed targets %j', async body => {
    const h = harness();
    expect((await h.post(body)).statusCode).toBe(400);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('refuses another document and reports a failed transform', async () => {
    const h = harness();
    expect((await h.post({ filePath: '/other.part.js', before: null })).statusCode).toBe(422);
    expect(h.dispatch).not.toHaveBeenCalled();
    const failed = await h.post({ filePath: FILE, before: { line: 1, column: 1 } });
    expect(failed.statusCode).toBe(422);
    expect(failed.body.success).toBe(false);
  });
});
