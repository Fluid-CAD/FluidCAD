// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ReferenceImageFrame, type Point2 } from '../src/interactive/tools/reference-image-frame';
import type { SketchImageData } from '../src/types';

// The picture's rectangle as pure geometry: frames, hit tests and the four
// gestures (move, corner resize with and without aspect, rotate, calibrate)
// expressed as changes to the written record.

const PIXEL = { width: 400, height: 200 };
const spec = (over: Partial<SketchImageData> = {}): SketchImageData => ({ src: 'a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5, ...over });
const TOL = { corner: 1, rotate: 1.5, stem: 5 };
const near = (p: Point2, x: number, y: number) => {
  expect(p[0]).toBeCloseTo(x, 6);
  expect(p[1]).toBeCloseTo(y, 6);
};

describe('ReferenceImageFrame geometry', () => {
  it('sizes from the record and the pixel aspect, and names its corners in its own frame', () => {
    const f = new ReferenceImageFrame(spec(), PIXEL);
    expect(f.width).toBe(80);
    expect(f.height).toBe(40);
    near(f.corner('tl'), -40, 20);
    near(f.corner('br'), 40, -20);
    near(f.rotateKnob(5), 0, 25);
  });

  it('turns and offsets with the record', () => {
    const f = new ReferenceImageFrame(spec({ at: [10, 5], angle: 90 }), PIXEL);
    // Width runs along +y now; the top edge faces -x.
    near(f.corner('tr'), 10 - 20, 5 + 40);
    near(f.toLocal([10, 45]), 40, 0);
    near(f.toSketch([40, 0]), 10, 45);
    near(f.rotateKnob(5), 10 - 25, 5);
  });

  it('hits the knob before a corner before the body, and nothing outside', () => {
    const f = new ReferenceImageFrame(spec(), PIXEL);
    expect(f.hitTest([0, 25], TOL)).toEqual({ part: 'rotate' });
    expect(f.hitTest([39.5, 19.5], TOL)).toEqual({ part: 'corner', corner: 'tr' });
    expect(f.hitTest([-40, -20], TOL)).toEqual({ part: 'corner', corner: 'bl' });
    expect(f.hitTest([0, 0], TOL)).toEqual({ part: 'body' });
    expect(f.hitTest([0, 19.9], TOL)).toEqual({ part: 'body' });
    expect(f.hitTest([0, 21.5], TOL)).toBeNull();
    expect(f.hitTest([60, 0], TOL)).toBeNull();
  });
});

describe('ReferenceImageFrame gestures', () => {
  it('moves by the pointer delta, keeping the grabbed point under the pointer', () => {
    const f = new ReferenceImageFrame(spec({ at: [1, 1] }), PIXEL);
    expect(f.move([10, 10], [13, 8]).at).toEqual([4, -1]);
  });

  it('resizes about the opposite corner keeping the aspect, and writes only the record\'s side', () => {
    const f = new ReferenceImageFrame(spec(), PIXEL);
    // Drag the top-right corner out along the diagonal to where a 100-wide
    // picture would end; the bottom-left corner (-40, -20) stays put.
    const next = f.resizeFromCorner('tr', [60, 30], true);
    expect(next.width).toBeCloseTo(100);
    expect(next.height).toBeUndefined();
    near(next.at, 10, 5);
    const g = new ReferenceImageFrame(next, PIXEL);
    near(g.corner('bl'), -40, -20);
    near(g.corner('tr'), 60, 30);
  });

  it('projects an off-diagonal drag onto the diagonal while the aspect is kept', () => {
    const f = new ReferenceImageFrame(spec(), PIXEL);
    const next = f.resizeFromCorner('tr', [60, 0], true);
    // (100, 20) along the (80, 40) diagonal from the pin: s = (100*80 + 20*40) / (80² + 40²) = 1.1
    expect(next.width).toBeCloseTo(88);
    const g = new ReferenceImageFrame(next, PIXEL);
    near(g.corner('bl'), -40, -20);
  });

  it('stretches freely without the lock and then writes both sides', () => {
    const f = new ReferenceImageFrame(spec(), PIXEL);
    const next = f.resizeFromCorner('br', [50, 0], false);
    expect(next.width).toBeCloseTo(90);
    expect(next.height).toBeCloseTo(20);
    const g = new ReferenceImageFrame(next, PIXEL);
    near(g.corner('tl'), -40, 20);
    near(g.corner('br'), 50, 0);
  });

  it('never collapses a side', () => {
    const f = new ReferenceImageFrame(spec(), PIXEL);
    const squashed = f.resizeFromCorner('tr', [-40, -20], false);
    expect(squashed.width).toBeGreaterThan(0);
    expect(squashed.height).toBeGreaterThan(0);
    const inverted = f.resizeFromCorner('tr', [-100, -100], true);
    expect(inverted.width).toBeGreaterThan(0);
  });

  it('keeps a height-only record height-only and a two-sided one two-sided', () => {
    const h = new ReferenceImageFrame(spec({ width: undefined, height: 40 }), PIXEL).resizeFromCorner('tr', [60, 30], true);
    expect(h.width).toBeUndefined();
    expect(h.height).toBeCloseTo(50);
    const both = new ReferenceImageFrame(spec({ width: 80, height: 10 }), PIXEL).resizeFromCorner('tr', [60, 30], true);
    expect(both.width).toBeDefined();
    expect(both.height).toBeDefined();
  });

  it('rotates so the knob points at the pointer, with an optional snap', () => {
    const f = new ReferenceImageFrame(spec(), PIXEL);
    expect(f.rotateTo([-10, 0], null).angle).toBe(90);
    expect(f.rotateTo([0, -10], null).angle).toBe(180);
    expect(f.rotateTo([10, 10], null).angle).toBe(-45);
    expect(f.rotateTo([10, 9], 15).angle).toBe(-45);
    expect(f.rotateTo([0, 0], null).angle).toBe(0);
    const turned = new ReferenceImageFrame(spec({ angle: 30 }), PIXEL);
    expect(turned.rotateTo([0, 10], null).angle).toBe(0);
  });

  it('calibrates by the ratio of the real to the measured distance about the centre', () => {
    const f = new ReferenceImageFrame(spec({ at: [3, 4] }), PIXEL);
    const next = f.calibrate(20, 50);
    expect(next.width).toBeCloseTo(200);
    expect(next.height).toBeUndefined();
    expect(next.at).toEqual([3, 4]);
    expect(f.calibrate(0, 50)).toBe(f.spec);
    expect(f.calibrate(20, -1)).toBe(f.spec);
    const both = new ReferenceImageFrame(spec({ height: 10 }), PIXEL).calibrate(2, 4);
    expect(both.width).toBeCloseTo(160);
    expect(both.height).toBeCloseTo(20);
  });

  it('picks resize cursors that turn with the picture', () => {
    expect(ReferenceImageFrame.cursorFor({ part: 'corner', corner: 'tl' }, 0)).toBe('nwse-resize');
    expect(ReferenceImageFrame.cursorFor({ part: 'corner', corner: 'tr' }, 0)).toBe('nesw-resize');
    expect(ReferenceImageFrame.cursorFor({ part: 'corner', corner: 'tl' }, 45)).toBe('ew-resize');
    expect(ReferenceImageFrame.cursorFor({ part: 'corner', corner: 'tr' }, 45)).toBe('ns-resize');
    expect(ReferenceImageFrame.cursorFor({ part: 'body' }, 0)).toBe('move');
    expect(ReferenceImageFrame.cursorFor({ part: 'rotate' }, 0)).toBe('grab');
    expect(ReferenceImageFrame.cursorFor(null, 0)).toBe('default');
  });
});
