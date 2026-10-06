import path from 'path';
import { describe, expect, it } from 'vitest';
import { dialogDefaultPath } from '../src/dialog-directory';

const start = path.join('/home/you', 'cad');

describe('dialogDefaultPath', () => {
  it('opens a dialog that names no path in the start folder', () => {
    expect(dialogDefaultPath(undefined, start)).toBe(start);
  });

  it('places a suggested file name in the start folder', () => {
    expect(dialogDefaultPath('bracket.step', start)).toBe(path.join(start, 'bracket.step'));
  });

  it('keeps a path the caller gave in full', () => {
    const asked = path.join('/srv', 'exports', 'bracket.step');
    expect(dialogDefaultPath(asked, start)).toBe(asked);
  });

  it('leaves the request alone when there is no folder to start in yet', () => {
    expect(dialogDefaultPath(undefined, null)).toBeUndefined();
    expect(dialogDefaultPath('bracket.step', null)).toBe('bracket.step');
  });
});
