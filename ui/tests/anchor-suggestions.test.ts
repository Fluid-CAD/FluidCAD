import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera } from 'three';
import type { ConnectorAnchorCandidate } from '../src/api';
import { AnchorSuggestions, LockedAnchor, nearestAnchorIndex } from '../src/interactive/create-feature/anchor-suggestions';
import type { ConnectorGhostOverlay } from '../src/interactive/create-feature/connector-ghost';
import type { Viewer } from '../src/viewer';

// Which anchor the hover rail (Connector tool and Hole dialog alike) floats
// for the cursor: the one whose hover point projects nearest.

/** Looking down -Z at a 100×100 viewport: world (x, y) lands at screen (x + 50, 50 - y). */
function topCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

const RECT = { left: 0, top: 0, width: 100, height: 100 };

function candidate(
  kind: 'center' | 'start' | 'end',
  origin: { x: number; y: number },
  hoverPoint?: { x: number; y: number },
): ConnectorAnchorCandidate {
  const up = { x: 0, y: 0, z: 1 };
  return {
    anchor: { kind },
    suffix: `.${kind}()`,
    frame: { origin: { ...origin, z: 0 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: up },
    hoverPoint: hoverPoint ? { ...hoverPoint, z: 0 } : undefined,
  };
}

/** The screen position of the point `deg` degrees along a radius-20 arc around the origin. */
function onArc(deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: 50 + 20 * Math.cos(rad), y: 50 - 20 * Math.sin(rad) };
}

describe('anchor suggestion nearest pick', () => {
  const r = 20;
  const mid = { x: r * Math.SQRT1_2, y: r * Math.SQRT1_2 };
  // A quarter arc from (20, 0) to (0, 20): its center() frame sits at the
  // circle center, a radius off the arc the cursor runs along.
  const arc = [
    candidate('center', { x: 0, y: 0 }, mid),
    candidate('start', { x: r, y: 0 }, { x: r, y: 0 }),
    candidate('end', { x: 0, y: r }, { x: 0, y: r }),
  ];

  it('suggests the arc center while hovering the middle of the arc', () => {
    expect(nearestAnchorIndex(arc, onArc(45), topCamera(), RECT)).toBe(0);
    expect(nearestAnchorIndex(arc, onArc(30), topCamera(), RECT)).toBe(0);
    expect(nearestAnchorIndex(arc, onArc(60), topCamera(), RECT)).toBe(0);
  });

  it('suggests the nearer end while hovering near either end of the arc', () => {
    expect(nearestAnchorIndex(arc, onArc(5), topCamera(), RECT)).toBe(1);
    expect(nearestAnchorIndex(arc, onArc(85), topCamera(), RECT)).toBe(2);
  });

  it('measures anchors without a hover point at their frame origin', () => {
    const legacy = arc.map(a => ({ ...a, hoverPoint: undefined }));
    // The off-arc circle center loses to an end everywhere along the arc.
    expect(nearestAnchorIndex(legacy, onArc(45), topCamera(), RECT)).not.toBe(0);
  });
});

