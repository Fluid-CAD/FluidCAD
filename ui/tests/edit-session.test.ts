import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneObjectRender } from '../src/types';

// The edit dialog's view session. Opening a feature dialog from the timeline
// also pauses the build after the statement — a source edit whose render
// takes as long as the model does to rebuild. The session used to roll the
// view back at once and race that render: the ghost drew, the late render
// cleared it, the rollback was re-issued and the ghost drew again. With the
// pause acknowledged, the rollback waits for the render the pause triggers
// and goes out once.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  rollback: vi.fn(),
  continueBreakpoint: vi.fn(),
}));

const target = { filePath: '/ws/box.part.js', line: 5, column: 1 };

function scene(rows: { type: string; line: number }[]): SceneObjectRender[] {
  return rows.map((row, id) => ({
    id: String(id), type: row.type,
    sourceLocation: { filePath: target.filePath, line: row.line, column: 1 },
  } as unknown as SceneObjectRender));
}

/** sketch, extrude (the edited row, index 1), fillet. */
const FULL = scene([{ type: 'sketch', line: 3 }, { type: 'extrude', line: 5 }, { type: 'fillet', line: 7 }]);

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

async function load() {
  vi.resetModules();
  const api = await import('../src/api');
  const { EditSession } = await import('../src/interactive/edit-session');
  const { renderVersions } = await import('../src/render-versions');
  const rollback = api.rollback as unknown as ReturnType<typeof vi.fn>;
  rollback.mockClear();
  return { EditSession, renderVersions, rollback };
}

function info(pause?: Promise<{ changed: boolean; renderVersion: number } | null>) {
  return { target, index: 1, type: 'extrude', expectedStatement: 'extrude(5)', ...(pause ? { pause } : {}) };
}

describe('EditSession without an acknowledged pause', () => {
  it('rolls back at once and is settled at the boundary', async () => {
    const { EditSession, rollback } = await load();
    const session = new EditSession();
    expect(session.settled).toBe(true);
    session.begin(info());
    expect(rollback).toHaveBeenCalledWith(0);
    expect(session.settled).toBe(false);
    expect(session.onSceneRendered(FULL, 0, true)).toBe('boundary');
    expect(session.settled).toBe(true);
  });

  it('re-asserts the rollback when a full render lands at the boundary', async () => {
    const { EditSession, rollback } = await load();
    const session = new EditSession();
    session.begin(info());
    session.onSceneRendered(FULL, 0, true);
    expect(session.onSceneRendered(FULL, 2, false)).toBe('waiting');
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(session.settled).toBe(false);
  });
});

describe('EditSession hand-off', () => {
  it('lifts the stop on a cancel but not on a hand-off — the next gesture\'s pause lifted it', async () => {
    const { EditSession } = await load();
    const api = await import('../src/api');
    const continueBreakpoint = api.continueBreakpoint as unknown as ReturnType<typeof vi.fn>;
    continueBreakpoint.mockClear();
    const handedOff = new EditSession();
    handedOff.begin(info());
    handedOff.end('handoff');
    expect(continueBreakpoint).not.toHaveBeenCalled();
    const cancelled = new EditSession();
    cancelled.begin(info());
    cancelled.end('cancel');
    expect(continueBreakpoint).toHaveBeenCalledTimes(1);
  });
});

describe('EditSession with an acknowledged pause', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('holds the rollback until the render the pause triggered has settled', async () => {
    const { EditSession, renderVersions, rollback } = await load();
    let ack!: (outcome: { changed: boolean; renderVersion: number }) => void;
    const pause = new Promise<{ changed: boolean; renderVersion: number }>(resolve => { ack = resolve; });
    const session = new EditSession();
    session.begin(info(pause));
    expect(rollback).not.toHaveBeenCalled();

    // The double-click's own row rollback lands first — not the boundary.
    expect(session.onSceneRendered(FULL, 1, true)).toBe('waiting');
    expect(rollback).not.toHaveBeenCalled();

    ack({ changed: true, renderVersion: 7 });
    await flush();
    expect(rollback).not.toHaveBeenCalled();

    // The pause's full render (paused after the statement) — still nothing.
    renderVersions.note({ version: 8, state: 'start' });
    expect(session.onSceneRendered(FULL, 2, false)).toBe('waiting');
    expect(rollback).not.toHaveBeenCalled();
    expect(session.settled).toBe(false);

    renderVersions.note({ version: 8, state: 'end' });
    await flush();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith(0);

    expect(session.onSceneRendered(FULL, 0, true)).toBe('boundary');
    expect(session.settled).toBe(true);
  });

  it('rolls back right after the ack when the pause changed nothing', async () => {
    const { EditSession, rollback } = await load();
    const session = new EditSession();
    session.begin(info(Promise.resolve({ changed: false, renderVersion: 7 })));
    expect(rollback).not.toHaveBeenCalled();
    await flush();
    expect(rollback).toHaveBeenCalledWith(0);
  });

  it('rolls back right after a refused or unanswered pause', async () => {
    const { EditSession, rollback } = await load();
    const session = new EditSession();
    session.begin(info(Promise.resolve(null)));
    await flush();
    expect(rollback).toHaveBeenCalledWith(0);
  });

  it('rolls back right after the ack when that render already settled', async () => {
    const { EditSession, renderVersions, rollback } = await load();
    renderVersions.note({ version: 8, state: 'end' });
    const session = new EditSession();
    session.begin(info(Promise.resolve({ changed: true, renderVersion: 7 })));
    await flush();
    expect(rollback).toHaveBeenCalledWith(0);
  });

  it('never rolls back a session that ended before its pause settled', async () => {
    const { EditSession, renderVersions, rollback } = await load();
    const session = new EditSession();
    session.begin(info(Promise.resolve({ changed: true, renderVersion: 7 })));
    await flush();
    session.end('cancel');
    renderVersions.note({ version: 8, state: 'end' });
    await flush();
    expect(rollback).not.toHaveBeenCalled();
    expect(session.settled).toBe(true);
  });

  it('never rolls back for a session replaced by a newer one', async () => {
    const { EditSession, renderVersions, rollback } = await load();
    const session = new EditSession();
    session.begin(info(Promise.resolve({ changed: true, renderVersion: 7 })));
    await flush();
    session.end('continue');
    session.begin(info());
    expect(rollback).toHaveBeenCalledTimes(1);
    renderVersions.note({ version: 8, state: 'end' });
    await flush();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('still heals index drift and reports a vanished statement while pending', async () => {
    const { EditSession, rollback } = await load();
    const session = new EditSession();
    session.begin(info(new Promise(() => undefined)));
    const shifted = scene([{ type: 'sketch', line: 3 }, { type: 'plane', line: 4 }, { type: 'extrude', line: 5 }]);
    expect(session.onSceneRendered(shifted, 2, false)).toBe('waiting');
    expect(session.boundary?.index).toBe(2);
    expect(session.onSceneRendered(scene([{ type: 'sketch', line: 3 }]), 0, false)).toBe('gone');
    expect(rollback).not.toHaveBeenCalled();
  });
});
