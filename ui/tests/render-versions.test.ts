import { describe, expect, it } from 'vitest';
import { RenderVersions } from '../src/render-versions';

// The page's view of the server's render lifecycle: `after(v)` settles once a
// pass newer than v has ended or failed — never on a start, never on an
// older pass arriving late.

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('RenderVersions', () => {
  it('resolves at once when a newer pass has already settled', async () => {
    const versions = new RenderVersions();
    versions.note({ version: 4, state: 'end' });
    expect(versions.settled).toBe(4);
    expect(await settled(versions.after(3))).toBe(true);
  });

  it('waits for a pass newer than the one asked about', async () => {
    const versions = new RenderVersions();
    const wait = versions.after(3);
    versions.note({ version: 3, state: 'end' });
    expect(await settled(wait)).toBe(false);
    versions.note({ version: 4, state: 'start' });
    expect(await settled(wait)).toBe(false);
    versions.note({ version: 4, state: 'end' });
    expect(await settled(wait)).toBe(true);
  });

  it('counts a compile failure as settled — the view is not going to change', async () => {
    const versions = new RenderVersions();
    const wait = versions.after(3);
    versions.note({ version: 4, state: 'error' });
    expect(await settled(wait)).toBe(true);
  });

  it('is settled by a later pass when the next one was superseded', async () => {
    const versions = new RenderVersions();
    const wait = versions.after(3);
    versions.note({ version: 4, state: 'start' });
    versions.note({ version: 5, state: 'start' });
    versions.note({ version: 5, state: 'end' });
    expect(await settled(wait)).toBe(true);
    expect(versions.settled).toBe(5);
  });

  it('ignores an older pass settling late', () => {
    const versions = new RenderVersions();
    versions.note({ version: 6, state: 'end' });
    versions.note({ version: 2, state: 'end' });
    expect(versions.settled).toBe(6);
  });
});
