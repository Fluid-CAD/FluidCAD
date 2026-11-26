// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { SelectionInfoOverlay } from '../src/ui/selection-info-overlay';
import type { EdgeProperties, FaceProperties } from '../src/api';
import type { EngineClient } from '../src/engine-client';

// The overlay beside the chips: a face or an edge picked on a solid reads by
// its own shape; one picked on a surface or a curve reads as that surface
// (its area) or that curve (its length).

function mount(face: FaceProperties | null, edge: EdgeProperties | null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = {
    getFaceProperties: async () => face,
    getEdgeProperties: async () => edge,
  } as unknown as EngineClient;
  const overlay = new SelectionInfoOverlay(container, client);
  const panel = () => container.querySelector('.badge')!.parentElement!;
  return {
    overlay,
    badge: () => container.querySelector('.badge')!.textContent,
    rows: () => [...panel().querySelectorAll('.flex.justify-between')]
      .map(row => [...row.querySelectorAll('span')].map(span => span.textContent)),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('selection info overlay', () => {
  it('reads a face of a solid by its own shape', async () => {
    const h = mount({ surfaceType: 'cylinder', radius: 4, areaMm2: 100 }, null);
    await h.overlay.showForFace('s', 0);
    expect(h.badge()).toBe('Cylinder');
    expect(h.rows()).toEqual([['Radius', '4.00 mm']]);
  });

  it('reads a face of a surface as the surface, by its area', async () => {
    const h = mount({ surfaceType: 'cylinder', radius: 4, areaMm2: 100, owner: { kind: 'surface', area: 250 } }, null);
    await h.overlay.showForFace('s', 0);
    expect(h.badge()).toBe('Surface');
    expect(h.rows()).toEqual([['Area', '250.00 mm²'], ['Face', 'Cylinder'], ['Radius', '4.00 mm']]);
  });

  it('reads an edge of a curve as the curve, by its length', async () => {
    const h = mount(null, { curveType: 'arc', radius: 5, length: 7.85, owner: { kind: 'curve', length: 30 } });
    await h.overlay.showForEdge('c', 1);
    expect(h.badge()).toBe('Curve');
    expect(h.rows()).toEqual([['Length', '30.00 mm'], ['Edge', 'Arc'], ['Radius', '5.00 mm']]);
  });

  it('names a free-form face, and a revolved and an extruded one', async () => {
    for (const [surfaceType, label] of [['freeform', 'Free-form surface'], ['revolved', 'Revolved surface'], ['extruded', 'Extruded surface']] as const) {
      const h = mount({ surfaceType, recovered: false, areaMm2: 120 }, null);
      await h.overlay.showForFace('s', 0);
      expect(h.badge()).toBe(label);
      expect(h.rows()).toEqual([['Area', '120.00 mm²']]);
      document.body.innerHTML = '';
    }
  });

  it('names a sphere by its radius', async () => {
    const h = mount({ surfaceType: 'sphere', recovered: false, radius: 6 }, null);
    await h.overlay.showForFace('s', 0);
    expect(h.badge()).toBe('Sphere');
    expect(h.rows()).toEqual([['Radius', '6.00 mm']]);
  });

  it('names a free-form face of a surface in its face row', async () => {
    const h = mount({ surfaceType: 'freeform', recovered: false, areaMm2: 80, owner: { kind: 'surface', area: 300 } }, null);
    await h.overlay.showForFace('s', 0);
    expect(h.badge()).toBe('Surface');
    expect(h.rows()).toEqual([['Area', '300.00 mm²'], ['Face', 'Free-form surface']]);
  });

  it('names a spline by its length, and a closed one as closed', async () => {
    const open = mount(null, { curveType: 'spline', closed: false, planar: true, length: 12.5 });
    await open.overlay.showForEdge('s', 2);
    expect(open.badge()).toBe('Spline');
    expect(open.rows()).toEqual([['Length', '12.50 mm']]);
    document.body.innerHTML = '';

    const closed = mount(null, { curveType: 'spline', closed: true, planar: false, length: 40 });
    await closed.overlay.showForEdge('s', 2);
    expect(closed.badge()).toBe('Spline (closed)');
  });

  it('names an ellipse by its radii, and a full one as closed', async () => {
    const h = mount(null, { curveType: 'ellipse', closed: true, planar: true, majorRadius: 5, minorRadius: 2.5 });
    await h.overlay.showForEdge('s', 3);
    expect(h.badge()).toBe('Ellipse (closed)');
    expect(h.rows()).toEqual([['Major R', '5.00 mm'], ['Minor R', '2.50 mm']]);
  });

  it('names the spline edge of a curve in its edge row', async () => {
    const h = mount(null, { curveType: 'spline', closed: false, planar: false, length: 18, owner: { kind: 'curve', length: 18 } });
    await h.overlay.showForEdge('c', 0);
    expect(h.badge()).toBe('Curve');
    expect(h.rows()).toEqual([['Length', '18.00 mm'], ['Edge', 'Spline']]);
  });

  it('keeps an edge of a solid as it was: an arc by its radius and length', async () => {
    const h = mount(null, { curveType: 'arc', radius: 5, length: 7.85 });
    await h.overlay.showForEdge('s', 1);
    expect(h.badge()).toBe('Arc');
    expect(h.rows()).toEqual([['Radius', '5.00 mm'], ['Length', '7.85 mm']]);
  });
});
