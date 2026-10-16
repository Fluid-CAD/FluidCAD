// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShapesPanel } from '../src/ui/shapes-panel';
import type { SceneObjectPart, SceneObjectRender } from '../src/types';

// The Shapes section groups by part — part-less shapes under "Model", listed
// first — and labels a row `<Type> <n>`, n counted per part and per shape
// type in timeline order, with the holding feature's name beneath it. The
// number is a label: the eye and the menu still act on `data-shape-id`.

const FILE = '/ws/bracket.part.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });

const solid = (shapeId: string): SceneObjectPart => ({ shapeId, shapeType: 'solid', meshes: [] });
const face = (shapeId: string): SceneObjectPart => ({ shapeId, shapeType: 'face', meshes: [] });
const meta = (shapeId: string): SceneObjectPart => ({ shapeId, shapeType: 'solid', meshes: [], isMetaShape: true });

/** Two parts (two solids + a face, one solid), one top-level solid, one meta shape. */
function scene(): SceneObjectRender[] {
  return [
    { id: 'A', name: 'Bracket', hasCustomName: true, type: 'part', isContainer: true, sceneShapes: [], sourceLocation: loc(1) },
    { id: 'a1', name: 'Extrude 1', type: 'extrude', parentId: 'A', sceneShapes: [solid('s1'), meta('m1'), solid('s2')], sourceLocation: loc(2) },
    { id: 'a2', name: 'Boss', hasCustomName: true, type: 'extrude', parentId: 'A', sceneShapes: [face('f1')], sourceLocation: loc(3) },
    { id: 'B', name: 'Lid', hasCustomName: true, type: 'part', isContainer: true, sceneShapes: [], sourceLocation: loc(5) },
    { id: 'b1', name: 'Extrude 2', type: 'extrude', parentId: 'B', sceneShapes: [solid('s3')], sourceLocation: loc(6) },
    { id: 't1', name: 'Extrude 3', type: 'extrude', sceneShapes: [solid('s4')], sourceLocation: loc(8) },
  ] as unknown as SceneObjectRender[];
}

