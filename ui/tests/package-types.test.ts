import { afterEach, describe, expect, it, vi } from 'vitest';

// The pinned packages' sources in the in-page editor's language service:
// registered under file:///node_modules/@scope/name/…, registered again only
// when the server's key changes, the previous files disposed first, and the
// latest refresh wins.

import { PackageTypes } from '../src/editor/package-types';
import type { PackageTypesPayload } from '../src/editor/editor-api';

function payload(key: string, names: string[]): PackageTypesPayload {
  const files = names.map((name) => ({ uri: `file:///node_modules/@acme/kit/${name}`, content: `// ${name}` }));
  return { key, files, bytes: files.reduce((sum, file) => sum + file.content.length, 0) };
}

/** Monaco's `addExtraLib`, recording what is registered now. */
class FakeLibs {
  readonly live = new Map<string, string>();
  readonly added: string[] = [];
  register = (content: string, uri: string) => {
    this.live.set(uri, content);
    this.added.push(uri);
    return { dispose: () => this.live.delete(uri) };
  };
}

let restart = vi.fn();

afterEach(() => {
  vi.restoreAllMocks();
  restart = vi.fn();
});

describe('the packages\' types in the editor', () => {
  it('registers each pinned package\'s files, and nothing again while the key stays', async () => {
    const libs = new FakeLibs();
    const fetch = vi.fn(async () => payload('@acme/kit@0.1.0:/lib/a', ['index.js', 'standoff.feature.js']));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const types = new PackageTypes(libs.register, fetch, restart);

    await types.refresh();
    expect([...libs.live.keys()]).toEqual([
      'file:///node_modules/@acme/kit/index.js',
      'file:///node_modules/@acme/kit/standoff.feature.js',
    ]);
    await types.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(libs.added).toHaveLength(2);
    expect(types.registered).toBe(2);
    // The language service restarted once, for the one change.
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('replaces the files when the pins move, and drops them all when nothing is pinned', async () => {
    const libs = new FakeLibs();
    const answers = [
      payload('@acme/kit@0.1.0:/lib/a', ['index.js', 'old.feature.js']),
      payload('@acme/kit@0.1.0:/project/a', ['index.js', 'new.feature.js']),
      payload('', []),
    ];
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const types = new PackageTypes(libs.register, async () => answers.shift()!, restart);

    await types.refresh();
    await types.refresh();
    expect([...libs.live.keys()]).toEqual([
      'file:///node_modules/@acme/kit/index.js',
      'file:///node_modules/@acme/kit/new.feature.js',
    ]);
    await types.refresh();
    expect(libs.live.size).toBe(0);
    expect(types.registered).toBe(0);
    // Each change restarted it, the last one too: an unpinned name must stop resolving.
    expect(restart).toHaveBeenCalledTimes(3);
  });

  it('keeps only the latest refresh\'s answer when two overlap', async () => {
    const libs = new FakeLibs();
    const pending: ((p: PackageTypesPayload) => void)[] = [];
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const types = new PackageTypes(libs.register, () => new Promise((resolve) => pending.push(resolve)), restart);

    const first = types.refresh();
    const second = types.refresh();
    pending[1](payload('new', ['new.js']));
    pending[0](payload('old', ['old.js']));
    await Promise.all([first, second]);
    expect([...libs.live.keys()]).toEqual(['file:///node_modules/@acme/kit/new.js']);
  });

  it('never throws when the server can\'t answer, and keeps what it had', async () => {
    const libs = new FakeLibs();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = false;
    const types = new PackageTypes(libs.register, async () => {
      if (fail) {
        throw new Error('500 Internal Server Error');
      }
      return payload('k', ['index.js']);
    }, restart);

    await types.refresh();
    fail = true;
    await expect(types.refresh()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(libs.live.size).toBe(1);
  });
});
