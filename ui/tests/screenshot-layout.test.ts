// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { OrthographicCamera, Vector3 } from 'three';
import { MultiViewLayout, ScreenshotAnnotationPlan, ScreenshotPainter } from '../src/screenshot-overlays';

describe('MultiViewLayout.cells', () => {
  it('lays four views out two per row on whole-pixel cells that tile the composite exactly', () => {
    const layout = MultiViewLayout.cells(4, 801, 601);
    expect(layout.cells).toEqual([
      { x: 0, y: 0, width: 400, height: 300 },
      { x: 400, y: 0, width: 400, height: 300 },
      { x: 0, y: 300, width: 400, height: 300 },
      { x: 400, y: 300, width: 400, height: 300 },
    ]);
    expect(layout.width).toBe(800);
    expect(layout.height).toBe(600);
  });

  it('puts two views side by side on one row, and six on three rows', () => {
    const two = MultiViewLayout.cells(2, 800, 400);
    expect(two.cells.map(c => [c.x, c.y])).toEqual([[0, 0], [400, 0]]);
    expect(two.height).toBe(400);

    const six = MultiViewLayout.cells(6, 600, 900);
    expect(six.cells.map(c => [c.x, c.y])).toEqual([[0, 0], [300, 0], [0, 300], [300, 300], [0, 600], [300, 600]]);
    expect(six.cells.every(c => c.width === 300 && c.height === 300)).toBe(true);
  });

  it('leaves the last row short when the count is odd, never clipping a cell', () => {
    const five = MultiViewLayout.cells(5, 400, 600);
    expect(five.cells).toHaveLength(5);
    expect(five.cells[4]).toEqual({ x: 0, y: 400, width: 200, height: 200 });
    expect(five.height).toBe(600);
  });

  it('never produces a zero-sized cell', () => {
    const tiny = MultiViewLayout.cells(4, 1, 1);
    expect(tiny.cells.every(c => c.width >= 1 && c.height >= 1)).toBe(true);
  });
});

describe('MultiViewLayout.labelFor', () => {
  it('names a named view by its name', () => {
    expect(MultiViewLayout.labelFor({ kind: 'named', name: 'iso-bbl' })).toBe('iso-bbl');
    expect(MultiViewLayout.labelFor({ kind: 'current' })).toBe('current');
  });

  it('spells a look-from view with the eye rounded to three significant figures', () => {
    expect(MultiViewLayout.labelFor({ kind: 'look-from', eye: [123.456, -0.04567, 1000.4] })).toBe('look-from [123, -0.0457, 1000]');
    expect(MultiViewLayout.labelFor({ kind: 'look-from', eye: [10, -10, 10], target: [0, 0, 0] })).toBe('look-from [10, -10, 10]');
  });

  it('spells an orbit view with signed angles', () => {
    expect(MultiViewLayout.labelFor({ kind: 'orbit-from-current', azimuthDeg: 30, elevationDeg: -15.55 })).toBe('orbit az +30° el -15.6°');
  });

  it('defaults to two opposed isometrics plus top and front', () => {
    expect(MultiViewLayout.DEFAULT_VIEWS.map(v => (v.kind === 'named' ? v.name : v.kind))).toEqual(['iso-ftr', 'iso-bbl', 'top', 'front']);
  });
});

describe('ScreenshotAnnotationPlan', () => {
  function topCamera(): OrthographicCamera {
    // Looking down -Z at a 100×100 world window: x right, y up the page.
    const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.up.set(0, 1, 0);
    camera.lookAt(new Vector3(0, 0, 0));
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    return camera;
  }

  it('projects world points to drawing-buffer pixels, y down the page', () => {
    const camera = topCamera();
    expect(ScreenshotAnnotationPlan.pixel([0, 0, 0], camera, 400, 400)).toEqual([200, 200]);
    const [x, y] = ScreenshotAnnotationPlan.pixel([25, 25, 0], camera, 400, 400);
    expect(x).toBeCloseTo(300, 6);
    expect(y).toBeCloseTo(100, 6);
  });

  it('keeps labels beside their projected line', () => {
    const camera = topCamera();
    const plan = ScreenshotAnnotationPlan.project(
      [{ from: [-25, 0, 0], to: [25, 0, 0], label: '50 mm' }, { from: [0, 0, 0], to: [0, 10, 0] }],
      camera, 400, 400,
    );
    expect(plan).toHaveLength(2);
    expect(plan[0].from[0]).toBeCloseTo(100, 6);
    expect(plan[0].to[0]).toBeCloseTo(300, 6);
    expect(plan[0].label).toBe('50 mm');
    expect(plan[1].label).toBeUndefined();
  });

  it('collects both endpoints of every annotation for framing', () => {
    const points = ScreenshotAnnotationPlan.points([{ from: [1, 2, 3], to: [4, 5, 6] }]);
    expect(points.map(p => p.toArray())).toEqual([[1, 2, 3], [4, 5, 6]]);
  });
});

describe('ScreenshotPainter.labelAnchor', () => {
  it('offsets the label from the midpoint along the line normal, towards the top of the page, scaled by the pixel ratio', () => {
    const [x, y] = ScreenshotPainter.labelAnchor([100, 200], [300, 200], 1);
    expect(x).toBe(200);
    expect(y).toBe(200 - ScreenshotPainter.LABEL_OFFSET);
    const [x2, y2] = ScreenshotPainter.labelAnchor([300, 200], [100, 200], 2);
    expect(x2).toBe(200);
    expect(y2).toBe(200 - ScreenshotPainter.LABEL_OFFSET * 2);
  });

  it('pushes the label sideways off a vertical line', () => {
    const [x, y] = ScreenshotPainter.labelAnchor([100, 100], [100, 300], 1);
    expect(Math.abs(x - 100)).toBe(ScreenshotPainter.LABEL_OFFSET);
    expect(y).toBe(200);
  });

  it('sits above a degenerate (zero-length) line', () => {
    expect(ScreenshotPainter.labelAnchor([50, 50], [50, 50], 1)).toEqual([50, 50 - ScreenshotPainter.LABEL_OFFSET]);
  });
});
