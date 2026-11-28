// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The extrude dialog takes a planar face of a solid as its profile: with the
// profile slot holding the viewport (the default), a face click replaces the
// sketch, and the statement sweeps that face as it stands — `extrude(25,
// e.endFaces())`. The apply and the ghost both carry the face as a pick; the
// "Up to face" direction keeps its own slot for the target. An edit of a
// face-sourced statement keeps its profile text and previews from the face
// the sources query resolved it to; a re-pick travels with the boundary.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  fetchFeatureGhost: vi.fn(async () => null),
  applyExtrude: vi.fn(async () => ({ success: true, preview: 'extrude(…)' })),
  applyExtrudeEdit: vi.fn(async () => ({ success: true, preview: 'extrude(…)' })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import { PerspectiveCamera, Scene } from 'three';
import * as api from '../src/api';
import { ExtrudeFeatureService } from '../src/interactive/create-feature/extrude-service';
import { Navbar } from '../src/ui/navbar';
import type { SceneObjectRender, SubSelection } from '../src/types';
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/plate.fluid.js';

const at = (line: number, column: number) => ({ filePath: FILE, line, column });

const face = (index: number): SubSelection => ({ type: 'face', index });

/**
 * A plate (a solid built from a consumed sketch) and a second, unconsumed
 * sketch. `suffix` re-mints every id — what a render does to rebuilt rows.
 */
function plateScene(suffix = ''): SceneObjectRender[] {
  const id = (name: string) => `${name}${suffix}`;
  return [
    {
      id: id('plate'), type: 'extrude', name: 'Extrude', visible: true, ownShapes: [],
      sceneShapes: [{ shapeId: id('solid'), shapeType: 'solid', meshes: [] }], sourceLocation: at(4, 10),
    },
    {
      id: id('profile'), type: 'sketch', name: 'Sketch', visible: true, ownShapes: [],
      sceneShapes: [{ shapeId: id('wire'), shapeType: 'wire', meshes: [{}] }], sourceLocation: at(5, 10),
    },
  ] as SceneObjectRender[];
}

/** A viewer recording what the dialog highlights. */
function stubViewer() {
  const state = { highlighted: [] as { shapeId: string; sub: SubSelection }[] };
  const viewer = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickProfileWires: false,
    pickAxes: false,
    pickPlanes: false,
    missedSketchRender: false,
    sceneIsEmpty: false,
    sceneContext: { scene: new Scene(), camera: new PerspectiveCamera(), requestRender: () => {} },
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: (entities: { shapeId: string; sub: SubSelection }[]) => {
      state.highlighted = [...entities];
    },
    highlightPlaneQuad: () => {},
    highlightShapes: () => {},
    clearHighlight: () => {
      state.highlighted = [];
    },
  };
  return { viewer: viewer as unknown as Viewer, state };
}

function mount(seed: { shapeId: string; sub: SubSelection }[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state } = stubViewer();
  const service = new ExtrudeFeatureService(container, viewer, new Navbar(container), {
    onEnter: () => ({ seed }),
  });
  service.update(plateScene());
  return {
    service, viewer, state, container,
    text: (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)?.textContent ?? '',
    click: (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)!.click(),
    setDirection: (value: string) => {
      const select = container.querySelector<HTMLSelectElement>('[data-role="direction"]')!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
    },
  };
}

const lastApply = () => vi.mocked(api.applyExtrude).mock.calls.at(-1)![0];
const lastGhost = () => vi.mocked(api.fetchFeatureGhost).mock.calls.at(-1)![0];

