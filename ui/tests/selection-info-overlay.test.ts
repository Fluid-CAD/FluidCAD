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

  it('keeps an edge of a solid as it was: an arc by its radius and length', async () => {
    const h = mount(null, { curveType: 'arc', radius: 5, length: 7.85 });
    await h.overlay.showForEdge('s', 1);
    expect(h.badge()).toBe('Arc');
    expect(h.rows()).toEqual([['Radius', '5.00 mm'], ['Length', '7.85 mm']]);
  });
});