function mount(hidden: Set<string> = new Set()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const callbacks = {
    highlight: vi.fn(),
    exportShapes: vi.fn(),
    toggleVisibility: vi.fn(),
    setTransparency: vi.fn(),
    resetAll: vi.fn(),
  };
  const panel = new ShapesPanel(
    host,
    callbacks.highlight,
    callbacks.exportShapes,
    callbacks.toggleVisibility,
    (id) => hidden.has(id),
    callbacks.setTransparency,
    () => 1,
    callbacks.resetAll,
  );
  panel.mount(host);
  const headers = () => [...panel.body.querySelectorAll<HTMLElement>('[data-shape-group]')];
  const rows = () => [...panel.body.querySelectorAll<HTMLElement>('[data-shape-id]')];
  /** The rows between this group's header and the next one. */
  const rowsOf = (title: string): HTMLElement[] => {
    const header = headers().find((h) => h.textContent?.includes(title))!;
    const out: HTMLElement[] = [];
    let el = header.nextElementSibling as HTMLElement | null;
    while (el && !el.hasAttribute('data-shape-group')) {
      out.push(el);
      el = el.nextElementSibling as HTMLElement | null;
    }
    return out;
  };
  const label = (row: HTMLElement) => row.querySelector('[data-shape-label]')!.textContent!.trim();
  const from = (row: HTMLElement) => row.querySelector('[data-shape-from]')!.textContent!.trim();
  return { host, panel, callbacks, headers, rows, rowsOf, label, from };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shapes panel — grouping by part', () => {
  it('lists one group per part in timeline order, "Model" first for part-less shapes', () => {
    const h = mount();
    h.panel.update(scene());
    const titles = h.headers().map((el) => el.querySelector('span:nth-child(2)')!.textContent!.trim());
    expect(titles).toEqual(['Model', 'Bracket', 'Lid']);
    // A group header names the part and nothing else — no shape count.
    expect(h.headers().every((el) => el.querySelectorAll('span').length === 2)).toBe(true);
  });

  it('labels rows <Type> <n> per part and per type, with the holder beneath', () => {
    const h = mount();
    h.panel.update(scene());
    expect(h.rowsOf('Bracket').map(h.label)).toEqual(['Solid 1', 'Solid 2', 'Face 1']);
    expect(h.rowsOf('Bracket').map(h.from)).toEqual(['from Extrude 1', 'from Extrude 1', 'from Boss']);
    expect(h.rowsOf('Lid').map(h.label)).toEqual(['Solid 1']);
    expect(h.rowsOf('Lid').map(h.from)).toEqual(['from Extrude 2']);
    expect(h.rowsOf('Model').map(h.label)).toEqual(['Solid 1']);
    expect(h.rowsOf('Model').map(h.from)).toEqual(['from Extrude 3']);
  });

  it('skips meta shapes and keeps the shape id as the row handle', () => {
    const h = mount();
    h.panel.update(scene());
    expect(h.rows().map((row) => row.dataset.shapeId)).toEqual(['s4', 's1', 's2', 'f1', 's3']);
  });

  it('files a shape held two levels under a part with that part', () => {
    const h = mount();
    h.panel.update([
      { id: 'A', name: 'Bracket', hasCustomName: true, type: 'part', isContainer: true, sceneShapes: [], sourceLocation: loc(1) },
      { id: 'r', name: 'Repeat 1', type: 'repeat', parentId: 'A', isContainer: true, sceneShapes: [], sourceLocation: loc(2) },
      { id: 'rc', name: 'Extrude 1', type: 'extrude', parentId: 'r', sceneShapes: [solid('s1')], sourceLocation: loc(2) },
    ] as unknown as SceneObjectRender[]);
    expect(h.headers()).toHaveLength(1);
    expect(h.rowsOf('Bracket').map(h.label)).toEqual(['Solid 1']);
    expect(h.rowsOf('Bracket').map(h.from)).toEqual(['from Extrude 1']);
  });

  it('shows the empty state when no feature built geometry', () => {
    const h = mount();
    h.panel.update([
      { id: 'A', name: 'Bracket', hasCustomName: true, type: 'part', isContainer: true, sceneShapes: [], sourceLocation: loc(1) },
    ] as unknown as SceneObjectRender[]);
    expect(h.headers()).toHaveLength(0);
    expect(h.panel.body.textContent).toContain('No shapes yet');
  });
});

describe('shapes panel — state and actions', () => {
  it('keeps a part collapsed across an update with fresh rows', () => {
    const h = mount();
    h.panel.update(scene());
    h.headers().find((el) => el.textContent?.includes('Bracket'))!.click();
    expect(h.rowsOf('Bracket')).toHaveLength(0);
    expect(h.rowsOf('Lid')).toHaveLength(1);

    h.panel.update(scene());
    expect(h.rowsOf('Bracket')).toHaveLength(0);
    expect(h.rowsOf('Lid')).toHaveLength(1);
    expect(h.rowsOf('Model')).toHaveLength(1);

    h.headers().find((el) => el.textContent?.includes('Bracket'))!.click();
    expect(h.rowsOf('Bracket')).toHaveLength(3);
  });

  it('shows the eye as off for a hidden shape and toggles through the shape id', () => {
    const h = mount(new Set(['s2']));
    h.panel.update(scene());
    const eyes = [...h.panel.body.querySelectorAll<HTMLElement>('[data-eye]')];
    const eyeOf = (id: string) => eyes.find((el) => el.dataset.eye === id)!;
    expect(eyeOf('s2').className).toContain('opacity-100');
    expect(eyeOf('s1').className).toContain('opacity-0');

    eyeOf('s2').click();
    expect(h.callbacks.toggleVisibility).toHaveBeenCalledWith('s2', true);
    eyeOf('s1').click();
    expect(h.callbacks.toggleVisibility).toHaveBeenCalledWith('s1', false);
  });

  it('selects a row on click and highlights it', () => {
    const h = mount();
    h.panel.update(scene());
    h.rows().find((row) => row.dataset.shapeId === 's3')!.click();
    expect(h.callbacks.highlight).toHaveBeenCalledWith('s3');
    expect(h.rows().find((row) => row.dataset.shapeId === 's3')!.className).toContain('bg-primary/10');
  });
});
