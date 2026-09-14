import { describe, expect, it } from 'vitest';
import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import {
  computeTightFraming,
  viewBasis,
  viewSpanOf,
  type FitLens,
  type FitViewport,
} from '../src/scene/camera-fit';

// The tight fit: frame a box the way it actually projects, in the viewport's
// own aspect ratio, instead of framing the sphere around it. Everything here
// is checked by building the camera the framing describes and projecting the
// box's own corners through it — the claim is about pixels on a canvas, so
// the assertions are too.

const UP = new Vector3(0, 0, 1);

/** Where the framed corners land, in normalized device coordinates. */
function ndcBox(
  parts: Box3[],
  camera: OrthographicCamera | PerspectiveCamera,
): { minX: number; maxX: number; minY: number; maxY: number } {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const out = {minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity};
  for (const box of parts) {
    for (const cx of [box.min.x, box.max.x]) {
      for (const cy of [box.min.y, box.max.y]) {
        for (const cz of [box.min.z, box.max.z]) {
          const p = new Vector3(cx, cy, cz).project(camera);
          out.minX = Math.min(out.minX, p.x);
          out.maxX = Math.max(out.maxX, p.x);
          out.minY = Math.min(out.minY, p.y);
          out.maxY = Math.max(out.maxY, p.y);
        }
      }
    }
  }
  return out;
}

/** How far the framed geometry reaches from the centre of the frame. */
function ndcExtent(parts: Box3[], camera: OrthographicCamera | PerspectiveCamera): { x: number; y: number } {
  const b = ndcBox(parts, camera);
  return { x: Math.max(Math.abs(b.minX), Math.abs(b.maxX)), y: Math.max(Math.abs(b.minY), Math.abs(b.maxY)) };
}

function union(parts: Box3[]): Box3 {
  const box = new Box3();
  for (const part of parts) {
    box.union(part);
  }
  return box;
}

function frameWith(
  parts: Box3 | Box3[],
  eye: Vector3,
  lens: FitLens,
  viewport: FitViewport,
  padding = 1,
) {
  const list = Array.isArray(parts) ? parts : [parts];
  const box = union(list);
  const target = box.getCenter(new Vector3());
  const framing = computeTightFraming(list, eye, target, UP, lens, viewport, padding);
  expect(framing).not.toBeNull();
  const back = eye.clone().sub(target).normalize();
  const camera = lens.kind === 'orthographic'
    ? new OrthographicCamera(
        (-lens.frustumHeight * viewport.width) / viewport.height / 2,
        (lens.frustumHeight * viewport.width) / viewport.height / 2,
        lens.frustumHeight / 2,
        -lens.frustumHeight / 2,
        -1e6,
        1e6,
      )
    : new PerspectiveCamera(lens.fovDeg, viewport.width / viewport.height, 0.01, 1e6);
  camera.up.copy(UP);
  camera.zoom = framing!.zoom;
  camera.position.copy(framing!.target).addScaledVector(back, framing!.distance);
  camera.lookAt(framing!.target);
  return { framing: framing!, camera, box, parts: list, extent: ndcExtent(list, camera), ndc: ndcBox(list, camera) };
}

/** A box `size` long in X, `depth` in Y and Z, centred on the origin. */
function slab(size: number, depth: number): Box3 {
  return new Box3(
    new Vector3(-size / 2, -depth / 2, -depth / 2),
    new Vector3(size / 2, depth / 2, depth / 2),
  );
}

const WIDE: FitViewport = { width: 960, height: 560 };
const ORTHO: FitLens = { kind: 'orthographic', frustumHeight: 120 };
const PERSP: FitLens = { kind: 'perspective', fovDeg: 50 };
/** Looking down -Y at a box that runs along X: the widest case there is. */
const FRONT = new Vector3(0, -400, 0);

describe('viewBasis', () => {
  it('is the basis three.js orients the camera with', () => {
    const basis = viewBasis(new Vector3(0, -10, 0), new Vector3(), UP);
    expect(basis.back.dot(new Vector3(0, -1, 0))).toBeCloseTo(1, 6);
    expect(basis.up.dot(UP)).toBeCloseTo(1, 6);
    expect(basis.right.dot(new Vector3(1, 0, 0))).toBeCloseTo(1, 6);
  });

  it('still resolves when the view direction is parallel to up', () => {
    const basis = viewBasis(new Vector3(0, 0, 10), new Vector3(), UP);
    expect(basis.right.length()).toBeCloseTo(1, 6);
    expect(basis.up.length()).toBeCloseTo(1, 6);
    expect(basis.right.dot(basis.up)).toBeCloseTo(0, 6);
  });
});

