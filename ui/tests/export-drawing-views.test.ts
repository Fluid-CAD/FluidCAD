import { describe, expect, it } from 'vitest';
import { DrawingViews } from '../src/ui/export-drawing-views';
import { parseExportWarnings, toExportResult } from '../src/api';

// The drawing export's views without the DOM: which standard view a drawing
// opens on for a camera, and how an export's warnings come back from the server.

describe('DrawingViews.facing', () => {
  it('is the view the camera looks from, for each of the six', () => {
    expect(DrawingViews.facing({ x: 0, y: 0, z: 1 })).toBe('top');
    expect(DrawingViews.facing({ x: 0, y: 0, z: -1 })).toBe('bottom');
    expect(DrawingViews.facing({ x: 0, y: -1, z: 0 })).toBe('front');
    expect(DrawingViews.facing({ x: 0, y: 1, z: 0 })).toBe('back');
    expect(DrawingViews.facing({ x: 1, y: 0, z: 0 })).toBe('right');
    expect(DrawingViews.facing({ x: -1, y: 0, z: 0 })).toBe('left');
  });

  it('reads only the direction, not the distance, and allows a camera up to 30° off the view', () => {
    expect(DrawingViews.facing({ x: 30, y: -400, z: 120 })).toBe('front');
    // 29° off Right, toward the top.
    expect(DrawingViews.facing({ x: Math.cos(29 * Math.PI / 180), y: 0, z: Math.sin(29 * Math.PI / 180) })).toBe('right');
    // 31° off: no longer clearly from the right.
    expect(DrawingViews.facing({ x: Math.cos(31 * Math.PI / 180), y: 0, z: Math.sin(31 * Math.PI / 180) })).toBe('top');
  });

  it('is Top for a camera on no side in particular', () => {
    // The isometric the viewport opens on, exact and as the camera really sits (a hair nearer Front).
    expect(DrawingViews.facing({ x: 1, y: -1, z: 1 })).toBe('top');
    expect(DrawingViews.facing({ x: 0.98, y: -1.05, z: 0.97 })).toBe('top');
    // Tilted cameras whose dominant axis is another side's, but not clearly.
    expect(DrawingViews.facing({ x: -0.6, y: 0.5, z: 0.55 })).toBe('top');
    expect(DrawingViews.facing({ x: 0.5, y: 0.5, z: -0.6 })).toBe('top');
    expect(DrawingViews.facing({ x: 1, y: -1, z: 0 })).toBe('top');
  });

  it('is Top when there is no direction to read', () => {
    expect(DrawingViews.facing(null)).toBe('top');
    expect(DrawingViews.facing(undefined)).toBe('top');
    expect(DrawingViews.facing({ x: 0, y: 0, z: 0 })).toBe('top');
    expect(DrawingViews.facing({ x: Number.NaN, y: 0, z: 1 })).toBe('top');
  });

  it('knows its own views from anything else', () => {
    expect(DrawingViews.OPTIONS.map((option) => option.view)).toEqual(['top', 'bottom', 'front', 'back', 'right', 'left']);
    expect(DrawingViews.isView('front')).toBe(true);
    expect(DrawingViews.isView('xz')).toBe(false);
    expect(DrawingViews.isView('iso-ftr')).toBe(false);
  });
});

describe('export warnings', () => {
  it('reads the header\'s URI-encoded JSON list', () => {
    const warnings = ['2 curves were approximated by polylines: the kernel could not hand them over as splines.', 'Größe — ok'];
    expect(parseExportWarnings(encodeURIComponent(JSON.stringify(warnings)))).toEqual(warnings);
  });

  it('has none without the header, or when the header is not the list it should be', () => {
    expect(parseExportWarnings(null)).toEqual([]);
    expect(parseExportWarnings('')).toEqual([]);
    expect(parseExportWarnings('%E0%A4%A')).toEqual([]);
    expect(parseExportWarnings(encodeURIComponent('not json'))).toEqual([]);
    expect(parseExportWarnings(encodeURIComponent(JSON.stringify({ warnings: ['x'] })))).toEqual([]);
    expect(parseExportWarnings(encodeURIComponent(JSON.stringify(['kept', 3, '', null])))).toEqual(['kept']);
  });

  it('takes a host\'s bare file as an export without warnings', () => {
    const blob = new Blob(['step']);
    expect(toExportResult(blob)).toEqual({ blob, warnings: [] });
    const result = { blob, warnings: ['one'] };
    expect(toExportResult(result)).toBe(result);
  });
});
