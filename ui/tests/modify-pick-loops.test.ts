// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { ModifyPickService } from '../src/interactive/modify-pick/modify-pick-service';
import { Navbar } from '../src/ui/navbar';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// Loops in the fillet / chamfer / shell dialog (surface step 09): a
// double-click on a surface's rim edge takes the rim loop, a loaded
// surface's included, kept whole as the menu's Boundary Loop is, while any
// other edge still expands to its bucket as plain picks; the right-click
// menu offers the loop groups, previews one on hover, and keeps the one
// chosen as a chain the synthesis is asked to write as a loop.

beforeAll(() => {
  // jsdom has no ResizeObserver/rAF; the toolbar only measures with them.
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  (globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

let server: FakeSelectionServer;

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSelectionServer().install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const edge = (index: number, shapeId = 'sheet'): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });
const face = (index: number, shapeId = 'block'): SelectedEntity => ({ shapeId, sub: { type: 'face', index } });

/** A viewer that records the highlight; every other call is a no-op. */
function stubViewer() {
  const highlights: SelectedEntity[][] = [];
  const base: Record<string, unknown> = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    sceneIsEmpty: false,
    currentSceneObjects: [],
    sceneContext: {
      scene: new Scene(),
      renderer: { domElement: document.createElement('canvas') },
      camera: new PerspectiveCamera(),
      requestRender: () => {},
    },
    highlightEntities: (entities: SelectedEntity[]) => highlights.push(entities),
    clearHighlight: () => highlights.push([]),
  };
  const viewer = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : () => () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Viewer;
  return { viewer, highlights };
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, highlights } = stubViewer();
  const service = new ModifyPickService(container, viewer, new Navbar(container));
  service.enter('fillet');
  const chips = () => [...container.querySelectorAll<HTMLElement>('[data-role="selection-slot"] span.truncate[title]')]
    .map(el => el.textContent);
  const menuItems = () => [...container.querySelectorAll<HTMLButtonElement>('#fluidcad-modify-pick-menu button')];
  /** The viewer's double-click: its two clicks land first, toggling the pick on and off again. */
  const doubleClick = async (entity: SelectedEntity) => {
    service.handleClick(entity.shapeId, entity.sub);
    service.handleClick(entity.shapeId, entity.sub);
    await service.handleDoubleClick(entity.shapeId, entity.sub);
  };
  /** The last synthesis preview the dialog asked for. */
  const lastPreview = async () => {
    await vi.advanceTimersByTimeAsync(400);
    return server.bodies('api/apply-feature').filter(body => body.preview).at(-1);
  };
  return { service, container, highlights, chips, menuItems, doubleClick, lastPreview };
}

describe('the fillet dialog\'s double-click', () => {
  it('takes the rim loop of a surface edge whole, a chain the synthesis writes as a loop', async () => {
    const { service, chips, doubleClick, lastPreview } = mount();
    const loop = [edge(1), edge(2), edge(5)];
    server.loop = () => ({ rim: true, members: loop });
    await doubleClick(edge(2));
    expect(chips()).toEqual(['Loop (3 edges)']);
    expect(server.count('api/selection/expand-bucket')).toBe(0);
    const preview = await lastPreview();
    expect(preview.entities).toEqual(loop);
    expect(preview.chains).toEqual([{ seed: edge(2), members: loop, kind: 'loop' }]);
    service.exit();
  });

  it('takes the rim loop of a loaded surface, which has no bucket to expand to', async () => {
    const { service, chips, doubleClick, container } = mount();
    server.loop = () => ({ rim: true, members: [edge(0), edge(3)] });
    await doubleClick(edge(3));
    expect(chips()).toEqual(['Loop (2 edges)']);
    expect(container.textContent).not.toContain('no classified bucket');
    service.exit();
  });

  it('expands any other edge to its bucket, as plain picks, as before', async () => {
    const { service, chips, doubleClick, lastPreview } = mount();
    server.bucket = () => ({ members: [edge(4, 'block'), edge(6, 'block'), edge(9, 'block')] });
    await doubleClick(edge(4, 'block'));
    expect(server.count('api/selection/expand-loop')).toBe(1);
    expect(chips()).toEqual(['Edge', 'Edge', 'Edge']);
    expect((await lastPreview()).chains).toEqual([]);
    service.exit();
  });

  it('expands a face to its bucket without asking about a rim', async () => {
    const { service, chips, doubleClick } = mount();
    server.bucket = () => ({ members: [face(1), face(2)] });
    await doubleClick(face(1));
    expect(server.count('api/selection/expand-loop')).toBe(0);
    expect(chips()).toEqual(['Face', 'Face']);
    service.exit();
  });
});

describe('the fillet dialog\'s right-click menu', () => {
  const LOOP = [edge(1), edge(2), edge(5)];

  async function openOn(rig: ReturnType<typeof mount>, seed: SelectedEntity) {
    server.groups = [
      { kind: 'loop', label: 'Boundary Loop', members: LOOP },
      { kind: 'same-type', label: 'All Splines', members: [edge(1), edge(2)] },
    ];
    rig.service.handleContextMenu(seed.shapeId, seed.sub, 20, 20);
    await vi.advanceTimersByTimeAsync(0);
    return rig.menuItems().find(b => b.textContent === 'Boundary Loop (3)');
  }

  it('offers the loop groups and previews one on hover', async () => {
    const rig = mount();
    const item = await openOn(rig, edge(2));
    expect(rig.menuItems().map(b => b.textContent)).toEqual(['Boundary Loop (3)', 'All Splines (2)']);
    item!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(rig.highlights.at(-1)).toEqual(LOOP);
    rig.service.exit();
  });

  it('keeps a chosen loop as a chain the synthesis writes as a loop', async () => {
    const rig = mount();
    (await openOn(rig, edge(2)))!.click();
    expect(rig.chips()).toEqual(['Loop (3 edges)']);
    const preview = await rig.lastPreview();
    expect(preview.entities).toEqual(LOOP);
    expect(preview.chains).toEqual([{ seed: edge(2), members: LOOP, kind: 'loop' }]);
    rig.service.exit();
  });

  it('stays one chain when chosen twice, and goes whole when a member is clicked off', async () => {
    const rig = mount();
    (await openOn(rig, edge(2)))!.click();
    (await openOn(rig, edge(5)))!.click();
    expect(rig.chips()).toEqual(['Loop (3 edges)']);
    expect((await rig.lastPreview()).chains).toEqual([{ seed: edge(5), members: LOOP, kind: 'loop' }]);

    rig.service.handleClick('sheet', edge(1).sub);
    expect(rig.chips()).toEqual([]);
    rig.service.exit();
  });
});
