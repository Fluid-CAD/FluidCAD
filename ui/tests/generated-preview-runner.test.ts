// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyPreviewAnswer, AssemblyPreviewBody } from '../src/api';
import { AssemblyPreviewRunner } from '../src/interactive/generated/preview-runner';
import type { PreviewEdit } from '../src/interactive/generated/preview-requests';
import { PreviewTimings } from '../src/interactive/generated/preview-timings';

// When an assembly dialog's preview asks the server to render (generators
// S6, P3/P4): typing debounces, a drag throttles, the full tier follows
// after the input settles, only the newest answer is heard (superseded ones
// dropped, `ended` kept), "Updating…" shows only for a slow answer, Apply
// settles a full preview first, and every answer's timings are kept.

type Pending = { body: AssemblyPreviewBody; resolve: (answer: AssemblyPreviewAnswer) => void };

let sent: Pending[];
let heard: { answer: AssemblyPreviewAnswer; body: AssemblyPreviewBody }[];
let busy: boolean[];
let width: number | string;
let runner: AssemblyPreviewRunner;

function edit(): PreviewEdit | { error: string } {
  if (width === '') {
    return { error: 'Width is required.' };
  }
  return { mode: 'create', filePath: '/ws/shop.assembly.js', definition: { file: '/ws/crate.assembly.js', exportName: 'crate' }, values: { width: width as number } };
}

function rendered(body: AssemblyPreviewBody, extra: Partial<AssemblyPreviewAnswer> = {}): AssemblyPreviewAnswer {
  return { state: 'rendered', token: body.token, timings: { totalMs: 12.5, evaluateMs: 2, renderMs: 8, sendMs: 1, payloadBytes: 2048 }, generated: { misses: 1, hits: { kept: 2, cached: 0 } }, ...extra } as AssemblyPreviewAnswer;
}

/** Answer the `index`th request sent. */
async function answer(index: number, make: (body: AssemblyPreviewBody) => AssemblyPreviewAnswer = rendered): Promise<void> {
  sent[index].resolve(make(sent[index].body));
  await vi.advanceTimersByTimeAsync(0);
}

const details = () => sent.map(p => `${p.body.detail}:${(p.body.values as { width: number }).width}`);

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  heard = [];
  busy = [];
  width = 40;
  window.__fluidcadPreviewTimings = [];
  runner = new AssemblyPreviewRunner({
    token: () => 'tok-1',
    edit,
    onAnswer: (a, body) => heard.push({ answer: a, body }),
    onBusy: (on) => busy.push(on),
    send: (body) => new Promise(resolve => sent.push({ body, resolve })),
  });
});

afterEach(() => {
  runner.stop();
  vi.useRealTimers();
});

describe('AssemblyPreviewRunner timing', () => {
  it('debounces typing into one preview-tier request, then settles at full after the input rests', async () => {
    for (const value of [1, 12, 120]) {
      width = value;
      runner.changed();
      await vi.advanceTimersByTimeAsync(60);
    }
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.TYPING_MS);
    expect(details()).toEqual(['preview:120']);
    expect(sent[0].body).toMatchObject({ token: 'tok-1', mode: 'create', filePath: '/ws/shop.assembly.js', definition: { exportName: 'crate' } });
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.SETTLE_MS);
    expect(details()).toEqual(['preview:120', 'full:120']);
  });

  it('throttles a drag: one request at once, at most one per interval, the last position always sent', async () => {
    width = 10;
    runner.changed({ continuous: true });
    expect(details()).toEqual(['preview:10']);
    for (const value of [11, 12, 13]) {
      width = value;
      runner.changed({ continuous: true });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(details()).toEqual(['preview:10']);
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.DRAG_MS);
    expect(details()).toEqual(['preview:10', 'preview:13']);
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.SETTLE_MS);
    expect(details()).toEqual(['preview:10', 'preview:13', 'full:13']);
  });

  it('sends nothing for a form that can\'t be read', async () => {
    width = '';
    runner.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(0);
    expect(runner.hasSent).toBe(false);
  });

  it('kick previews at once (a dialog that just opened) and settles at full', async () => {
    runner.kick();
    expect(details()).toEqual(['preview:40']);
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.SETTLE_MS);
    expect(details()).toEqual(['preview:40', 'full:40']);
  });
});

