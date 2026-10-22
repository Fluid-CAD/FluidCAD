// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplyRunner } from '../src/interactive/create-feature/apply-runner';

// The shared preview runner holds its previews (and the ghost chained onto
// them) while the dialog's edit session is not at its boundary: a ghost
// drawn against a view a render is about to replace only gets cleared and
// drawn again. The service re-schedules at the boundary.

function panel() {
  return { setPreview: vi.fn(), setMessage: vi.fn(), setApplyEnabled: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ApplyRunner preview gate', () => {
  it('previews and ghosts when the session is settled', async () => {
    const send = vi.fn(async () => ({ success: true, preview: 'extrude(5)' }));
    const ghost = { fetch: vi.fn(async () => [{ meshes: [] }]), apply: vi.fn() };
    const runner = new ApplyRunner({
      panel: panel(), isArmed: () => true, session: { settled: true },
      build: () => ({ distance: 5 }), send, onApplied: vi.fn(), failMessage: () => 'no', ghost,
    });
    runner.schedulePreview();
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ghost.apply).toHaveBeenCalledWith([{ meshes: [] }]);
  });

  it('holds everything while the session is off its boundary', async () => {
    const send = vi.fn(async () => ({ success: true, preview: 'extrude(5)' }));
    const ghost = { fetch: vi.fn(async () => []), apply: vi.fn() };
    const session = { settled: false };
    const runner = new ApplyRunner({
      panel: panel(), isArmed: () => true, session,
      build: () => ({ distance: 5 }), send, onApplied: vi.fn(), failMessage: () => 'no', ghost,
    });
    runner.schedulePreview();
    await vi.advanceTimersByTimeAsync(300);
    expect(send).not.toHaveBeenCalled();
    expect(ghost.apply).not.toHaveBeenCalled();

    // The boundary lands and the service re-schedules — now it draws.
    session.settled = true;
    runner.schedulePreview();
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops a preview whose view moved off the boundary during the debounce', async () => {
    const send = vi.fn(async () => ({ success: true, preview: 'extrude(5)' }));
    const session = { settled: true };
    const runner = new ApplyRunner({
      panel: panel(), isArmed: () => true, session,
      build: () => ({ distance: 5 }), send, onApplied: vi.fn(), failMessage: () => 'no',
    });
    runner.schedulePreview();
    session.settled = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a dialog without a session as settled', async () => {
    const send = vi.fn(async () => ({ success: true, preview: 'copy(…)' }));
    const runner = new ApplyRunner({
      panel: panel(), isArmed: () => true,
      build: () => ({}), send, onApplied: vi.fn(), failMessage: () => 'no',
    });
    runner.schedulePreview();
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('applies regardless of the gate', async () => {
    const send = vi.fn(async () => ({ success: true }));
    const onApplied = vi.fn();
    const runner = new ApplyRunner({
      panel: panel(), isArmed: () => true, session: { settled: false },
      build: () => ({}), send, onApplied, failMessage: () => 'no',
    });
    await runner.apply();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalled();
  });
});