describe('Extrude — a face as the profile', () => {
  it('takes a face click as the profile and sends it as a pick, to the apply and to the ghost', async () => {
    const { service, text } = mount();
    service.enter();
    expect(service.isProfileFacePicking).toBe(true);
    expect(service.isFacePicking).toBe(false);
    expect(text('profile-slot')).toContain('Sketch');

    service.handleClick('solid', face(3));
    expect(text('profile-slot')).toContain('Picked face');

    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply()).toMatchObject({
      op: 'add', distance: 25, thin: null, preview: true,
      profile: { mode: 'face', entity: { shapeId: 'solid', sub: { type: 'face', index: 3 } } },
    });
    expect(lastApply().regions).toBeUndefined();
    expect(lastGhost()).toMatchObject({
      feature: 'extrude', thin: null, profile: { kind: 'face', shapeId: 'solid', index: 3 },
    });
    expect((lastGhost() as { regions?: unknown }).regions).toBeUndefined();
    service.exit();
  });

  it('highlights the picked face, and clicking it again gives the slot back to the sketch', async () => {
    const { service, state, text } = mount();
    service.enter();
    service.handleClick('solid', face(3));
    expect(state.highlighted).toContainEqual({ shapeId: 'solid', sub: { type: 'face', index: 3 } });

    service.handleClick('solid', face(3));
    expect(text('profile-slot')).not.toContain('Picked face');
    expect(state.highlighted).not.toContainEqual({ shapeId: 'solid', sub: { type: 'face', index: 3 } });
    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply().profile).toMatchObject({ mode: 'active', line: 5 });
    service.exit();
  });

  it('ignores an edge click, and lets a sketch pick take the slot back', async () => {
    const { service, text } = mount();
    service.enter();
    service.handleClick('solid', { type: 'edge', index: 0 });
    expect(text('profile-slot')).not.toContain('Picked face');

    service.handleClick('solid', face(1));
    expect(text('profile-slot')).toContain('Picked face');
    expect(service.handleSketchPick('wire')).toBe(true);
    expect(text('profile-slot')).not.toContain('Picked face');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply().profile).toMatchObject({ mode: 'active', line: 5 });
    service.exit();
  });

  it('drops the face when a render re-mints the shapes — back to the sketch', () => {
    const { service, text } = mount();
    service.enter();
    service.handleClick('solid', face(3));
    service.update(plateScene('-r2'));
    expect(text('profile-slot')).not.toContain('Picked face');
    expect(text('profile-slot')).toContain('Sketch');
    service.exit();
  });

  it('sends "Up to face" clicks to the target, until the profile slot is armed again', async () => {
    const { service, text, setDirection, container } = mount();
    service.enter();
    setDirection('to-face');
    expect(service.isFacePicking).toBe(true);
    expect(service.isProfileFacePicking).toBe(false);
    service.handleClick('solid', face(2));
    expect(text('face-slot')).toContain('Picked face');
    expect(text('profile-slot')).not.toContain('Picked face');

    container.querySelector<HTMLElement>('[data-role="profile-slot"] .border')!.click();
    expect(service.isProfileFacePicking).toBe(true);
    expect(service.isFacePicking).toBe(false);
    service.handleClick('solid', face(5));
    expect(text('profile-slot')).toContain('Picked face');

    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply()).toMatchObject({
      distance: null,
      profile: { mode: 'face', entity: { shapeId: 'solid', sub: { type: 'face', index: 5 } } },
      toFace: { shapeId: 'solid', sub: { type: 'face', index: 2 } },
    });
    expect(lastGhost()).toMatchObject({
      profile: { kind: 'face', shapeId: 'solid', index: 5 },
      toFace: { kind: 'face', shapeId: 'solid', index: 2 },
    });
    service.exit();
  });

  it('refuses the same face as the profile and the "Up to face" target', async () => {
    const { service, setDirection, container } = mount();
    service.enter();
    service.handleClick('solid', face(3));
    setDirection('to-face');
    service.handleClick('solid', face(3));
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(api.applyExtrude)).not.toHaveBeenCalled();
    expect(container.textContent).toContain('also the face to extrude up to');

    service.handleClick('solid', face(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply()).toMatchObject({
      profile: { mode: 'face', entity: { shapeId: 'solid', sub: { type: 'face', index: 3 } } },
      toFace: { shapeId: 'solid', sub: { type: 'face', index: 2 } },
    });
    service.exit();
  });

  it('keeps the sketch when a face is clicked on "Up to first face" or "Up to last face"', async () => {
    for (const direction of ['first-face', 'last-face']) {
      const { service, text, setDirection, container } = mount();
      service.enter();
      setDirection(direction);
      service.handleClick('solid', face(3));
      expect(text('profile-slot')).toContain('Sketch');
      expect(text('profile-slot')).not.toContain('Picked face');
      expect(container.textContent).toContain('the sketch stays the profile');
      await vi.advanceTimersByTimeAsync(300);
      expect(lastApply()).toMatchObject({ profile: { mode: 'active', line: 5 }, toFace: direction });
      service.exit();
      document.body.innerHTML = '';
    }
  });

  it('keeps a face picked before the direction changed to "Up to first face", and re-picks it', async () => {
    const { service, text, setDirection } = mount();
    service.enter();
    service.handleClick('solid', face(3));
    setDirection('first-face');
    expect(text('profile-slot')).toContain('Picked face');
    service.handleClick('solid', face(4));
    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply()).toMatchObject({
      profile: { mode: 'face', entity: { shapeId: 'solid', sub: { type: 'face', index: 4 } } },
      toFace: 'first-face',
    });
    service.exit();
  });

  it('blocks the apply with nothing picked', async () => {
    const { service, container } = mount();
    service.update(plateScene().slice(0, 1));
    service.enter();
    expect(container.querySelector('[data-role="profile-slot"]')!.textContent).toContain('Pick a sketch or a face');
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(api.applyExtrude)).not.toHaveBeenCalled();
    service.exit();
  });
});