describe('viewSpanOf', () => {
  it('measures along the camera axes, not the world ones', () => {
    const basis = viewBasis(FRONT, new Vector3(), UP);
    const span = viewSpanOf([slab(600, 100)], basis)!;
    expect(span.half.x).toBeCloseTo(300, 6);
    expect(span.half.y).toBeCloseTo(50, 6);
    expect(span.half.z).toBeCloseTo(50, 6);
    expect(span.centre.length()).toBeCloseTo(0, 6);
  });

  it('grows the on-screen extent when the model is turned into the view', () => {
    const basis = viewBasis(new Vector3(1, -1, 1).multiplyScalar(400), new Vector3(), UP);
    const span = viewSpanOf([slab(600, 100)], basis)!;
    // A diagonal view sees the long axis foreshortened but the short ones
    // spread — neither screen axis matches a world one any more.
    expect(span.half.x).toBeGreaterThan(50);
    expect(span.half.x).toBeLessThan(300);
    expect(span.half.y).toBeGreaterThan(50);
  });

  it('measures the space the parts cover, not the box around them', () => {
    // The engine's shape: a long low shaft with the tall bits standing over
    // its middle only. The box around the two reaches up over the bare end of
    // the shaft, where there is nothing, and from an angle that empty corner
    // is what sticks out furthest.
    const shaft = new Box3(new Vector3(-300, -40, -40), new Vector3(300, 40, 40));
    const stack = new Box3(new Vector3(-60, -40, 40), new Vector3(160, 40, 320));
    const basis = viewBasis(new Vector3(1, -1, 1).multiplyScalar(900), new Vector3(), UP);
    const parts = viewSpanOf([shaft, stack], basis)!;
    const asOneBox = viewSpanOf([union([shaft, stack])], basis)!;
    // Never wider than the box around them, and here strictly shorter: from
    // this angle the screen-up axis is the one that picks up the empty corner
    // over the bare end of the shaft.
    expect(parts.half.x).toBeLessThanOrEqual(asOneBox.half.x);
    expect(parts.half.y).toBeLessThan(asOneBox.half.y);
    // And it sits somewhere else, which is why framing the box leaves the
    // model visibly off centre rather than merely small.
    expect(parts.centre.distanceTo(asOneBox.centre)).toBeGreaterThan(1);
  });

  it('has nothing to measure without a part that has extent', () => {
    const basis = viewBasis(FRONT, new Vector3(), UP);
    expect(viewSpanOf([], basis)).toBeNull();
    expect(viewSpanOf([new Box3()], basis)).toBeNull();
  });
});

