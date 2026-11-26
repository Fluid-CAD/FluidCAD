// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Helix opens from the Curves menu: its cell is the launcher the Helix
// dialog service is built with, in place of a button of its own in the
// create group. The cell opens and closes the dialog, reads as armed while
// it is open, greys when Helix has nothing to work on, and Quick Find runs
// it as `part:helix` under the Curves bench.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  fetchFeatureGhost: vi.fn(async () => null),
  applyHelix: vi.fn(async () => ({ success: true, preview: 'helix(…)' })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import { PerspectiveCamera, Scene } from 'three';
import { HelixFeatureService } from '../src/interactive/create-feature/helix-service';
import { ToolMenu } from '../src/interactive/create-feature/tool-menu';
import { Navbar } from '../src/ui/navbar';
import { toolIndex } from '../src/ui/quick-find/tool-index';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE } from '../src/ui/toolbar-styles';
import type { SceneObjectRender } from '../src/types';
import type { Viewer } from '../src/viewer';

// The toolbar measures itself with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

const menus: ToolMenu[] = [];
const services: HelixFeatureService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const service of services.splice(0)) {
    service.exit();
  }
  for (const menu of menus.splice(0)) {
    menu.close();
  }
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/plate.part.js';
const at = (line: number, column: number) => ({ filePath: FILE, line, column });

/** A part holding a plate (a solid). */
function plateScene(): SceneObjectRender[] {
  return [
    { id: 'part', type: 'part', isContainer: true, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: at(3, 22) },
    {
      id: 'plate', type: 'extrude', name: 'Extrude', parentId: 'part', visible: true, ownShapes: [],
      sceneShapes: [{ shapeId: 'solid', shapeType: 'solid', meshes: [] }], sourceLocation: at(5, 12),
    },
  ] as SceneObjectRender[];
}

/** A part holding nothing Helix can start from: one connector. */
function connectorOnlyScene(): SceneObjectRender[] {
  return [
    { id: 'part', type: 'part', isContainer: true, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: at(3, 22) },
    {
      id: 'pin', type: 'connector', name: 'pin', parentId: 'part', visible: true, sceneShapes: [], ownShapes: [],
      object: {
        name: 'pin',
        origin: { x: 0, y: 0, z: 0 },
        xDirection: { x: 1, y: 0, z: 0 },
        yDirection: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      sourceLocation: at(4, 14),
    },
  ] as SceneObjectRender[];
}

/** A viewer answering what the Helix dialog asks of it. */
function stubViewer(): Viewer {
  const scene = new Scene();
  const viewer = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    missedSketchRender: false,
    sceneIsEmpty: false,
    sceneContext: { scene, camera: new PerspectiveCamera(), requestRender: () => {} },
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: () => {},
    highlightPlaneQuad: () => {},
    highlightShapes: () => {},
    clearHighlight: () => {},
    showStandardAxes: () => {},
    hideStandardAxes: () => {},
    setSelectedStandardAxes: () => {},
    setConnectorPicking: () => {},
    setPickedConnectors: () => {},
    setHoveredConnector: () => {},
  };
  return viewer as unknown as Viewer;
}

/** The page's bar as main.ts builds it around Helix: create, the Curves menu, modify. */
function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const navbar = new Navbar(container);
  const create = navbar.addGroup('create', { immune: true });
  navbar.addGroup('modify');
  const curves = new ToolMenu(navbar, {
    group: 'curves',
    before: 'modify',
    label: 'Curves',
    icon: 'curves',
    tip: 'Curve tools',
    tool: 'curves',
    bench: 'Curves',
    quickFindPrefix: 'part',
    emptyText: 'No tools yet',
  });
  menus.push(curves);
  const cell = curves.add({
    id: 'helix',
    label: 'Helix',
    iconSrc: 'icons/helix.png',
    tip: 'Build a helix around an axis or on a cylindrical face',
    order: 0,
  });
  const service = new HelixFeatureService(container, stubViewer(), navbar, cell);
  services.push(service);
  service.update(plateScene());
  const menuButton = container.querySelector<HTMLElement>('[data-tool="curves"] button')!;
  const panel = () => document.querySelector<HTMLElement>('[data-role="curves-menu"]');
  const helixCell = () => {
    if (!curves.isOpen) {
      menuButton.click();
    }
    return panel()!.querySelector<HTMLButtonElement>('[data-tool="helix"] button')!;
  };
  return { create, curves, cell, service, menuButton, panel, helixCell };
}

describe('Helix in the Curves menu', () => {
  it('has a cell in Curves and no button in the create group', () => {
    const { create, helixCell } = mount();
    expect(helixCell().textContent).toBe('Helix');
    expect([...create.querySelectorAll('button')].some(b => b.textContent?.includes('Helix'))).toBe(false);
  });

  it('opens the dialog from its cell and reads as armed while it is open', () => {
    const { curves, cell, service, menuButton, helixCell } = mount();
    helixCell().click();
    expect(service.isActive).toBe(true);
    expect(curves.isOpen).toBe(false);
    expect(cell.active).toBe(true);
    expect(menuButton.className).toBe(TOOLBAR_BTN_ACTIVE);
    expect(helixCell().className).toContain('btn-primary');

    // The cell toggles, as the toolbar button did.
    helixCell().click();
    expect(service.isActive).toBe(false);
    expect(cell.active).toBe(false);
    expect(menuButton.className).toBe(TOOLBAR_BTN_BASE);
  });

  it('greys its cell while Helix has nothing to work on', () => {
    const { service, cell, helixCell } = mount();
    expect(helixCell().disabled).toBe(false);
    service.update(connectorOnlyScene());
    expect(cell.disabled).toBe(true);
    expect(helixCell().disabled).toBe(true);
    expect(toolIndex.get('part:helix')!.isDisabled!()).toBe(true);
    service.update(plateScene());
    expect(helixCell().disabled).toBe(false);
  });

  it('is run by Quick Find as part:helix, under Curves', () => {
    const { service } = mount();
    const entry = toolIndex.get('part:helix')!;
    expect(entry.bench).toBe('Curves');
    expect(entry.isAvailable()).toBe(true);
    expect(toolIndex.search('spiral').map(match => match.tool.id)).toContain('part:helix');
    entry.run();
    expect(service.isActive).toBe(true);
    expect(entry.isActive!()).toBe(true);
  });
});
