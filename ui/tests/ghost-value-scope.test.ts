import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  featureGhostScope,
  fetchFeatureGhostResult,
  setActivePartProvider,
  sketchGhostScope,
  type GhostValueScope,
} from '../src/api';

// Where a ghost's dialog values are read: an edited statement at its own
// call site, a created one at the end of the body it lands in. Without it
// the server read only the file's top level, and a dialog naming a part
// body's `param()` drew no ghost.

const filePath = '/ws/cabinet.part.js';
const edited = { filePath, line: 13, column: 3 };
const activePart = { filePath, line: 3, column: 22 };
const activeSketch = { filePath, line: 9, column: 13 };

afterEach(() => {
  setActivePartProvider(() => null);
  vi.unstubAllGlobals();
});

describe('ghost value scopes', () => {
  it('reads an edited statement at its own call site, in either dialog family', () => {
    setActivePartProvider(() => activePart);
    expect(featureGhostScope(edited)).toEqual({ kind: 'statement', ...edited });
    expect(sketchGhostScope(edited, activeSketch)).toEqual({ kind: 'statement', ...edited });
  });

  it('lands a created feature at the end of the active part', () => {
    setActivePartProvider(() => activePart);
    expect(featureGhostScope(null)).toEqual({ kind: 'append', ...activePart });
  });

  it('reads the top level for a created feature with no part active', () => {
    expect(featureGhostScope(null)).toBeNull();
  });

  it('lands a created sketch op at the end of the active sketch, not the part', () => {
    setActivePartProvider(() => activePart);
    expect(sketchGhostScope(null, activeSketch)).toEqual({ kind: 'append', ...activeSketch });
    expect(sketchGhostScope(null, null)).toBeNull();
  });

  it('puts only the site on the wire', () => {
    const target = { ...edited, extra: 'not a site field' };
    expect(featureGhostScope(target)).toEqual({ kind: 'statement', ...edited });
  });

  it('sends the scope with the request', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ success: true, solids: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const scope: GhostValueScope = { kind: 'append', ...activeSketch };

    const result = await fetchFeatureGhostResult(
      { feature: 'offset', distance: 'wall', close: false, entities: [] },
      scope,
      new AbortController().signal,
    );

    expect(result.solids).toEqual([]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ feature: 'offset', distance: 'wall', close: false, entities: [], valueScope: scope });
  });
});
