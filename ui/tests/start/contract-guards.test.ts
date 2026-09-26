import { describe, expect, it } from 'vitest';
import {
  ContractError,
  checkApplyPinResult,
  checkEngineOptions,
  checkFeed,
  checkHello,
  checkProjectList,
  checkUpgradePreview,
  checkWindowState,
} from '../../src/start/contract-guards';

// The page validates every reply from the shell once, on the way in. A reply
// of the wrong shape must fail loudly and say which field, never render.

const project = {
  path: '/home/you/cad/bracket',
  name: 'bracket',
  engine: '0.0.45',
  engineSource: 'pin',
  latest: true,
  upgradeTo: null,
  lastOpenedAt: '2026-09-26T10:00:00.000Z',
  open: false,
  thumbnail: 'fluidcad-app://thumbnails/0123456789abcdef0123456789abcdef01234567.png?v=1',
};

function contractError(fn: () => unknown): ContractError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContractError);
    return err as ContractError;
  }
  throw new Error('expected a ContractError');
}

describe('contract guards', () => {
  it('accepts a well-formed reply and copies only the fields the page reads', () => {
    const hello = checkHello({ ok: true, appVersion: '0.0.45', platform: 'linux', home: '/home/you', extra: 1 });
    expect(hello).toEqual({ ok: true, appVersion: '0.0.45', platform: 'linux', home: '/home/you' });
    expect(checkProjectList({ projects: [project] }).projects[0]).toEqual(project);
  });

  it('names the field that is wrong', () => {
    const err = contractError(() => checkProjectList({ projects: [project, { ...project, engine: 42 }] }));
    expect(err.where).toBe('list().projects[1].engine');
    expect(err.message).toContain('expected a string');
  });

  it('rejects a missing field and a non-object reply', () => {
    expect(contractError(() => checkHello({ ok: true, appVersion: '1', platform: 'linux' })).where).toBe('hello().home');
    expect(contractError(() => checkFeed(null)).where).toBe('feed()');
    expect(contractError(() => checkFeed({ tutorials: {}, notifications: [] })).where).toBe('feed().tutorials');
  });

  it('checks enumerations', () => {
    const err = contractError(() => checkProjectList({ projects: [{ ...project, engineSource: 'npm' }] }));
    expect(err.where).toBe('list().projects[0].engineSource');
    expect(checkProjectList({ projects: [{ ...project, engineSource: null }] }).projects[0].engineSource).toBeNull();
  });

  it('checks each window state by its phase', () => {
    expect(checkWindowState({ phase: 'home' })).toEqual({ phase: 'home' });
    const opening = {
      phase: 'opening',
      project: { path: '/p', name: 'p' },
      status: { step: 'downloading', version: '0.0.42', receivedBytes: 10, totalBytes: null },
    };
    expect(checkWindowState(opening)).toEqual(opening);
    expect(checkWindowState({ phase: 'failed', project: { path: '/p', name: 'p' }, message: 'no' })).toEqual({
      phase: 'failed',
      project: { path: '/p', name: 'p' },
      message: 'no',
    });
    expect(contractError(() => checkWindowState({ phase: 'project' })).where).toBe('windowState().phase');
    expect(
      contractError(() => checkWindowState({ phase: 'opening', project: { path: '/p', name: 'p' }, status: { step: 'starting', version: '1', source: 'npm' } })).where,
    ).toBe('windowState().status.source');
    expect(
      contractError(() => checkWindowState({ ...opening, status: { ...opening.status, receivedBytes: Number.NaN } })).where,
    ).toBe('windowState().status.receivedBytes');
  });

  it('allows the optional halves of a preview and a pin result', () => {
    expect(checkUpgradePreview({ error: 'nope' })).toEqual({ diff: undefined, error: 'nope' });
    expect(checkApplyPinResult({ ok: true })).toEqual({ ok: true, error: undefined });
    const diff = { from: '0.0.44', to: '0.0.45', identical: false, skipped: [], models: [{ file: 'a.part.js', status: 'changed', notes: ['x'] }] };
    expect(checkUpgradePreview({ diff }).diff).toEqual(diff);
    expect(contractError(() => checkUpgradePreview({ diff: { ...diff, models: [{ file: 'a', status: 'moved', notes: [] }] } })).where).toBe(
      'previewUpgrade().diff.models[0].status',
    );
  });

  it('checks the engine options the dialog lists', () => {
    const options = { current: '0.0.42', currentSource: 'pin', latest: '0.0.45', choices: [{ version: '0.0.45', builtin: true, installed: true }] };
    expect(checkEngineOptions(options)).toEqual(options);
    expect(contractError(() => checkEngineOptions({ ...options, choices: [{ version: '0.0.45', builtin: 'yes', installed: true }] })).where).toBe(
      'engineOptions().choices[0].builtin',
    );
  });
});
