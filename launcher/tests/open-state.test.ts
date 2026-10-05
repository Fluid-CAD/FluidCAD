import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, pageStateOf, projectOf, transition, type OpenState, type OpenEvent } from '../src/projects/open-state';

const bracket = { path: '/home/you/cad/bracket', name: 'bracket' };
const lantern = { path: '/home/you/cad/lantern', name: 'lantern' };

function run(...events: OpenEvent[]): OpenState {
  return events.reduce(transition, INITIAL_STATE);
}

describe('opening a project', () => {
  it('opens a project: home → opening → project', () => {
    const opening = run({ type: 'open', project: bracket });
    expect(opening).toEqual({ phase: 'opening', attempt: 1, project: bracket, status: { step: 'resolving' } });
    const downloading = transition(opening, {
      type: 'progress',
      attempt: 1,
      status: { step: 'downloading', version: '0.0.42', receivedBytes: 5, totalBytes: 10 },
    });
    expect(downloading).toMatchObject({ phase: 'opening', status: { step: 'downloading', receivedBytes: 5 } });
    expect(transition(downloading, { type: 'ready', attempt: 1, url: 'http://127.0.0.1:3100' })).toEqual({
      phase: 'project',
      attempt: 1,
      project: bracket,
      url: 'http://127.0.0.1:3100',
    });
  });

  it('comes back home on cancel, from opening or from a failure', () => {
    expect(run({ type: 'open', project: bracket }, { type: 'cancel' })).toEqual({ phase: 'home', attempt: 1 });
    expect(run({ type: 'open', project: bracket }, { type: 'fail', attempt: 1, message: 'no' }, { type: 'cancel' })).toEqual({
      phase: 'home',
      attempt: 1,
    });
  });

  it('retries a failure as a new attempt of the same project', () => {
    const failed = run({ type: 'open', project: bracket }, { type: 'fail', attempt: 1, message: 'exit 1' });
    expect(failed).toEqual({ phase: 'failed', attempt: 1, project: bracket, message: 'exit 1' });
    expect(transition(failed, { type: 'retry' })).toEqual({ phase: 'opening', attempt: 2, project: bracket, status: { step: 'resolving' } });
  });

  it('lets a failed window open another project', () => {
    const failed = run({ type: 'open', project: bracket }, { type: 'fail', attempt: 1, message: 'x' });
    expect(transition(failed, { type: 'open', project: lantern })).toMatchObject({ phase: 'opening', attempt: 2, project: lantern });
  });

  it('ignores what a cancelled or replaced open reports afterwards', () => {
    const cancelled = run({ type: 'open', project: bracket }, { type: 'cancel' });
    expect(transition(cancelled, { type: 'ready', attempt: 1, url: 'http://x' })).toBe(cancelled);
    expect(transition(cancelled, { type: 'fail', attempt: 1, message: 'x' })).toBe(cancelled);

    const second = transition(cancelled, { type: 'open', project: lantern });
    expect(second).toMatchObject({ attempt: 2, project: lantern });
    expect(transition(second, { type: 'ready', attempt: 1, url: 'http://stale' })).toBe(second);
    expect(transition(second, { type: 'progress', attempt: 1, status: { step: 'resolving' } })).toBe(second);
  });

  it('holds one project at a time: an open while busy changes nothing', () => {
    const opening = run({ type: 'open', project: bracket });
    expect(transition(opening, { type: 'open', project: lantern })).toBe(opening);
    const project = transition(opening, { type: 'ready', attempt: 1, url: 'http://x' });
    expect(transition(project, { type: 'open', project: lantern })).toBe(project);
  });

  it('closes a project back to the start screen', () => {
    const project = run({ type: 'open', project: bracket }, { type: 'ready', attempt: 1, url: 'http://x' });
    expect(transition(project, { type: 'close-project' })).toEqual({ phase: 'home', attempt: 1 });
    expect(transition(INITIAL_STATE, { type: 'close-project' })).toBe(INITIAL_STATE);
  });

  it('reopens a project after a pin change, as a new attempt in the same window', () => {
    const project = run({ type: 'open', project: bracket }, { type: 'ready', attempt: 1, url: 'http://x' });
    expect(transition(project, { type: 'reopen' })).toEqual({ phase: 'opening', attempt: 2, project: bracket, status: { step: 'resolving' } });
    expect(transition(INITIAL_STATE, { type: 'reopen' })).toBe(INITIAL_STATE);
  });

  it('starts a new project at its set-up step, and a retry of it there too', () => {
    const creating = run({ type: 'open', project: bracket, status: { step: 'creating' } });
    expect(creating).toEqual({ phase: 'opening', attempt: 1, project: bracket, status: { step: 'creating' } });
    const failed = transition(creating, { type: 'fail', attempt: 1, message: 'init failed' });
    expect(transition(failed, { type: 'retry', status: { step: 'creating' } })).toMatchObject({ attempt: 2, status: { step: 'creating' } });
  });

  it('changes nothing for progress that says nothing new', () => {
    const opening = run({ type: 'open', project: bracket });
    expect(transition(opening, { type: 'progress', attempt: 1, status: { step: 'resolving' } })).toBe(opening);
    const downloading = { step: 'downloading' as const, version: '0.0.42', receivedBytes: 5, totalBytes: 10 };
    const moved = transition(opening, { type: 'progress', attempt: 1, status: downloading });
    expect(transition(moved, { type: 'progress', attempt: 1, status: { ...downloading } })).toBe(moved);
  });

  it('never goes from home straight to a project or a failure', () => {
    expect(transition(INITIAL_STATE, { type: 'ready', attempt: 0, url: 'http://x' })).toBe(INITIAL_STATE);
    expect(transition(INITIAL_STATE, { type: 'fail', attempt: 0, message: 'x' })).toBe(INITIAL_STATE);
    expect(transition(INITIAL_STATE, { type: 'retry' })).toBe(INITIAL_STATE);
    expect(transition(INITIAL_STATE, { type: 'cancel' })).toBe(INITIAL_STATE);
  });
});

describe('what the start page is told', () => {
  it('is the phase and project, never the engine URL', () => {
    expect(pageStateOf(INITIAL_STATE)).toEqual({ phase: 'home' });
    const opening = run({ type: 'open', project: bracket });
    expect(pageStateOf(opening)).toEqual({ phase: 'opening', project: bracket, status: { step: 'resolving' } });
    const failed = transition(opening, { type: 'fail', attempt: 1, message: 'x' });
    expect(pageStateOf(failed)).toEqual({ phase: 'failed', project: bracket, message: 'x' });
    expect(pageStateOf(transition(opening, { type: 'ready', attempt: 1, url: 'http://x' }))).toBeNull();
  });

  it('knows which project a window holds: opening it, failed to, or running it', () => {
    expect(projectOf(INITIAL_STATE)).toBeNull();
    const opening = run({ type: 'open', project: bracket });
    expect(projectOf(opening)).toEqual(bracket);
    expect(projectOf(transition(opening, { type: 'fail', attempt: 1, message: 'x' }))).toEqual(bracket);
    expect(projectOf(transition(opening, { type: 'ready', attempt: 1, url: 'http://x' }))).toEqual(bracket);
    expect(projectOf(transition(opening, { type: 'cancel' }))).toBeNull();
  });
});