// The rail's traffic: hover asks for frames only, at most one request is in
// flight, and every answer is kept per entity until the scene re-renders —
// so the click on the hovered entity locks at once.
describe('anchor suggestion rail', () => {
  /** One request the server has not answered yet. */
  type Pending = { body: any; resolve: (body: unknown) => void };
  let pending: Pending[];

  const FACE = { type: 'face' as const, index: 0 };
  const EDGE = { type: 'edge' as const, index: 3 };
  const anchors = [candidate('center', { x: 0, y: 0 })];
  const answer = (args: string | null = null) => ({ success: true, inPart: true, defaultName: 'c1', args, anchors });

  beforeEach(() => {
    vi.useFakeTimers();
    // Node environment on purpose: the jsdom suites share one module graph
    // in which the Hole dialog's tests bind this rail to their api mock. The
    // rail only needs window's timers — the faked global ones.
    vi.stubGlobal('window', globalThis);
    pending = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { body: string; signal?: AbortSignal }) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      pending.push({
        body: JSON.parse(init.body),
        resolve: body => resolve({ ok: true, json: async () => body }),
      });
    })));
  });

  // vitest runs this repo with `isolate: false`; a stubbed fetch must not
  // outlive the test that installed it.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mount(opts: { needsArgs?: boolean } = {}) {
    const viewer = {
      sceneContext: {
        renderer: { domElement: { getBoundingClientRect: () => RECT } },
        camera: topCamera(),
      },
    } as unknown as Viewer;
    const ghost = { showSuggestion: vi.fn(), clearSuggestion: vi.fn() };
    const rail = new AnchorSuggestions(viewer, ghost as unknown as ConnectorGhostOverlay, opts);
    const locks: LockedAnchor[] = [];
    rail.onLock = locked => locks.push(locked);
    rail.setEnabled(true);
    return { rail, ghost, locks };
  }

  /** Answer the oldest open request and let the rail react. */
  async function respond(body: unknown): Promise<Pending> {
    const request = pending.shift()!;
    request.resolve(body);
    await vi.advanceTimersByTimeAsync(0);
    return request;
  }

  it('hovers with frames only and locks the click from the hover\'s answer, after the mousedown cleared the hover', async () => {
    const { rail, ghost, locks } = mount();
    rail.handleHover('solid', FACE, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toMatchObject({ entity: { shapeId: 'solid', sub: FACE }, frames: true });
    await respond(answer());
    expect(ghost.showSuggestion).toHaveBeenCalledTimes(1);

    // The viewer clears its hover on mousedown, before the click lands.
    rail.handleHover(null, null, 0, 0);
    expect(rail.handleClick('solid', FACE)).toBe(true);
    expect(locks).toHaveLength(1);
    expect(locks[0].defaultName).toBe('c1');
    expect(locks[0].args).toBeNull();
    expect(pending).toHaveLength(0);
  });

  it('keeps one request in flight while the cursor sweeps, then asks for where it rests', async () => {
    const { rail } = mount();
    rail.handleHover('solid', FACE, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    rail.handleHover('solid', { type: 'face', index: 1 }, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    rail.handleHover('solid', EDGE, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveLength(1);

    await respond(answer());
    // Face 1 was only crossed; the cursor rests on the edge.
    expect(pending.map(p => p.body.entity.sub)).toEqual([EDGE]);
  });

  it('re-hovers a face it already answered without a round-trip', async () => {
    const { rail, ghost } = mount();
    rail.handleHover('solid', FACE, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    await respond(answer());
    rail.handleHover(null, null, 0, 0);
    rail.handleHover('solid', FACE, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveLength(0);
    expect(ghost.showSuggestion).toHaveBeenCalledTimes(2);
  });

  it('fetches and locks when a click outruns the hover', async () => {
    const { rail, locks } = mount();
    rail.handleHover('solid', FACE, 50, 50);
    rail.handleClick('solid', FACE);
    expect(pending).toHaveLength(1);
    await respond(answer());
    expect(locks).toHaveLength(1);
    // The debounced hover finds the answer already there.
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveLength(0);
  });

  it('fetches the expression on the click when the lock needs it', async () => {
    const { rail, locks } = mount({ needsArgs: true });
    rail.handleHover('solid', FACE, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    await respond(answer());
    rail.handleClick('solid', FACE);
    expect(locks).toHaveLength(0);
    expect(pending).toHaveLength(1);
    expect(pending[0].body.frames).toBeUndefined();
    await respond(answer('e.endFaces()'));
    expect(locks).toHaveLength(1);
    expect(locks[0].args).toBe('e.endFaces()');
    // A later click locks from the kept expression.
    rail.handleClick('solid', FACE);
    expect(locks).toHaveLength(2);
    expect(pending).toHaveLength(0);
  });

  it('forgets every answer when the scene re-renders', async () => {
    const { rail, locks } = mount();
    rail.handleHover('solid', FACE, 50, 50);
    await vi.advanceTimersByTimeAsync(100);
    await respond(answer());
    rail.clear();
    rail.handleClick('solid', FACE);
    expect(locks).toHaveLength(0);
    expect(pending).toHaveLength(1);
  });
});
