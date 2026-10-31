// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Color dialog: the Solid tab paints whole solids picked by any face or
// edge click, the Face tab single faces with the synthesized selectors in
// the expression row; the picks wear the chosen colour in the viewport; a
// selection seeds the tab it fits; the colour field takes hex values,
// names and swatches and blocks a value that is no colour; and the edit
// dialog reopens an object paint with its targets and a face paint with the
// kernel's faces, keeping untouched arguments verbatim.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  applyColor: vi.fn(async (options: { preview?: boolean }) => options.preview
    ? { success: true, preview: "color('…')", args: 'e.endFaces()', alternatives: ['select(face().top())'] }
    : { success: true, preview: "color('…')" }),
  applyColorEdit: vi.fn(async () => ({ success: true, preview: "color('…')" })),
  fetchFeatureSources: vi.fn(async () => ({ ok: false, reason: 'unused' })),
  fetchSelectionGroups: vi.fn(async () => ({ groups: [] })),
  expandBucket: vi.fn(async () => ({ members: [] })),
  getScopeVariables: vi.fn(async () => []),
  rollback: vi.fn(),
  continueBreakpoint: vi.fn(),
}));

import { applyColor, applyColorEdit, fetchFeatureSources, getScopeVariables } from '../src/api';
import { ColorFeatureService } from '../src/interactive/create-feature/color-service';
import { ColorValues } from '../src/interactive/create-feature/color-values';
import { Navbar } from '../src/ui/navbar';
import type { SceneObjectRender } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';

// The toolbar measures itself with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

const FILE = '/ws/m.fluid.js';
const at = (line: number, column: number) => ({ filePath: FILE, line, column });
const FACE = (index: number): SelectedEntity => ({ shapeId: 's1', sub: { type: 'face', index } });

/** Two extrudes; with `paint`, a colour row at line 7 after them (the edited statement). */
function scene(paint = false): SceneObjectRender[] {
  const rows = [
    {
      id: 'o1', type: 'extrude', name: 'Extrude 1', sourceLocation: at(4, 10),
      sceneShapes: [{ shapeId: 's1', shapeType: 'solid', meshes: [] }],
    },
    {
      id: 'o2', type: 'extrude', name: 'Extrude 2', sourceLocation: at(6, 10),
      sceneShapes: [{ shapeId: 's2', shapeType: 'solid', meshes: [] }],
    },
  ];
  if (paint) {
    rows.push({ id: 'o3', type: 'color', name: 'Color 1', sourceLocation: at(7, 0), sceneShapes: [] });
  }
  return rows as unknown as SceneObjectRender[];
}

type Highlight = { entities: SelectedEntity[]; solids: string[]; tint?: string };

function mount(seed: SelectedEntity[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const highlights: (Highlight | null)[] = [];
  let rows = scene();
  const viewer = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    sceneIsEmpty: false,
    missedSketchRender: false,
    get currentSceneObjects() {
      return rows;
    },
    highlightEntities: (entities: SelectedEntity[], _wires: string[], solids: string[], _quads: string[], _instance: string | null, options?: { tint?: string }) => {
      highlights.push({ entities, solids, tint: options?.tint });
    },
    clearHighlight: () => {
      highlights.push(null);
    },
    clearHover: () => {},
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
  };
  const service = new ColorFeatureService(container, viewer as unknown as Viewer, new Navbar(container), {
    onEnter: () => ({ seed }),
  });
  service.update(rows);
  const q = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const chips = (slot: 'targets' | 'faces') =>
    [...container.querySelectorAll<HTMLElement>(`[data-role="${slot}-slot"] span.truncate[title]`)].map(el => el.textContent);
  return {
    container, service, viewer, highlights,
    setScene: (next: SceneObjectRender[]) => { rows = next; },
    chips,
    message: () => q('[data-role="message"]').textContent,
    tab: (label: 'Solid' | 'Face') =>
      [...container.querySelectorAll<HTMLButtonElement>('[data-role="tabs"] button')].find(b => b.textContent === label)!.click(),
    value: () => q<HTMLInputElement>('[data-role="value"]'),
    well: () => q<HTMLInputElement>('[data-role="well"]'),
    type: (text: string) => {
      const input = q<HTMLInputElement>('[data-role="value"]');
      input.value = text;
      input.dispatchEvent(new Event('input'));
    },
    swatch: (name: string) => q<HTMLButtonElement>(`button[data-swatch="${name}"]`).click(),
    expression: () => q<HTMLInputElement>('[data-role="expr"]'),
    apply: () => q<HTMLButtonElement>('[data-role="apply"]').click(),
    lastHighlight: () => highlights[highlights.length - 1],
  };
}