describe('AssemblyPreviewRunner answers', () => {
  it('drops a stale answer: only the newest request is heard', async () => {
    runner.kick();
    width = 60;
    runner.kick();
    await answer(1);
    await answer(0);
    expect(heard.map(h => (h.body.values as { width: number }).width)).toEqual([60]);
    // The stale one is still measured, marked.
    expect(PreviewTimings.entries().map(r => r.stale)).toEqual([false, true]);
  });

  it('drops a superseded answer but hears that the preview ended', async () => {
    runner.kick();
    await answer(0, body => ({ state: 'superseded', token: body.token, reason: 'newer-render' }));
    expect(heard).toHaveLength(0);
    runner.kick();
    await answer(1, body => ({ state: 'superseded', token: body.token, reason: 'ended' }));
    expect(heard.map(h => h.answer.state)).toEqual(['superseded']);
  });

  it('shows Updating… only while the newest request waits longer than a moment', async () => {
    runner.kick();
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.BUSY_MS - 10);
    await answer(0);
    expect(busy).toEqual([]);
    runner.kick();
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.BUSY_MS + 1);
    expect(busy).toEqual([true]);
    await answer(1);
    expect(busy).toEqual([true, false]);
  });

  it('hears nothing once stopped, and sends nothing more', async () => {
    runner.kick();
    runner.stop();
    await answer(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(heard).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('keeps every answer\'s timings in the ring buffer, logged only when asked', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    runner.kick();
    await answer(0);
    expect(PreviewTimings.entries()).toHaveLength(1);
    expect(PreviewTimings.entries()[0]).toMatchObject({ token: 'tok-1', detail: 'preview', state: 'rendered', misses: 1, hits: { kept: 2, cached: 0 }, timings: { totalMs: 12.5 } });
    expect(debug).not.toHaveBeenCalled();
    window.localStorage.setItem(PreviewTimings.LOG_FLAG, '1');
    try {
      runner.kick();
      await answer(1);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0][0])).toMatch(/^\[preview\] preview rendered \d+ms \(server 12\.5: eval 2 render 8 send 1, 0\.00MB\) built 1 kept 2 cached 0$/);
    } finally {
      window.localStorage.removeItem(PreviewTimings.LOG_FLAG);
      debug.mockRestore();
    }
  });

  it('bounds the ring buffer', () => {
    for (let i = 0; i < PreviewTimings.CAPACITY + 5; i++) {
      PreviewTimings.record({ at: i, token: 't', detail: 'full', state: 'rendered', roundTripMs: 1, stale: false });
    }
    expect(PreviewTimings.entries()).toHaveLength(PreviewTimings.CAPACITY);
    expect(PreviewTimings.entries()[0].at).toBe(5);
  });
});

describe('AssemblyPreviewRunner.settle (Apply)', () => {
  it('reuses the last full answer of exactly this edit: nothing more is sent', async () => {
    runner.kick();
    await answer(0);
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.SETTLE_MS);
    await answer(1);
    const settled = await runner.settle();
    expect(settled.ok).toBe(true);
    expect(details()).toEqual(['preview:40', 'full:40']);
  });

  it('sends a full request when the form moved since (the timers stop)', async () => {
    runner.kick();
    await answer(0);
    width = 70;
    runner.changed();
    const settling = runner.settle();
    expect(details()).toEqual(['preview:40', 'full:70']);
    await answer(1);
    expect((await settling).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(details()).toEqual(['preview:40', 'full:70']);
  });

  it('awaits the full request of this edit already on its way', async () => {
    runner.kick();
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.SETTLE_MS);
    expect(details()).toEqual(['preview:40', 'full:40']);
    const settling = runner.settle();
    await answer(1);
    expect((await settling).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('refuses Apply for a result that doesn\'t compile, a refused edit, an ended preview or an unreadable form', async () => {
    let settling = runner.settle();
    await answer(0, body => ({ state: 'compile-error', token: body.token, compileError: { message: 'Unexpected token' } }));
    expect(await settling).toEqual({ ok: false, message: "The result doesn't compile: Unexpected token" });
    width = 41;
    settling = runner.settle();
    await answer(1, body => ({ state: 'refused', token: body.token, status: 403, reason: 'read-only', code: 'generated-read-only' }));
    expect(await settling).toEqual({ ok: false, message: 'read-only' });
    width = 42;
    settling = runner.settle();
    await answer(2, body => ({ state: 'superseded', token: body.token, reason: 'ended' }));
    expect(await settling).toEqual({ ok: false, message: 'The preview ended.' });
    width = '';
    expect(await runner.settle()).toEqual({ ok: false, message: 'Width is required.' });
  });

  it('lets Apply go on when a later render will show the editor\'s code (newer-render)', async () => {
    const settling = runner.settle();
    await answer(0, body => ({ state: 'superseded', token: body.token, reason: 'newer-render' }));
    expect(await settling).toEqual({ ok: true, answer: null });
  });
});
