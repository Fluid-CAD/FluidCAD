// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// A model can hold surfaces (an imported STEP sheet) and curves (a helix)
// beside its solids. The tools that move, copy, repeat or paint whole shapes
// work on surfaces too, so they stay on the toolbar of a scene that holds
// nothing but a surface, and their whole-shape pickers take one; the tools
// that reshape solids (fillet, chamfer, shell) stay off it.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchFeatureSources: vi.fn(async () => ({ ok: false, reason: 'unused' })),
}));

import { PerspectiveCamera, Scene } from 'three';
import { BODY_KINDS, MODEL_KINDS, hasCurve, hasSolid, hasSurface, isSceneEmpty } from '../src/helpers/scene-utils';
import { collectSolidTargets, solidTargetForShapeId } from '../src/interactive/create-feature/solid-targets';
import { TranslateFeatureService } from '../src/interactive/create-feature/translate-service';
import { RotateFeatureService } from '../src/interactive/create-feature/rotate-service';
import { MirrorFeatureService } from '../src/interactive/create-feature/mirror-service';
import { CopyFeatureService } from '../src/interactive/create-feature/copy-service';
import { RepeatFeatureService } from '../src/interactive/create-feature/repeat-service';
import { ColorFeatureService } from '../src/interactive/create-feature/color-service';
import { ModifyPickService } from '../src/interactive/modify-pick/modify-pick-service';
import { isShownOnBar } from '../src/ui/quick-find/tool-index';
import { Navbar } from '../src/ui/navbar';
import type { SceneObjectRender } from '../src/types';
import type { Viewer } from '../src/viewer';

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

afterEach(() => {
  document.body.innerHTML = '';
});

const FILE = '/ws/m.fluid.js';

type Row = Partial<SceneObjectRender> & { id: string; type: string };

function row(r: Row, line: number): SceneObjectRender {
  return { name: r.type, sourceLocation: { filePath: FILE, line, column: 0 }, sceneShapes: [], ...r } as SceneObjectRender;
}

const SURFACE = row({ id: 'o1', type: 'load', name: 'Load 1', sceneShapes: [{ shapeId: 'sheet', shapeType: 'surface', meshes: [] }] as any }, 3);
const HELIX = row({ id: 'o2', type: 'helix', name: 'Helix 1', sceneShapes: [{ shapeId: 'coil', shapeType: 'edge', meshes: [] }] as any }, 4);
const SOLID = row({ id: 'o3', type: 'extrude', name: 'Extrude 1', sceneShapes: [{ shapeId: 'block', shapeType: 'solid', meshes: [] }] as any }, 5);
const SKETCH = row({ id: 'o4', type: 'sketch', name: 'Sketch 1', sceneShapes: [{ shapeId: 'profile', shapeType: 'wire', meshes: [] }] as any }, 6);
const LINE_IN_SKETCH = row({ id: 'o5', type: 'line', parentId: 'o4', sceneShapes: [{ shapeId: 'seg', shapeType: 'edge', meshes: [] }] as any }, 7);
const EDGE_SELECTION = row({ id: 'o6', type: 'select', sceneShapes: [{ shapeId: 'picked', shapeType: 'edge', meshes: [] }] as any }, 8);

describe('what the scene holds', () => {
  it('tells solids, surfaces and curves apart', () => {
    expect([hasSolid([SURFACE]), hasSurface([SURFACE]), hasCurve([SURFACE])]).toEqual([false, true, false]);
    expect([hasSolid([SOLID]), hasSurface([SOLID]), hasCurve([SOLID])]).toEqual([true, false, false]);
    expect(hasCurve([HELIX])).toBe(true);
  });

  it('counts no sketch line or selected edge as a curve of the model', () => {
    // A sketch is a profile to build from, a selection's edges belong to the
    // body they were picked on.
    expect(hasCurve([SKETCH, LINE_IN_SKETCH, EDGE_SELECTION])).toBe(false);
  });

  it('ignores construction', () => {
    const meta = row({ id: 'm', type: 'load', sceneShapes: [{ shapeId: 'q', shapeType: 'surface', isMetaShape: true, meshes: [] }] as any }, 9);
    expect(hasSurface([meta])).toBe(false);
  });

  it('leaves a scene with only a surface not empty', () => {
    // Otherwise the blank-document toolbar would answer for it.
    expect(isSceneEmpty([SURFACE])).toBe(false);
  });
});

describe('whole-shape targets', () => {
  const scene = [SURFACE, HELIX, SOLID, SKETCH, LINE_IN_SKETCH, EDGE_SELECTION];

  it('stay solids for the tools that work on solids', () => {
    expect(collectSolidTargets(scene).map(option => option.label)).toEqual(['Extrude 1']);
  });

  it('take surfaces for colour and surfaces and curves for the moves and copies', () => {
    expect(collectSolidTargets(scene, BODY_KINDS).map(option => option.label)).toEqual(['Load 1', 'Extrude 1']);
    expect(collectSolidTargets(scene, MODEL_KINDS).map(option => option.label)).toEqual(['Load 1', 'Helix 1', 'Extrude 1']);
  });

  it('resolve a click on a surface or a curve to its statement', () => {
    const options = collectSolidTargets(scene, MODEL_KINDS);
    expect(solidTargetForShapeId('sheet', options)?.line).toBe(3);
    expect(solidTargetForShapeId('coil', options)?.line).toBe(4);
    expect(solidTargetForShapeId('seg', options)).toBeUndefined();
  });
});

function stubViewer(): Viewer {
  const camera = new PerspectiveCamera();
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
      camera,
      requestRender: () => {},
    },
  };
  // Every other viewer call the services make on construction or update is
  // a no-op here: only the toolbar's answer is under test.
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : () => () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Viewer;
}

type ServiceCtor = new (container: HTMLElement, viewer: Viewer, navbar: Navbar) => { update(scene: SceneObjectRender[]): void };

function shownAfterUpdate(Service: ServiceCtor, label: string, scene: SceneObjectRender[]): boolean {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const service = new Service(container, stubViewer(), new Navbar(container));
  service.update(scene);
  const button = [...container.querySelectorAll('button')]
    .find(b => b.textContent?.trim() === label);
  if (!button) {
    throw new Error(`no ${label} button`);
  }
  return isShownOnBar(button);
}

describe('toolbar with only a surface in the scene', () => {
  const tools: [string, ServiceCtor][] = [
    ['Translate', TranslateFeatureService as unknown as ServiceCtor],
    ['Rotate', RotateFeatureService as unknown as ServiceCtor],
    ['Mirror', MirrorFeatureService as unknown as ServiceCtor],
    ['Copy', CopyFeatureService as unknown as ServiceCtor],
    ['Repeat', RepeatFeatureService as unknown as ServiceCtor],
    ['Color', ColorFeatureService as unknown as ServiceCtor],
  ];

  it.each(tools)('offers %s', (label, Service) => {
    expect(shownAfterUpdate(Service, label, [SURFACE])).toBe(true);
  });

  it('keeps Fillet off: it reshapes solids', () => {
    expect(shownAfterUpdate(ModifyPickService as unknown as ServiceCtor, 'Fillet', [SURFACE])).toBe(false);
    expect(shownAfterUpdate(ModifyPickService as unknown as ServiceCtor, 'Fillet', [SURFACE, SOLID])).toBe(true);
  });
});