/** Let the debounced preview settle. */
const settle = () => vi.advanceTimersByTimeAsync(400);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('ColorValues', () => {
  it('normalizes hex values and names, keeps rgb() strings, and refuses the rest', () => {
    expect(ColorValues.normalize(' #3498DB ')).toBe('#3498db');
    expect(ColorValues.normalize('#FFF')).toBe('#fff');
    expect(ColorValues.normalize('SteelBlue')).toBe('steelblue');
    expect(ColorValues.normalize('rgb(10, 20, 30)')).toBe('rgb(10, 20, 30)');
    expect(ColorValues.normalize('rgba(10 20 30 / 0.5)')).toBe('rgba(10 20 30 / 0.5)');
    expect(ColorValues.normalize('notacolour')).toBeNull();
    expect(ColorValues.normalize('#12345')).toBeNull();
    expect(ColorValues.normalize('')).toBeNull();
  });

  it('gives the colour well a hex value for hex and names, none for rgb()', () => {
    expect(ColorValues.toHex('#abc')).toBe('#aabbcc');
    expect(ColorValues.toHex('tomato')).toBe('#ff6347');
    expect(ColorValues.toHex('rgb(1, 2, 3)')).toBeNull();
    expect(ColorValues.toHex('nope')).toBeNull();
  });
});