describe('Extrude — a face selected before the tool arms', () => {
  it('opens with the selected face as the profile, highlighted and previewed', async () => {
    const { service, state, text } = mount([{ shapeId: 'solid', sub: face(3) }]);
    service.enter();
    expect(text('profile-slot')).toContain('Picked face');
    expect(state.highlighted).toContainEqual({ shapeId: 'solid', sub: { type: 'face', index: 3 } });

    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply().profile).toEqual({ mode: 'face', entity: { shapeId: 'solid', sub: { type: 'face', index: 3 } } });
    expect(lastGhost()).toMatchObject({ profile: { kind: 'face', shapeId: 'solid', index: 3 } });
    service.exit();
  });

  it('hands the slot back to the default sketch when the seeded face is removed', async () => {
    const { service, container, text } = mount([{ shapeId: 'solid', sub: face(3) }]);
    service.enter();
    expect(text('profile-slot')).toContain('Picked face');
    container.querySelector<HTMLElement>('[data-role="profile-slot"] button')!.click();
    expect(text('profile-slot')).not.toContain('Picked face');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastApply().profile).toMatchObject({ mode: 'active', line: 5 });
    service.exit();
  });

  it('seeds nothing from an edge, or from more than one face', () => {
    const edge = mount([{ shapeId: 'solid', sub: { type: 'edge', index: 0 } }]);
    edge.service.enter();
    expect(edge.text('profile-slot')).not.toContain('Picked face');
    edge.service.exit();

    const two = mount([{ shapeId: 'solid', sub: face(1) }, { shapeId: 'solid', sub: face(2) }]);
    two.service.enter();
    expect(two.text('profile-slot')).not.toContain('Picked face');
    two.service.exit();
  });

  it('does not carry the seed into a second arming', () => {
    const seed = [{ shapeId: 'solid', sub: face(3) }];
    const { service, text } = mount(seed);
    service.enter();
    service.exit();
    seed.length = 0;
    service.enter();
    expect(text('profile-slot')).not.toContain('Picked face');
    service.exit();
  });
});

describe('Extrude — editing a face-sourced statement', () => {
  const TARGET = at(6, 0);
  const EDITED = {
    id: 'edited', type: 'extrude', name: 'Extrude', visible: true, sceneShapes: [], ownShapes: [], sourceLocation: TARGET,
  } as SceneObjectRender;
  const PARSED = {
    feature: 'extrude', op: 'add', distance: 12, distance2: null, symmetric: false, draft: null, endOffset: null,
    drill: true, thin: null, profileText: 'e.endFaces()', toFaceText: null, toFaceKind: null,
    scopeTexts: [], scopeRefs: [], regions: [],
  };

  function openEdit() {
    vi.mocked(api.fetchFeatureSources).mockResolvedValue({
      ok: true, feature: 'extrude',
      profile: { kind: 'entities', entities: [{ shapeId: 'solid', sub: { type: 'face', index: 4 } }] },
    });
    const rig = mount();
    rig.service.enterEdit(TARGET, PARSED as never, { index: 2, type: 'extrude', expectedStatement: 'extrude(12, e.endFaces())' });
    rig.service.handleSceneRendered([...plateScene(), EDITED], 1, true);
    return rig;
  }

  const lastEdit = () => vi.mocked(api.applyExtrudeEdit).mock.calls.at(-1)![1];

  it('keeps the profile as written, previews from the face it resolved to, and parks what a face cannot carry', async () => {
    const { service, text, state, container } = openEdit();
    await vi.runAllTimersAsync();

    expect(text('profile-slot')).toContain('Current: e.endFaces()');
    expect(state.highlighted).toContainEqual({ shapeId: 'solid', sub: { type: 'face', index: 4 } });
    expect(container.querySelector('[data-role="drill-wrap"]')!.classList.contains('hidden')).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-role="thin"]')!.disabled).toBe(true);
    expect(lastGhost()).toMatchObject({ feature: 'extrude', profile: { kind: 'face', shapeId: 'solid', index: 4 } });
    // Untouched, the edit sends no profile: the statement keeps `e.endFaces()`.
    expect(lastEdit().profile).toBeUndefined();
    expect(lastEdit().before).toBeUndefined();
    expect(lastEdit().regions).toEqual([]);
    service.exit();
  });

  it('re-picks the profile face against the pre-statement scene', async () => {
    const { service, text } = openEdit();
    await vi.runAllTimersAsync();
    expect(service.isProfileFacePicking).toBe(true);

    service.handleClick('solid', face(0));
    expect(text('profile-slot')).toContain('Picked face');
    await vi.runAllTimersAsync();
    expect(lastEdit()).toMatchObject({
      profile: { mode: 'face', entity: { shapeId: 'solid', sub: { type: 'face', index: 0 } } },
      before: { index: 2, type: 'extrude', line: 6, column: 0 },
      regions: [],
    });
    expect(lastEdit().regionSketch).toBeUndefined();
    expect(lastGhost()).toMatchObject({ profile: { kind: 'face', shapeId: 'solid', index: 0 } });
    service.exit();
  });
});