describe('computeTightFraming — orthographic', () => {
  it('fills the wide side of the frame with a long model', () => {
    const { extent } = frameWith(slab(600, 100), FRONT, ORTHO, WIDE);
    expect(extent.x).toBeCloseTo(1, 3);
    expect(extent.y).toBeLessThan(1);
  });

  it('leaves the model centred', () => {
    const box = new Box3(new Vector3(100, 20, -5), new Vector3(700, 60, 45));
    const { framing, camera } = frameWith(box, FRONT.clone().add(box.getCenter(new Vector3())), ORTHO, WIDE);
    expect(framing.target.toArray()).toEqual(box.getCenter(new Vector3()).toArray());
    // Symmetric about the centre of the frame, not merely inside it.
    const min = new Vector3(box.min.x, box.min.y, box.min.z).project(camera);
    const max = new Vector3(box.max.x, box.max.y, box.max.z).project(camera);
    expect(min.x + max.x).toBeCloseTo(0, 6);
    expect(min.y + max.y).toBeCloseTo(0, 6);
  });

  it('centres what the parts cover, not the box around them', () => {
    // The case that gave the engine a hole on one side of the hero: framed as
    // one box, the model sits well off centre, because the box's middle is
    // not the middle of anything you can see.
    const shaft = new Box3(new Vector3(-300, -40, -40), new Vector3(300, 40, 40));
    const stack = new Box3(new Vector3(-60, -40, 40), new Vector3(160, 40, 320));
    const eye = new Vector3(1, -1, 1).multiplyScalar(900);
    const asParts = frameWith([shaft, stack], eye, ORTHO, WIDE);
    expect(asParts.ndc.minX + asParts.ndc.maxX).toBeCloseTo(0, 6);
    expect(asParts.ndc.minY + asParts.ndc.maxY).toBeCloseTo(0, 6);
    // And bigger: the room the empty corners were claiming goes to the model.
    const asOneBox = frameWith(union([shaft, stack]), eye, ORTHO, WIDE);
    expect(asParts.framing.zoom).toBeGreaterThan(asOneBox.framing.zoom);
  });

  it('fits the shorter side when the model is taller than the frame is wide', () => {
    const tall = new Box3(new Vector3(-20, -20, -300), new Vector3(20, 20, 300));
    const { extent } = frameWith(tall, FRONT, ORTHO, WIDE);
    expect(extent.y).toBeCloseTo(1, 3);
    expect(extent.x).toBeLessThan(1);
  });

  it('shows a long model far bigger than the sphere fit does', () => {
    const box = slab(600, 100);
    const tight = computeTightFraming([box], FRONT, new Vector3(), UP, ORTHO, WIDE, 1)!;
    // What the sphere fit zooms to (camera-controls' fitToSphere): the
    // sphere's diameter against the shorter side of the ortho window, which
    // in a landscape frame is always its height.
    const sphereZoom = ORTHO.frustumHeight / box.getSize(new Vector3()).length();
    // Half again as wide on screen, so well over twice the area — and this
    // is a mild case: the gap grows with the model's slenderness and with
    // the frame's aspect ratio.
    expect(tight.zoom / sphereZoom).toBeGreaterThan(1.7);
  });

  it('turns padding into exactly that much air', () => {
    const box = slab(600, 100);
    const flush = frameWith(box, FRONT, ORTHO, WIDE, 1).extent.x;
    const padded = frameWith(box, FRONT, ORTHO, WIDE, 1.25).extent.x;
    expect(padded).toBeCloseTo(flush / 1.25, 3);
  });

  it('gives up the room a view shift has taken', () => {
    const box = slab(600, 100);
    const full = frameWith(box, FRONT, ORTHO, WIDE, 1).framing.zoom;
    const shifted = frameWith(box, FRONT, ORTHO, { ...WIDE, shiftX: WIDE.width / 4 }, 1).framing.zoom;
    // Half the width is unusable once the model slides a quarter-width off
    // centre, so it has to be framed half the size.
    expect(shifted).toBeCloseTo(full / 2, 3);
  });

  it('holds the framing across an aspect change', () => {
    const box = slab(600, 100);
    const wide = frameWith(box, FRONT, ORTHO, WIDE, 1).extent;
    const narrow = frameWith(box, FRONT, ORTHO, { width: 400, height: 700 }, 1).extent;
    expect(wide.x).toBeCloseTo(1, 3);
    expect(narrow.x).toBeCloseTo(1, 3);
  });
});

describe('computeTightFraming — perspective', () => {
  it('keeps every corner inside the frustum, including the near ones', () => {
    const { extent } = frameWith(slab(600, 100), FRONT, PERSP, WIDE);
    expect(extent.x).toBeLessThanOrEqual(1 + 1e-6);
    expect(extent.y).toBeLessThanOrEqual(1 + 1e-6);
    // And touching: the fit is tight, not merely safe.
    expect(Math.max(extent.x, extent.y)).toBeCloseTo(1, 3);
  });

  it('holds from an oblique angle, where the widest corner is not the nearest', () => {
    const eye = new Vector3(1, -1, 0.6).normalize().multiplyScalar(900);
    const { extent } = frameWith(slab(600, 160), eye, PERSP, WIDE);
    expect(extent.x).toBeLessThanOrEqual(1 + 1e-6);
    expect(extent.y).toBeLessThanOrEqual(1 + 1e-6);
    expect(Math.max(extent.x, extent.y)).toBeCloseTo(1, 3);
  });

  it('stands the camera further back for more padding', () => {
    const box = slab(600, 100);
    const flush = computeTightFraming([box], FRONT, new Vector3(), UP, PERSP, WIDE, 1)!;
    const padded = computeTightFraming([box], FRONT, new Vector3(), UP, PERSP, WIDE, 1.25)!;
    expect(padded.distance).toBeGreaterThan(flush.distance);
  });
});

describe('computeTightFraming — nothing to solve', () => {
  const box = slab(600, 100);

  it('returns null when no part has any extent', () => {
    expect(computeTightFraming([new Box3()], FRONT, new Vector3(), UP, ORTHO, WIDE, 1)).toBeNull();
  });

  it('returns null for a canvas with no area', () => {
    expect(computeTightFraming([box], FRONT, new Vector3(), UP, ORTHO, { width: 0, height: 0 }, 1)).toBeNull();
  });

  it('returns null when the shift is wider than the canvas', () => {
    expect(
      computeTightFraming([box], FRONT, new Vector3(), UP, ORTHO, { ...WIDE, shiftX: WIDE.width }, 1),
    ).toBeNull();
  });

  it('returns null when the eye sits on its target', () => {
    expect(computeTightFraming([box], new Vector3(), new Vector3(), UP, ORTHO, WIDE, 1)).toBeNull();
  });
});