describe('ColorFeatureService', () => {
  it('opens on the Solid tab: a face click picks the whole solid, tinted with the colour, and the apply names its statement', async () => {
    const rig = mount();
    rig.service.enter();
    expect(rig.viewer.pickFilter).toBe('all');
    rig.service.handleClick('s1', { type: 'face', index: 0 });
    expect(rig.chips('targets')).toEqual(['Extrude 1']);
    expect(rig.lastHighlight()).toEqual({ entities: [], solids: ['s1'], tint: '#3498db' });
    // A second click on the same solid toggles it off; an edge click picks its solid too.
    rig.service.handleClick('s1', { type: 'edge', index: 3 });
    expect(rig.chips('targets')).toEqual([]);
    rig.service.handleClick('s2', { type: 'edge', index: 3 });
    expect(rig.chips('targets')).toEqual(['Extrude 2']);
    await settle();
    expect(vi.mocked(applyColor).mock.lastCall?.[0]).toMatchObject({
      value: '#3498db', paint: { kind: 'solids', targets: [at(6, 10)] }, preview: true,
    });

    rig.apply();
    await settle();
    expect(vi.mocked(applyColor).mock.lastCall?.[0]).toEqual({
      value: '#3498db', paint: { kind: 'solids', targets: [at(6, 10)] },
    });
    expect(rig.service.isActive).toBe(false);
  });

  it('paints faces on the Face tab, refusing edges, with the synthesized selectors editable in the expression row', async () => {
    const rig = mount();
    rig.service.enter();
    rig.tab('Face');
    expect(rig.viewer.pickFilter).toBe('face');
    rig.service.handleClick('s1', { type: 'edge', index: 0 });
    expect(rig.message()).toContain('Pick a face');
    rig.service.handleClick('s1', { type: 'face', index: 2 });
    rig.service.handleClick('s1', { type: 'face', index: 4 });
    expect(rig.chips('faces')).toEqual(['Face — Extrude 1', 'Face — Extrude 1']);
    expect(rig.lastHighlight()).toEqual({ entities: [FACE(2), FACE(4)], solids: [], tint: '#3498db' });

    await settle();
    expect(vi.mocked(applyColor).mock.lastCall?.[0]).toMatchObject({
      paint: { kind: 'faces', entities: [FACE(2), FACE(4)], chains: [] }, preview: true,
    });
    expect(rig.expression().value).toBe('e.endFaces()');

    // The expression edited away from the synthesis rides the apply verbatim.
    rig.expression().value = 'select(face().top())';
    rig.apply();
    await settle();
    expect(vi.mocked(applyColor).mock.lastCall?.[0]).toEqual({
      value: '#3498db',
      paint: { kind: 'faces', entities: [FACE(2), FACE(4)], chains: [], selectorOverride: 'select(face().top())' },
    });
  });

  it('takes a name or a swatch into the colour field, retints the picks, and blocks a value that is no colour', async () => {
    const rig = mount();
    rig.service.enter();
    rig.service.handleClick('s1', { type: 'face', index: 0 });
    rig.type('SteelBlue');
    expect(rig.well().value).toBe('#4682b4');
    expect(rig.lastHighlight()?.tint).toBe('steelblue');
    rig.swatch('tomato');
    expect(rig.value().value).toBe('tomato');
    expect(rig.well().value).toBe('#ff6347');
    rig.type('nope');
    rig.apply();
    await settle();
    expect(rig.message()).toContain('Enter a colour');
    expect(vi.mocked(applyColor).mock.calls.filter(([options]) => !options.preview)).toHaveLength(0);
  });

  it('seeds the Face tab from a face selection and the Solid tab from anything else', () => {
    const faces = mount([FACE(1), FACE(3)]);
    faces.service.enter();
    expect(faces.chips('faces')).toHaveLength(2);
    expect(faces.viewer.pickFilter).toBe('face');
    faces.service.exit();
    document.body.innerHTML = '';

    const edges = mount([{ shapeId: 's1', sub: { type: 'edge', index: 1 } }, { shapeId: 's2', sub: { type: 'face', index: 0 } }]);
    edges.service.enter();
    expect(edges.chips('targets')).toEqual(['Extrude 1', 'Extrude 2']);
  });

  it('edits an object paint: the kept target becomes its row at the boundary and the apply sends the list', async () => {
    const rig = mount();
    vi.mocked(fetchFeatureSources).mockResolvedValue({
      ok: true, feature: 'color', selection: { kind: 'opaque' }, targets: [{ kind: 'sketch', ...at(4, 10) }],
    });
    rig.service.enterEdit(at(7, 0), {
      feature: 'color', value: 'red', argsText: 'e', targetTexts: ['e'], targetRefs: [{ line: 4, column: 10 }],
    }, { index: 2, type: 'color', expectedStatement: "color('red', e)" });
    expect(rig.value().value).toBe('red');
    expect(rig.chips('targets')).toEqual(['Current: e']);

    rig.setScene(scene(true));
    rig.service.handleSceneRendered(scene(true), 1, true);
    await settle();
    expect(rig.chips('targets')).toEqual(['Extrude 1']);
    expect(rig.lastHighlight()).toEqual({ entities: [], solids: ['s1'], tint: 'red' });

    rig.service.handleClick('s2', { type: 'face', index: 0 });
    rig.apply();
    await settle();
    expect(vi.mocked(applyColorEdit).mock.lastCall).toEqual([at(7, 0), {
      value: 'red',
      paint: { kind: 'solids', targets: [{ kind: 'feature', ...at(4, 10) }, { kind: 'feature', ...at(6, 10) }] },
      expectedStatement: "color('red', e)",
      before: { index: 2, type: 'color', line: 7, column: 0 },
    }]);
  });

  it('edits a face paint: the kernel seeds the faces, an untouched apply keeps the arguments, a re-pick sends them', async () => {
    const rig = mount();
    vi.mocked(fetchFeatureSources).mockResolvedValue({
      ok: true, feature: 'color', selection: { kind: 'entities', entities: [FACE(2)] }, targets: [],
    });
    rig.service.enterEdit(at(7, 0), {
      feature: 'color', value: '#ff6347', argsText: 'e.endFaces()', targetTexts: ['e.endFaces()'], targetRefs: [null],
    }, { index: 2, type: 'color', expectedStatement: "color('#ff6347', e.endFaces())" });
    expect(rig.viewer.pickFilter).toBe('face');
    expect(rig.expression().value).toBe('e.endFaces()');

    rig.setScene(scene(true));
    rig.service.handleSceneRendered(scene(true), 1, true);
    await settle();
    expect(rig.chips('faces')).toEqual(['Face — Extrude 1']);
    expect(rig.lastHighlight()).toEqual({ entities: [FACE(2)], solids: [], tint: '#ff6347' });

    rig.type('gold');
    rig.apply();
    await settle();
    expect(vi.mocked(applyColorEdit).mock.lastCall?.[1]).toEqual({
      value: 'gold',
      expectedStatement: "color('#ff6347', e.endFaces())",
      before: { index: 2, type: 'color', line: 7, column: 0 },
    });

    // A re-opened dialog with one more face picked re-synthesizes against the boundary.
    vi.mocked(applyColorEdit).mockClear();
    rig.service.enterEdit(at(7, 0), {
      feature: 'color', value: '#ff6347', argsText: 'e.endFaces()', targetTexts: ['e.endFaces()'], targetRefs: [null],
    }, { index: 2, type: 'color', expectedStatement: "color('#ff6347', e.endFaces())" });
    rig.service.handleSceneRendered(scene(true), 1, true);
    await settle();
    rig.service.handleClick('s1', { type: 'face', index: 5 });
    rig.apply();
    await settle();
    expect(vi.mocked(applyColorEdit).mock.lastCall?.[1]).toMatchObject({
      value: '#ff6347',
      paint: { kind: 'faces', entities: [FACE(2), FACE(5)], chains: [] },
      before: { index: 2, type: 'color', line: 7, column: 0 },
    });
  });

  // The colour slot takes an expression: it rides the preview and the apply
  // as it stands — the build judges what it comes to — while the picks wear
  // the colour it resolves to by the scope's variables, or the plain
  // highlight until that is a colour.
  it('carries an expression in the colour slot to the apply as written, tinting the picks by what it comes to', async () => {
    vi.mocked(getScopeVariables).mockResolvedValue([{ name: 'tint', initializer: "'tomato'", numeric: false, value: 'tomato' }]);
    const rig = mount();
    rig.service.enter();
    rig.service.handleClick('s1', { type: 'face', index: 0 });
    rig.container.querySelector<HTMLButtonElement>('[data-role="expression-value"]')!.click();
    const expression = rig.container.querySelector<HTMLInputElement>('[data-role="expr-value"]')!;
    expression.value = 'tint';
    expression.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(rig.lastHighlight()).toEqual({ entities: [], solids: ['s1'], tint: 'tomato' });
    expect(vi.mocked(applyColor).mock.lastCall?.[0]).toMatchObject({ value: { expr: 'tint' }, preview: true });
    rig.apply();
    await settle();
    expect(vi.mocked(applyColor).mock.lastCall?.[0]).toEqual({
      value: { expr: 'tint' }, paint: { kind: 'solids', targets: [at(4, 10)] },
    });
    // An edited statement holding an expression opens the field in that mode and writes it back verbatim.
    rig.service.enterEdit(at(7, 0), {
      feature: 'color', value: { expr: 'tint' }, argsText: 'e', targetTexts: ['e'], targetRefs: [{ line: 4, column: 10 }],
    }, { index: 2, type: 'color', expectedStatement: 'color(tint, e)' });
    expect(expression.value).toBe('tint');
    rig.apply();
    await settle();
    expect(vi.mocked(applyColorEdit).mock.lastCall?.[1]).toMatchObject({ value: { expr: 'tint' } });
  });
});
