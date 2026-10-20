// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A custom feature's dialog, end to end in the page: the catalog builds it
// from the feature's metadata, the registry routes picks and timeline edits
// to it, and its requests carry the values the user set, the picks, the
// operation and its scope — an edit only what changed. One dialog service
// per test file: the shared worker binds a service to the first file's api
// mock.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureSources: vi.fn(async () => ({ ok: false, reason: 'none' })),
  applyCustomFeature: vi.fn(async () => ({ success: true, preview: 'feature(…)' })),
  applyCustomFeatureEdit: vi.fn(async () => ({ success: true, preview: 'feature(…)' })),
  getFeatureCatalog: vi.fn(async () => []),
  fetchFeatureGhostResult: vi.fn(async () => ({ solids: [{ meshes: [] }], frames: [], notice: null })),
  fetchConnectorAnchors: vi.fn(async () => ({ ok: false, reason: null })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import * as api from '../src/api';
import type { FeatureCatalogEntry, FeatureMetaSnapshot, ParsedFeatureStatement } from '../src/api';
import { DerivedLayout, type BareFeatureMeta } from './fixtures/derived-layout';
import { FeatureCatalogDialogs } from '../src/interactive/create-feature/schema/feature-catalog-dialogs';
import { FeatureSchema } from '../src/interactive/create-feature/schema/feature-schema';
import { SchemaFeatureService } from '../src/interactive/create-feature/schema/schema-feature-service';
import { PreviewPreference } from '../src/interactive/create-feature/schema/preview-preference';
import { FinishSketchButton } from '../src/interactive/create-feature/finish-sketch-button';
import { FeatureGhostOverlay } from '../src/interactive/create-feature/feature-ghost';
import { FeatureDialogRegistry } from '../src/interactive/feature-dialog-registry';
import { setActivePartLocationProvider } from '../src/helpers/scene-utils';
import { Navbar } from '../src/ui/navbar';
import { ObjectIcons } from '../src/ui/object-icons';
import type { SceneObjectRender } from '../src/types';
import type { Viewer } from '../src/viewer';
import { Object3D, PerspectiveCamera, Scene } from 'three';

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
  localStorage.clear();
  setActivePartLocationProvider(() => null);
  document.body.innerHTML = '';
});

const FILE = '/ws/plate.part.js';
const at = (line: number, column = 2) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [], indices: [] }] as never;

function meta(id: string, label: string, params: FeatureMetaSnapshot['params'], extra: Partial<FeatureMetaSnapshot> = {}): FeatureMetaSnapshot {
  return DerivedLayout.snapshot({
    id, label, group: 'create', kind: 'tool', operations: [], defaultOperation: null, params, call: [],
    ghost: true, contexts: ['part'], ...extra,
  });
}

const STANDOFF = meta('acme.standoff', 'Standoff', {
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  height: { type: 'length', default: 10, min: 0, label: 'Height' },
  outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
  hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
}, { description: 'A boss with a bore', icon: './standoff.svg', operations: ['add', 'new'], defaultOperation: 'add' });

/** A feature reading a sketch, a face and an axis, with a depth it can't do without. */
const BRACKET = meta('acme.bracket', 'Bracket', {
  profile: { picker: 'sketch', label: 'Profile' },
  base: { picker: 'face', label: 'Base' },
  hinge: { picker: 'axis', label: 'Hinge', optional: true },
  depth: { type: 'length', label: 'Depth' },
  // No default declared: the engine's snapshot carries its first option.
  style: { type: 'select', label: 'Style', options: [{ label: 'Flat', value: 'flat' }, { label: 'Gusset', value: 'gusset' }], default: 'flat' },
  gusset: { type: 'length', label: 'Gusset size', default: 4, visibleWhen: { style: 'gusset' } },
}, { operations: ['add', 'remove', 'new'], defaultOperation: 'add' });

/**
 * A grille as the engine's snapshot carries it: its pattern and its chamfer
 * declare no default, so they resolve to the first option and off; its
 * finish is optional, so it stays unset.
 */
const GRILLE = meta('acme.grille', 'Grille', {
  face: { picker: 'face', label: 'Panel' },
  pattern: { type: 'select', label: 'Pattern', options: [{ label: 'Round', value: 'round' }, { label: 'Slot', value: 'slot' }], default: 'round' },
  chamfered: { type: 'boolean', label: 'Chamfered', default: false },
  finish: { type: 'select', label: 'Finish', optional: true, options: [{ label: 'Matte', value: 'matte' }, { label: 'Gloss', value: 'gloss' }] },
}, { operations: ['remove'], defaultOperation: 'remove', call: ['face', { pattern: 'pattern', chamfered: 'chamfered', finish: 'finish' }] });

/** A clip seat cut into a face: a rich select (a grid of images) and two radios, one of which may hold nothing. */
const CLIP = meta('acme.clip', 'Clip', {
  face: { picker: 'face', label: 'Panel' },
  size: {
    type: 'select', label: 'Size', default: 'm4', display: 'grid', columns: 2,
    options: ['m3', 'm4'].map(v => ({ label: v.toUpperCase(), value: v, image: `./clip/${v}.svg` })),
  },
  head: {
    type: 'radio', label: 'Head', default: 'pan', display: 'cards',
    options: [{ label: 'Pan', value: 'pan', image: './clip/pan.svg' }, { label: 'Hex', value: 'hex', image: './clip/hex.svg' }],
  },
  lock: { type: 'radio', label: 'Lock', optional: true, options: [{ label: 'Nylon', value: 'nylon' }, { label: 'Split', value: 'split' }] },
}, { icon: './clip.svg', operations: ['remove'], defaultOperation: 'remove', call: ['face', { size: 'size', head: 'head', lock: 'lock' }] });

/** A name plate engraved into a face: its depth and its text declare no default, so the dialog asks for both. */
const NAMEPLATE = meta('acme.nameplate', 'Nameplate', {
  face: { picker: 'face', label: 'On face' },
  depth: { type: 'length', label: 'Depth' },
  text: { type: 'text', label: 'Text' },
  note: { type: 'text', label: 'Note', optional: true },
}, { operations: ['remove'], defaultOperation: 'remove' });

/** A ring of holes that only cuts: remove is its one operation, and its default. */
const BOLT_CIRCLE = meta('acme.boltCircle', 'Bolt circle', {
  around: { picker: 'axis', label: 'Around axis' },
  count: { type: 'integer', default: 4, min: 1, label: 'Holes' },
}, { operations: ['remove'], defaultOperation: 'remove' });

/** A pocket that cuts by default and may make a separate body: new is listed first, remove is not. */
const POCKET = meta('acme.pocket', 'Pocket', {
  depth: { type: 'length', default: 2, label: 'Depth' },
}, { operations: ['new', 'remove'], defaultOperation: 'new' });

/** The engine's own Draft, as the catalog snapshots its metadata: a modifier taking an angle, then the faces. */
const DRAFT = meta('draft', 'Draft', {
  angle: { type: 'angle', default: 5, label: 'Angle' },
  faces: { picker: 'face', multiple: true, label: 'Faces' },
}, { group: 'modify', kind: 'modifier', call: ['angle', '...faces'] });

/** A part holding a plate, a sketch, a boss and a standoff row. */
function scene(): SceneObjectRender[] {
  return [
    { id: 'part', type: 'part', name: 'Plate', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(3, 22) },
    {
      id: 'plate', type: 'extrude', name: 'Extrude', parentId: 'part', ownShapes: [], sourceLocation: at(5, 16),
      sceneShapes: [{ shapeId: 'plate-solid', shapeType: 'solid', meshes: MESH }],
    },
    { id: 'sk', type: 'sketch', name: 'Sketch', parentId: 'part', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(6, 12) },
    {
      id: 'circle', type: 'circle', name: 'Circle', parentId: 'sk', ownShapes: [], sourceLocation: at(7, 4),
      sceneShapes: [{ shapeId: 'circle-wire', shapeType: 'edge', meshes: MESH }],
    },
    {
      id: 'boss', type: 'extrude', name: 'Boss', parentId: 'part', ownShapes: [], sourceLocation: at(9, 15),
      sceneShapes: [{ shapeId: 'boss-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'post', type: 'acme.standoff' as never, name: 'Standoff', parentId: 'part', ownShapes: [], sourceLocation: at(11, 15),
      sceneShapes: [{ shapeId: 'post-solid', shapeType: 'solid', meshes: MESH }],
    },
  ] as SceneObjectRender[];
}
const row = (id: string) => scene().find(o => o.id === id)!;

/** Bosses at connectors, points and face centres: a value of three kinds. */
const BOSS = meta('acme.boss', 'Boss', {
  at: { picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'], label: 'At' },
  height: { type: 'length', default: 6, min: 0, label: 'Height' },
}, { operations: ['add', 'new'], defaultOperation: 'add' });

/** The scene plus a connector on the plate's top (line 13) and one of its copies (slot 1). */
function bossScene(): SceneObjectRender[] {
  const frame = { origin: { x: 0, y: 0, z: 10 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
  return [
    ...scene(),
    {
      id: 'bolt', type: 'connector', name: 'bolt', parentId: 'part', ownShapes: [], sceneShapes: [], sourceLocation: at(13, 15),
      object: { name: 'bolt', ...frame },
    },
    {
      id: 'bolt-1', type: 'connector', name: 'bolt', parentId: 'part', ownShapes: [], sceneShapes: [], sourceLocation: at(14, 2),
      object: { name: 'bolt', ...frame, copy: { seedId: 'bolt', slot: 1 } },
    },
  ] as SceneObjectRender[];
}

/** A viewer recording what the dialog asks of it. */
function stubViewer() {
  const state = {
    highlighted: [] as unknown[],
    solids: [] as string[],
    standardAxes: [] as string[],
    axisPick: null as ((axis: 'x' | 'y' | 'z') => void) | null,
    planePick: null as ((plane: 'xy' | 'xz' | 'yz') => void) | null,
    connectorPicking: false,
    pickedConnectors: [] as string[],
  };
  const viewer = {
    sceneContext: {
      scene: new Scene(), camera: new PerspectiveCamera(), requestRender: () => {},
      renderer: { domElement: document.createElement('canvas') },
    },
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    pickVertices: false,
    setVertexPickScope: () => {},
    setHoveredConnector: () => {},
    setConnectorPicking: (on: boolean) => {
      state.connectorPicking = on;
    },
    setPickedConnectors: (ids: string[]) => {
      state.pickedConnectors = [...ids];
    },
    missedSketchRender: false,
    currentSceneObjects: [] as SceneObjectRender[],
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: (entities: unknown[], _wires: string[] = [], solids: string[] = []) => {
      state.highlighted = entities;
      state.solids = solids;
    },
    clearHighlight: () => {
      state.highlighted = [];
      state.solids = [];
    },
    setSelectedStandardAxes: (axes: string[]) => {
      state.standardAxes = [...axes];
    },
    showStandardAxes: (onPick: (axis: 'x' | 'y' | 'z') => void) => {
      state.axisPick = onPick;
    },
    hideStandardAxes: () => {
      state.axisPick = null;
    },
    showStandardPlanes: (onPick: (plane: 'xy' | 'xz' | 'yz') => void) => {
      state.planePick = onPick;
    },
    hideStandardPlanes: () => {
      state.planePick = null;
    },
  };
  /** The bodies the dialog's ghost draws right now. */
  const ghostBodies = (): number => {
    const groups = viewer.sceneContext.scene.children.filter((child: Object3D) => child.name === 'featureGhost');
    return groups.reduce((count: number, group: Object3D) => count + group.children.length, 0);
  };
  return { viewer: viewer as unknown as Viewer, state, ghostBodies };
}

/**
 * `preview`: whether the user turned the dialog's Preview toggle on for this
 * feature before (remembered in the browser). On here, so the tests of what
 * the ghost draws see one; the toggle's own tests pass false.
 */
function mount(featureMeta: FeatureMetaSnapshot = STANDOFF, opts: { preview?: boolean } = {}) {
  PreviewPreference.write(featureMeta.id, opts.preview ?? true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state, ghostBodies } = stubViewer();
  setActivePartLocationProvider(() => at(3, 22));
  const navbar = new Navbar(container);
  const entered = vi.fn();
  const service = new SchemaFeatureService(container, viewer, navbar, new FeatureSchema(featureMeta), 'icon.svg', {
    onEnter: entered,
  });
  service.update(scene());
  const panel = () => container.querySelector<HTMLElement>(`#fluidcad-feature-${featureMeta.id.replace('.', '-')}`)!;
  const input = (name: string) => panel().querySelector<HTMLInputElement & HTMLSelectElement>(`[data-role="value-${name}"]`)!;
  const type = (name: string, value: string) => {
    input(name).value = value;
    input(name).dispatchEvent(new Event(input(name).tagName === 'SELECT' ? 'change' : 'input'));
  };
  const opTab = (label: string) => [...panel().querySelectorAll<HTMLButtonElement>('[data-role="op-tabs"] button')]
    .find(b => b.textContent === label)!.click();
  const message = () => panel().querySelector('[data-role="message"]')!.textContent;
  const lastCreate = () => vi.mocked(api.applyCustomFeature).mock.calls.at(-1)?.[0];
  const lastEdit = () => vi.mocked(api.applyCustomFeatureEdit).mock.calls.at(-1)?.[1];
  const lastGhost = () => vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1);
  return { service, container, viewer, state, navbar, panel, input, type, opTab, message, lastCreate, lastEdit, entered, lastGhost, ghostBodies };
}

const faceOf = (shapeId: string, index: number) => ({ shapeId, sub: { type: 'face' as const, index } });

describe('a custom feature dialog', () => {
  it('puts a button in its group and opens the dialog its metadata describes', () => {
    const { service, container, panel, viewer, entered } = mount();
    const button = container.querySelector<HTMLElement>('[data-tool="feature:acme.standoff"]')!;
    expect(button.dataset.tip).toBe('Standoff — A boss with a bore');
    expect(service.toolbarButton).not.toBeNull();
    button.querySelector('button')!.click();
    expect(entered).toHaveBeenCalledOnce();
    expect(service.isActive).toBe(true);
    expect(panel().classList.contains('hidden')).toBe(false);
    expect([...panel().querySelectorAll('[data-role="op-tabs"] button')].map(b => b.textContent)).toEqual(['Add', 'New']);
    expect(panel().querySelector<HTMLInputElement>('[data-role="value-height"]')!.value).toBe('10');
    // The first value still to pick is armed, and the viewer offers faces.
    expect(service.dialogPanel.armedSlot).toBe('face');
    expect(viewer.pickFilter).toBe('face');
  });

  it("writes the picks and only the values the user set — the builder's defaults stand for the rest", async () => {
    const { service, type, opTab, lastCreate, state } = mount();
    service.enter();
    expect(service.handleClick('plate-solid', faceOf('plate-solid', 4).sub)).toBe(true);
    expect(state.highlighted).toEqual([faceOf('plate-solid', 4)]);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()).toMatchObject({
      id: 'acme.standoff', values: {}, picks: { face: [{ kind: 'entities', entities: [faceOf('plate-solid', 4)] }] }, preview: true,
    });
    expect(lastCreate()!.values).toEqual({});
    expect(lastCreate()!.operation).toBe('add');

    type('height', '12');
    opTab('New');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({ height: 12 });
    expect(lastCreate()!.operation).toBe('new');

    await service.dialogPanel.onApply!();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCreate()!.preview).toBeUndefined();
    expect(service.isActive).toBe(false);
  });

  it('refuses what the engine would — a value out of range, a required value or pick left out', async () => {
    const { service, type, message } = mount(BRACKET);
    service.enter();
    service.dialogPanel.onApply!();
    await vi.advanceTimersByTimeAsync(0);
    expect(message()).toBe('Depth is required.');
    type('depth', '-2');
    type('depth', '5');
    service.dialogPanel.onApply!();
    await vi.advanceTimersByTimeAsync(0);
    expect(message()).toBe('Profile: pick a sketch.');

    const standoff = mount();
    standoff.service.enter();
    standoff.service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    standoff.type('hole', '-1');
    standoff.service.dialogPanel.onApply!();
    await vi.advanceTimersByTimeAsync(0);
    expect(standoff.message()).toBe('Hole diameter must be at least 0.');
    expect(api.applyCustomFeature).not.toHaveBeenCalledWith(expect.not.objectContaining({ preview: true }));
  });

  it("routes a timeline row to the value that takes it whichever is armed, and hands the armed state on", async () => {
    const { service, lastCreate, message } = mount(BRACKET);
    service.enter();
    expect(service.dialogPanel.armedSlot).toBe('profile');
    // The profile slot is armed; a face pick lands only where faces go.
    service.dialogPanel.armSlot('base');
    expect(service.handleTimelinePick(row('circle'))).toBe(true);
    // The sketch filled its single slot: the next value still empty takes over.
    expect(service.dialogPanel.armedSlot).toBe('base');
    service.handleClick('plate-solid', faceOf('plate-solid', 1).sub);
    expect(service.dialogPanel.armedSlot).toBe('hinge');

    expect(service.handleTimelinePick(row('part'))).toBe(true);
    expect(message()).toBe('Plate is not something Bracket takes.');

    // No value takes a solid's row: it scopes the operation.
    service.handleTimelinePick(row('boss'));
    expect(service.dialogPanel.armedSlot).toBe('scope');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()).toBeUndefined();
  });

  it('takes a world axis shown while an axis value is armed', async () => {
    const { service, state, lastCreate, type } = mount(BRACKET);
    service.enter();
    service.handleTimelinePick(row('sk'));
    service.handleClick('plate-solid', faceOf('plate-solid', 1).sub);
    expect(service.dialogPanel.armedSlot).toBe('hinge');
    expect(state.axisPick).not.toBeNull();
    state.axisPick!('x');
    expect(state.standardAxes).toEqual(['x']);
    type('depth', '5');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.picks).toEqual({
      profile: [{ kind: 'statement', filePath: FILE, line: 6, column: 12 }],
      base: [{ kind: 'entities', entities: [faceOf('plate-solid', 1)] }],
      hinge: [{ kind: 'standard', name: 'x' }],
    });
    expect(lastCreate()!.values).toEqual({ depth: 5 });
  });

  it('shows a row while its visibleWhen holds, and writes no value for a hidden one', async () => {
    const { service, input, type, lastCreate } = mount(BRACKET);
    service.enter();
    const gussetRow = () => input('gusset').closest('[data-param]')!;
    expect(gussetRow().classList.contains('hidden')).toBe(true);
    type('style', '1');
    expect(gussetRow().classList.contains('hidden')).toBe(false);
    type('gusset', '6');
    service.handleTimelinePick(row('sk'));
    service.handleClick('plate-solid', faceOf('plate-solid', 1).sub);
    type('depth', '5');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({ style: 'gusset', gusset: 6, depth: 5 });
    type('style', '0');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({ style: 'flat', depth: 5 });
  });

  it('scopes the operation to the solids picked in its scope row, and drops the scope for a separate body', async () => {
    const { service, container, opTab, lastCreate, state } = mount();
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    (container.querySelector<HTMLElement>('[data-role="scope-slot"]')!.lastElementChild as HTMLElement).click();
    expect(service.dialogPanel.armedSlot).toBe('scope');
    service.handleClick('boss-solid', faceOf('boss-solid', 0).sub);
    expect(state.solids).toEqual(['boss-solid']);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.scope).toEqual([{ filePath: FILE, line: 9, column: 15 }]);

    opTab('New');
    expect(container.querySelector('[data-role="scope-slot"]')!.classList.contains('hidden')).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.scope).toBeUndefined();
  });

  it("drops its viewport picks on a render, whose ids are new, and keeps its statement picks", async () => {
    const { service, lastCreate, type } = mount(BRACKET);
    service.enter();
    service.handleTimelinePick(row('sk'));
    service.handleClick('plate-solid', faceOf('plate-solid', 1).sub);
    type('depth', '5');
    service.update(scene());
    service.dialogPanel.onApply!();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.dialogPanel.pickers.get('profile')!.isEmpty).toBe(false);
    expect(service.dialogPanel.pickers.get('base')!.isEmpty).toBe(true);
    expect(lastCreate()).toBeUndefined();
  });
});

describe('a custom feature standing at locations', () => {
  const centre = {
    ok: true, inPart: true, defaultName: null, args: null,
    anchors: [
      { anchor: { kind: 'center' }, suffix: '.center()', frame: { origin: { x: 0, y: 0, z: 10 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } } },
      { anchor: { kind: 'start' }, suffix: '.start()', frame: { origin: { x: 5, y: 0, z: 10 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } } },
    ],
  };

  it('offers connectors, vertices and anchors at once, and writes every pick in the order it was made', async () => {
    const { service, viewer, state, lastCreate, lastGhost } = mount(BOSS);
    service.update(bossScene());
    service.enter();
    expect(service.dialogPanel.armedSlot).toBe('at');
    expect(viewer.pickFilter).toBe('all');
    expect(viewer.pickVertices).toBe(true);
    expect(state.connectorPicking).toBe(true);

    expect(service.handleConnectorPick('bolt', {} as never)).toBe(true);
    expect(service.handleClick('plate-solid', { type: 'vertex', index: 3 })).toBe(true);
    // A face: the rail asks for its anchors — the value takes centres only — and locks the one under the cursor.
    vi.mocked(api.fetchConnectorAnchors).mockResolvedValueOnce(centre as never);
    expect(service.handleHover('plate-solid', faceOf('plate-solid', 4).sub, 10, 10)).toBe(true);
    expect(service.handleClick('plate-solid', faceOf('plate-solid', 4).sub)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api.fetchConnectorAnchors).mock.calls[0][2]).toBe('hole');
    expect(service.handleConnectorPick('bolt-1', {} as never)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);

    expect(lastCreate()!.picks).toEqual({
      at: [
        { kind: 'statement', filePath: FILE, line: 13, column: 15, picker: 'connector' },
        { kind: 'point', entity: { shapeId: 'plate-solid', sub: { type: 'vertex', index: 3 } } },
        { kind: 'anchor', entity: faceOf('plate-solid', 4), anchor: { kind: 'center' } },
        { kind: 'statement', filePath: FILE, line: 13, column: 15, picker: 'connector', slot: 1 },
      ],
    });
    expect(state.pickedConnectors).toEqual(['bolt', 'bolt-1']);
    expect(lastGhost()![0].refs).toEqual({
      at: [
        { kind: 'connector', filePath: FILE, line: 13 },
        { kind: 'point', shapeId: 'plate-solid', index: 3 },
        { kind: 'anchor', entity: { shapeId: 'plate-solid', index: 4, kind: 'face' }, anchor: { kind: 'center' } },
        { kind: 'connector', filePath: FILE, line: 13, slot: 1 },
      ],
    });

    // Every location channel goes back when the dialog closes.
    service.exit();
    expect(state.connectorPicking).toBe(false);
    expect(viewer.pickVertices).toBe(false);
    expect(state.pickedConnectors).toEqual([]);
  });

  it('refuses a face that offers no anchor the value takes, and drops vertex and anchor picks on a render', async () => {
    const { service, message } = mount(BOSS);
    service.update(bossScene());
    service.enter();
    vi.mocked(api.fetchConnectorAnchors).mockResolvedValueOnce({ ...centre, anchors: [centre.anchors[1]] } as never);
    service.handleClick('plate-solid', faceOf('plate-solid', 5).sub);
    await vi.advanceTimersByTimeAsync(0);
    expect(message()).toBe('That face or edge offers no anchor this value takes.');

    service.handleClick('plate-solid', { type: 'vertex', index: 3 });
    service.handleConnectorPick('bolt', {} as never);
    service.update(bossScene());
    await vi.advanceTimersByTimeAsync(300);
    expect(service.dialogPanel.pickers.get('at')!.value.map(e => e.kind)).toEqual(['statement']);
  });
});

describe("a custom feature's axis value takes a connector", () => {
  it('reveals the gizmos with the axis slot armed, and a gizmo or a row lands in it as the connector', async () => {
    const { service, state, viewer, lastCreate, lastGhost } = mount(BOLT_CIRCLE);
    service.update(bossScene());
    service.enter();
    expect(service.dialogPanel.armedSlot).toBe('around');
    expect(viewer.pickAxes).toBe(true);
    expect(state.connectorPicking).toBe(true);

    expect(service.handleConnectorPick('bolt-1', {} as never)).toBe(true);
    expect(state.pickedConnectors).toEqual(['bolt-1']);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.picks).toEqual({
      around: [{ kind: 'statement', filePath: FILE, line: 13, column: 15, picker: 'connector', slot: 1 }],
    });
    expect(lastGhost()![0].refs).toEqual({ around: [{ kind: 'connector', filePath: FILE, line: 13, slot: 1 }] });

    // Its timeline row swaps it for the connector itself.
    const bolt = bossScene().find(o => o.id === 'bolt')!;
    expect(service.handleTimelinePick(bolt)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.picks).toEqual({
      around: [{ kind: 'statement', filePath: FILE, line: 13, column: 15, picker: 'connector' }],
    });

    service.exit();
    expect(state.connectorPicking).toBe(false);
  });
});

describe("a custom feature's operations in its dialog", () => {
  it('shows no tabs for a feature with one operation, and its requests still carry it', async () => {
    const { service, panel, container, state, type, lastCreate } = mount(BOLT_CIRCLE);
    service.enter();
    expect(panel().querySelector('[data-role="op-tabs"]')).toBeNull();
    expect(service.dialogPanel.armedSlot).toBe('around');
    state.axisPick!('z');
    type('count', '6');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()).toMatchObject({
      id: 'acme.boltCircle', operation: 'remove', values: { count: 6 }, picks: { around: [{ kind: 'standard', name: 'z' }] },
    });

    // It cuts, so the scope row still narrows what it cuts.
    const scopeRow = container.querySelector<HTMLElement>('[data-role="scope-slot"]')!;
    expect(scopeRow.classList.contains('hidden')).toBe(false);
    (scopeRow.lastElementChild as HTMLElement).click();
    service.handleClick('boss-solid', faceOf('boss-solid', 0).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()).toMatchObject({ operation: 'remove', scope: [{ filePath: FILE, line: 9, column: 15 }] });
  });

  it('keeps the tabs for two operations, opening on the default the metadata names', async () => {
    const { service, panel, opTab, lastCreate } = mount(POCKET);
    service.enter();
    const tabs = () => [...panel().querySelectorAll<HTMLButtonElement>('[data-role="op-tabs"] button')];
    expect(tabs().map(b => b.textContent)).toEqual(['Remove', 'New']);
    expect(tabs().filter(b => b.classList.contains('btn-primary')).map(b => b.textContent)).toEqual(['New']);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.operation).toBe('new');
    opTab('Remove');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.operation).toBe('remove');
  });

  it('edits a statement of a one-operation feature with no tabs, writing only what changed', async () => {
    const { service, panel, type, lastEdit } = mount(BOLT_CIRCLE);
    const parsed: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
      feature: 'custom',
      id: 'acme.boltCircle',
      callee: 'boltCircle',
      values: { count: 8 },
      picks: { around: [{ text: "'z'", start: 200, end: 203 }] },
      operation: 'remove',
      scopeTexts: [],
      scopeRefs: [],
    };
    service.enterEdit(at(11, 15), parsed, { index: 5, type: 'acme.boltCircle', expectedStatement: "boltCircle('z', { count: 8 }).remove()" });
    // The rollback lands before the bolt circle's row, where the standoff's stands in scene().
    service.handleSceneRendered(scene().map(o => o.id === 'post' ? { ...o, type: 'acme.boltCircle' as never } : o), 4, true);
    expect(panel().querySelector('[data-role="title"]')!.textContent).toBe('Edit bolt circle');
    expect(panel().querySelector('[data-role="op-tabs"]')).toBeNull();
    type('count', '6');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()).toMatchObject({ id: 'acme.boltCircle', values: { count: 6 }, picks: {} });
    expect(lastEdit()!.operation).toBeUndefined();
    expect(lastEdit()!.scope).toBeUndefined();
  });
});

describe('a row left alone, as the builder gets it', () => {
  const apply = async (service: SchemaFeatureService) => {
    await service.dialogPanel.onApply!();
    await vi.advanceTimersByTimeAsync(0);
  };
  const created = () => vi.mocked(api.applyCustomFeature).mock.calls.map(call => call[0]).filter(request => !request.preview);

  it('applies an untouched create of a feature whose select and toggle declare no default — each row shows what the builder fills, and nothing is written', async () => {
    const { service, input, lastCreate, lastGhost } = mount(GRILLE);
    service.enter();
    expect([...input('pattern').options].map(o => o.textContent)).toEqual(['Round', 'Slot']);
    expect(input('pattern').selectedIndex).toBe(0);
    expect(input('chamfered').checked).toBe(false);
    expect([...input('finish').options].map(o => o.textContent)).toEqual(['—', 'Matte', 'Gloss']);
    expect(input('finish').selectedIndex).toBe(0);

    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()).toMatchObject({ id: 'acme.grille', values: {}, preview: true });
    // The ghost draws the values the rows show — what the builder fills for them.
    expect(lastGhost()![0].values).toEqual({ pattern: 'round', chamfered: false });

    await apply(service);
    expect(created()).toHaveLength(1);
    expect(created()[0].values).toEqual({});
    expect(service.isActive).toBe(false);
  });

  it("writes the optional select's choice, and nothing for its empty one — an edit choosing it drops the statement's", async () => {
    const { service, type, input, lastCreate, lastEdit } = mount(GRILLE);
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    type('finish', '2');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({ finish: 'gloss' });
    type('finish', '0');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({});
    service.exit();

    // The statement chose a finish and left its pattern to the default.
    const rendered = [...scene(), {
      id: 'gr', type: 'acme.grille', name: 'Grille', parentId: 'part', ownShapes: [], sourceLocation: at(12, 2),
      sceneShapes: [{ shapeId: 'grille-solid', shapeType: 'solid', meshes: MESH }],
    }] as SceneObjectRender[];
    const statement: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
      feature: 'custom', id: 'acme.grille', callee: 'grille',
      values: { finish: 'matte' }, picks: { face: [{ text: 'pad.endFaces()', start: 0, end: 14 }] },
      operation: 'remove', scopeTexts: [], scopeRefs: [],
    };
    service.enterEdit(at(12, 2), statement, { index: 6, type: 'acme.grille', expectedStatement: "grille(pad.endFaces(), { finish: 'matte' })" });
    service.handleSceneRendered(rendered, 5, true);
    // The value it leaves out seeds from the default; untouched, neither is written.
    expect(input('pattern').selectedIndex).toBe(0);
    expect(input('finish').selectedIndex).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({});

    type('finish', '0');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({ finish: null });
  });

  it('writes nothing for a rich select or a radio left alone, and only the radio an edit changes', async () => {
    const { service, panel, input, lastCreate, lastEdit, lastGhost } = mount(CLIP);
    const radios = (name: string) => [...input(name).querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]')];
    service.enter();
    expect(input('size').tagName).toBe('BUTTON');
    expect(input('size').textContent).toContain('M4');
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()).toMatchObject({ id: 'acme.clip', values: {}, preview: true });
    // The ghost draws what the rows show; the radio holding nothing sends nothing.
    expect(lastGhost()![0].values).toEqual({ size: 'm4', head: 'pan' });
    await apply(service);
    expect(created()).toHaveLength(1);
    expect(created()[0].values).toEqual({});

    // A user's choice is written as the option's value, exactly as a select's.
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    radios('lock')[0].click();
    input('size').click();
    document.querySelectorAll<HTMLElement>('[role="option"]')[0].click();
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({ size: 'm3', lock: 'nylon' });
    service.exit();

    const rendered = [...scene(), {
      id: 'cl', type: 'acme.clip', name: 'Clip', parentId: 'part', ownShapes: [], sourceLocation: at(12, 2),
      sceneShapes: [{ shapeId: 'clip-solid', shapeType: 'solid', meshes: MESH }],
    }] as SceneObjectRender[];
    const statement: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
      feature: 'custom', id: 'acme.clip', callee: 'clip',
      values: { size: 'm3', lock: 'split' }, picks: { face: [{ text: 'pad.endFaces()', start: 0, end: 14 }] },
      operation: 'remove', scopeTexts: [], scopeRefs: [],
    };
    service.enterEdit(at(12, 2), statement, { index: 6, type: 'acme.clip', expectedStatement: "clip(pad.endFaces(), { size: 'm3', lock: 'split' })" });
    service.handleSceneRendered(rendered, 5, true);
    expect(input('size').textContent).toContain('M3');
    expect(radios('lock').map(r => (r as HTMLInputElement).checked)).toEqual([false, true]);
    expect(radios('head').map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({});

    radios('head')[1].click();
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({ head: 'hex' });
    // Clearing the radio that may hold nothing drops the statement's value.
    [...panel().querySelectorAll('button')].find(b => b.textContent === 'Clear')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({ head: 'hex', lock: null });
  });

  it('blocks Apply on a number or a text without a default left empty, and says which — the engine would refuse it', async () => {
    const { service, type, message } = mount(NAMEPLATE);
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await apply(service);
    expect(message()).toBe('Depth is required.');
    type('depth', '0.4');
    await apply(service);
    expect(message()).toBe('Text is required.');
    // Typed, then emptied: still no text.
    type('text', 'A');
    type('text', '');
    await apply(service);
    expect(message()).toBe('Text is required.');
    expect(created()).toEqual([]);

    type('text', 'Rev B');
    await apply(service);
    expect(created()).toHaveLength(1);
    expect(created()[0].values).toEqual({ depth: 0.4, text: 'Rev B' });
  });
});

describe('editing a custom feature statement', () => {
  const parsed: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
    feature: 'custom',
    id: 'acme.standoff',
    callee: 'standoff',
    values: { outer: 6, hole: 3.2 },
    picks: { face: [{ text: 'pad.endFaces()', start: 100, end: 114 }] },
    operation: 'add',
    scopeTexts: ['plate'],
    scopeRefs: [{ line: 5, column: 16 }],
  };
  const info = { index: 5, type: 'acme.standoff', expectedStatement: 'standoff(pad.endFaces(), { outer: 6, hole: 3.2 })' };

  function openEdit() {
    const mounted = mount();
    mounted.service.enterEdit(at(11, 15), parsed, info);
    // The session's rollback lands on the boundary — the world before the statement.
    mounted.service.handleSceneRendered(scene(), 4, true);
    return mounted;
  }

  it('opens on the statement: its values, its picks kept, its operation, its scope', () => {
    const { service, panel, input } = openEdit();
    expect(panel().querySelector('[data-role="title"]')!.textContent).toBe('Edit standoff');
    expect(input('height').value).toBe('10');
    expect(input('hole').value).toBe('3.2');
    expect([...panel().querySelectorAll('span.truncate[title]')].map(el => el.textContent))
      .toEqual(['Current: pad.endFaces()', 'Extrude']);
    expect(service.isEditing).toBe(true);
    expect(api.fetchFeatureSources).toHaveBeenCalledWith({ index: 5, type: 'acme.standoff', line: 11, column: 15 });
  });

  it('writes only what changed — an untouched value keeps its own text', async () => {
    const { service, type, lastEdit } = openEdit();
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()).toMatchObject({ id: 'acme.standoff', expectedStatement: info.expectedStatement });
    expect(lastEdit()!.values).toEqual({});
    expect(lastEdit()!.picks).toEqual({});
    expect(lastEdit()!.operation).toBeUndefined();
    expect(lastEdit()!.scope).toBeUndefined();
    expect(lastEdit()!.before).toBeUndefined();

    type('hole', '3');
    service.handleClick('boss-solid', faceOf('boss-solid', 2).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()).toMatchObject({
      values: { hole: 3 },
      picks: { face: [{ kind: 'entities', entities: [faceOf('boss-solid', 2)] }] },
      before: { index: 5, type: 'acme.standoff', line: 11, column: 15 },
    });
  });

  it('drops the scope of a statement that becomes a separate body', async () => {
    const { opTab, lastEdit, type } = openEdit();
    type('height', '');
    opTab('New');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()).toMatchObject({ operation: 'new', scope: [], values: { height: null } });
  });

  it("edits a draft of the last selection over the faces it took — an angle change leaves them out, a re-pick writes them", async () => {
    vi.mocked(api.fetchFeatureSources).mockResolvedValue({
      ok: true, feature: 'custom', id: 'draft',
      slots: { faces: [{ kind: 'entities', entities: [faceOf('plate-solid', 2)] }] },
    } as never);
    try {
      const { service, panel, type, lastEdit, lastGhost } = mount(DRAFT);
      const draft: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
        feature: 'custom', id: 'draft', callee: 'draft',
        values: { angle: 5 }, picks: {}, operation: 'add', scopeTexts: [], scopeRefs: [],
      };
      // The draft's row follows the standoff's.
      const rendered = [...scene(), {
        id: 'dr', type: 'draft', name: 'Draft', parentId: 'part', ownShapes: [], sourceLocation: at(12, 2),
        sceneShapes: [{ shapeId: 'drafted-solid', shapeType: 'solid', meshes: MESH }],
      }] as SceneObjectRender[];
      service.enterEdit(at(12, 2), draft, { index: 6, type: 'draft', expectedStatement: 'draft(5)' });
      service.handleSceneRendered(rendered, 5, true);
      await vi.advanceTimersByTimeAsync(300);

      expect(panel().querySelector('[data-role="title"]')!.textContent).toBe('Edit draft');
      expect([...panel().querySelectorAll('span.truncate[title]')].map(el => el.textContent))
        .toEqual(['Current: last selected face']);
      expect(lastEdit()).toMatchObject({ id: 'draft', values: {}, picks: {} });
      expect(lastEdit()!.before).toBeUndefined();
      expect(lastGhost()![0]).toMatchObject({
        id: 'draft', values: { angle: 5 },
        refs: { faces: [{ kind: 'entities', entities: [{ shapeId: 'plate-solid', index: 2, kind: 'face' }] }] },
      });

      type('angle', '8');
      await vi.advanceTimersByTimeAsync(300);
      expect(lastEdit()).toMatchObject({ values: { angle: 8 }, picks: {} });

      service.handleClick('boss-solid', faceOf('boss-solid', 1).sub);
      await vi.advanceTimersByTimeAsync(300);
      expect(lastEdit()).toMatchObject({
        picks: { faces: [{ kind: 'entities', entities: [faceOf('plate-solid', 2), faceOf('boss-solid', 1)] }] },
        before: { index: 6, type: 'draft', line: 12, column: 2 },
      });
    } finally {
      vi.mocked(api.fetchFeatureSources).mockReset();
      vi.mocked(api.fetchFeatureSources).mockImplementation(async () => ({ ok: false, reason: 'none' }) as never);
    }
  });

  it('is the dialog the registry hands a parsed statement of its feature', () => {
    const registry = new FeatureDialogRegistry();
    const { service } = mount();
    const other = mount(BRACKET).service;
    registry.register(other);
    registry.register(service);
    expect(registry.editsRowType('acme.standoff')).toBe(true);
    expect(registry.forStatement(parsed)).toBe(service);
    expect(registry.forStatement({ ...parsed, id: 'acme.gone' })).toBeNull();
    registry.unregister(service.id);
    expect(registry.editsRowType('acme.standoff')).toBe(false);
  });
});

describe("a custom feature's ghost", () => {
  const PAUSED = 'It took 6.1 s to build, over the 5 s a preview may take.';

  afterEach(() => {
    api.setActivePartProvider(() => null);
  });

  const previewToggle = (panel: () => HTMLElement) => panel().querySelector<HTMLInputElement>('[data-role="preview-toggle"]');
  const flip = (toggle: HTMLInputElement) => {
    toggle.checked = !toggle.checked;
    toggle.dispatchEvent(new Event('change'));
  };

  it('starts with the Preview toggle off and asks the engine for no ghost — Apply still writes the call', async () => {
    const { service, panel, type, lastCreate, ghostBodies } = mount(STANDOFF, { preview: false });
    service.enter();
    expect(previewToggle(panel)!.checked).toBe(false);
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    type('height', '12');
    await vi.advanceTimersByTimeAsync(300);
    // The statement still previews; the ghost is never built.
    expect(api.applyCustomFeature).toHaveBeenCalled();
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();
    expect(ghostBodies()).toBe(0);

    panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCreate()).toMatchObject({ id: 'acme.standoff', values: { height: 12 } });
    expect(lastCreate()).not.toHaveProperty('preview');
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();
  });

  it('locks the rows the feature fixed from its picks, writes none of them, and lets them go when a ghost fixes nothing', async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValueOnce({ solids: [{ meshes: [] }], frames: [], notice: null, derived: { height: 12 } } as never);
    const { service, panel, input, type, lastCreate, lastGhost } = mount(STANDOFF);
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);

    // The engine fixed the height: its row shows 12, locked, with a note.
    const row = input('height').closest<HTMLElement>('[data-param="height"]')!;
    expect(input('height').value).toBe('12');
    expect(row.hasAttribute('inert')).toBe(true);
    expect(row.querySelector('[data-role="derived"]')!.textContent).toBe('Fixed by what was picked');

    // Another row still takes typing; the ghost asked for leaves the fixed value out.
    type('outer', '8');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastGhost()![0]).toMatchObject({ values: { outer: 8 } });
    expect((lastGhost()![0] as { values: Record<string, unknown> }).values).not.toHaveProperty('height');

    // That ghost (the default answer) fixed nothing: the row is free again, back on its default.
    expect(row.hasAttribute('inert')).toBe(false);
    expect(row.querySelector('[data-role="derived"]')).toBeNull();
    expect(input('height').value).toBe('10');

    panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCreate()!.values).toEqual({ outer: 8 });
  });

  it('never writes a fixed value: Apply leaves it to the engine while the row is locked', async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [{ meshes: [] }], frames: [], notice: null, derived: { height: 12 } } as never);
    const { service, panel, input, type, lastCreate } = mount(STANDOFF);
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    type('outer', '8');
    await vi.advanceTimersByTimeAsync(300);
    expect(input('height').value).toBe('12');

    panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCreate()!.values).toEqual({ outer: 8 });
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [{ meshes: [] }], frames: [], notice: null } as never);
  });

  it('builds the ghost once the toggle is on, follows the form, and clears it when turned off', async () => {
    const { service, panel, type, lastGhost, ghostBodies } = mount(STANDOFF, { preview: false });
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();

    flip(previewToggle(panel)!);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(1);
    expect(ghostBodies()).toBe(1);
    type('height', '14');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(2);
    expect(lastGhost()![0]).toMatchObject({ values: { height: 14 } });

    flip(previewToggle(panel)!);
    await vi.advanceTimersByTimeAsync(300);
    expect(ghostBodies()).toBe(0);
    type('height', '15');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(2);
  });

  it('remembers the toggle per feature: one turned on opens on, the others still start off', async () => {
    const standoff = mount(STANDOFF, { preview: false });
    standoff.service.enter();
    flip(previewToggle(standoff.panel)!);
    standoff.service.exit();
    expect(PreviewPreference.read('acme.standoff')).toBe(true);
    standoff.service.enter();
    expect(previewToggle(standoff.panel)!.checked).toBe(true);
    standoff.service.exit();

    const bolt = mount(BOLT_CIRCLE, { preview: false });
    bolt.service.enter();
    expect(previewToggle(bolt.panel)!.checked).toBe(false);
    bolt.service.exit();

    // Turned off again, it is forgotten: the next dialog starts off.
    standoff.service.enter();
    flip(previewToggle(standoff.panel)!);
    standoff.service.exit();
    expect(PreviewPreference.read('acme.standoff')).toBe(false);
  });

  it('shows no toggle for a feature whose metadata draws no preview', () => {
    const { service, panel } = mount(meta('acme.quiet', 'Quiet', { height: { type: 'length', label: 'Height', default: 5 } }, { ghost: false }));
    service.enter();
    expect(previewToggle(panel)).toBeNull();
  });

  it('shows no toggle for a feature that always previews, and builds its ghost from the start', async () => {
    // Even with the toggle remembered off: the feature's metadata decides.
    const { service, panel, type, lastGhost, ghostBodies } = mount({ ...STANDOFF, ghostMode: 'always' }, { preview: false });
    service.enter();
    expect(previewToggle(panel)).toBeNull();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(1);
    expect(ghostBodies()).toBe(1);
    type('height', '14');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(2);
    expect(lastGhost()![0]).toMatchObject({ values: { height: 14 } });
  });

  it('reads a snapshot without a mode as a toggle', () => {
    const { service, panel } = mount({ ...STANDOFF, ghostMode: undefined }, { preview: false });
    service.enter();
    expect(previewToggle(panel)!.checked).toBe(false);
  });

  it('draws the form as the engine builds it: every value the rows hold, the picks as refs, where the statement lands', async () => {
    const { service, type, lastGhost, ghostBodies } = mount();
    api.setActivePartProvider(() => at(3, 22));
    service.enter();
    await vi.advanceTimersByTimeAsync(300);
    // Nothing picked yet: the statement doesn't preview, so no ghost is asked for.
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();

    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastGhost()![0]).toEqual({
      feature: 'custom', id: 'acme.standoff',
      values: { height: 10, outer: 6, hole: 3 },
      refs: { face: [{ kind: 'entities', entities: [{ shapeId: 'plate-solid', index: 4, kind: 'face' }] }] },
      operation: 'add',
    });
    // The values read where a created statement lands: the active part.
    expect(lastGhost()![1]).toEqual({ kind: 'append', filePath: FILE, line: 3, column: 22 });
    expect(ghostBodies()).toBe(1);

    // A new variable travels as its declaration's initializer, not a name the code lacks yet.
    type('height', 'tall = 14');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastGhost()![0]).toMatchObject({ values: { height: "param('tall', 14)", outer: 6, hole: 3 } });
  });

  it("draws a cut in the remove colour, a world axis as a ref, and sends no hidden row's value", async () => {
    const set = vi.spyOn(FeatureGhostOverlay.prototype, 'set');
    const { service, state, lastGhost } = mount(BOLT_CIRCLE);
    service.enter();
    state.axisPick!('z');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastGhost()![0]).toMatchObject({ values: { count: 4 }, refs: { around: [{ kind: 'standard', name: 'z' }] }, operation: 'remove' });
    expect(set.mock.calls.at(-1)![1]).toBe('remove');

    const bracket = mount(BRACKET);
    bracket.service.enter();
    bracket.service.handleTimelinePick(row('sk'));
    bracket.service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    bracket.type('depth', '5');
    await vi.advanceTimersByTimeAsync(300);
    expect(bracket.lastGhost()![0]).toMatchObject({
      values: { depth: 5, style: 'flat' },
      refs: { profile: [{ kind: 'statement', filePath: FILE, line: 6 }], base: [{ kind: 'entities' }] },
    });
    expect(bracket.lastGhost()![0].values).not.toHaveProperty('gusset');
    set.mockRestore();
  });

  it('clears on every render and on the way out', async () => {
    const { service, ghostBodies } = mount();
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(ghostBodies()).toBe(1);
    service.update(scene());
    expect(ghostBodies()).toBe(0);

    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(ghostBodies()).toBe(1);
    service.exit();
    expect(ghostBodies()).toBe(0);
  });

  it('draws an edit from the statement it edits — kept picks as their sources resolve — read before it', async () => {
    vi.mocked(api.fetchFeatureSources).mockResolvedValueOnce({
      ok: true, feature: 'custom', id: 'acme.standoff',
      slots: { face: { kind: 'entities', entities: [{ shapeId: 'pad-solid', sub: { type: 'face', index: 2 } }] } },
    } as never);
    const { service, lastGhost, ghostBodies } = mount();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
      feature: 'custom', id: 'acme.standoff', callee: 'standoff',
      values: { height: 'tall + 2', hole: 3.2 },
      picks: { face: [{ text: 'pad.endFaces()', start: 100, end: 114 }] },
      operation: 'add', scopeTexts: [], scopeRefs: [],
    };
    service.enterEdit(at(11, 15), parsed, { index: 5, type: 'acme.standoff', expectedStatement: 'standoff(pad.endFaces())' });
    service.handleSceneRendered(scene(), 4, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastGhost()![0]).toEqual({
      feature: 'custom', id: 'acme.standoff',
      values: { height: 'tall + 2', outer: 6, hole: 3.2 },
      refs: { face: [{ kind: 'entities', entities: [{ shapeId: 'pad-solid', index: 2, kind: 'face' }] }] },
      operation: 'add',
      exclude: { filePath: FILE, line: 11 },
    });
    expect(lastGhost()![1]).toEqual({ kind: 'statement', filePath: FILE, line: 11, column: 15 });
    expect(ghostBodies()).toBe(1);

    // Mid-flight to a new boundary, the ghost goes with the scene it stood on.
    service.handleSceneRendered(scene(), 6, false);
    expect(ghostBodies()).toBe(0);
  });

  it("draws no ghost for a kept pick it can't address", async () => {
    const { service } = mount();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
      feature: 'custom', id: 'acme.standoff', callee: 'standoff',
      values: {}, picks: { face: [{ text: 'faces[0]', start: 100, end: 108 }] },
      operation: 'add', scopeTexts: [], scopeRefs: [],
    };
    service.enterEdit(at(11, 15), parsed, { index: 5, type: 'acme.standoff', expectedStatement: 'standoff(faces[0])' });
    service.handleSceneRendered(scene(), 4, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.applyCustomFeatureEdit).toHaveBeenCalled();
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();
  });

  it('times out a ghost that always previews too, and Try again asks again', async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValueOnce({ solids: null, frames: [], notice: null, paused: PAUSED });
    const { service, panel, type, lastGhost, ghostBodies } = mount({ ...STANDOFF, ghostMode: 'always' });
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    const row = panel().querySelector<HTMLElement>('[data-role="ghost-paused"]')!;
    expect(row.classList.contains('hidden')).toBe(false);
    // No toggle to turn off and on: the row says so its own way.
    expect(row.querySelector('span')!.textContent).toBe(`Preview timed out. ${PAUSED}`);
    const retry = row.querySelector<HTMLButtonElement>('[data-role="preview-retry"]')!;
    expect(retry.textContent).toBe('Try again');
    expect(ghostBodies()).toBe(0);

    // Timed out, the form previews its statement but asks for no ghost.
    type('height', '12');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(1);

    retry.click();
    expect(row.classList.contains('hidden')).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(2);
    expect(lastGhost()![0]).toMatchObject({ values: { height: 12 } });
    expect(ghostBodies()).toBe(1);
  });

  it('times out a ghost too slow to follow the form, and asks again once the toggle is turned off and on', async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValueOnce({ solids: null, frames: [], notice: null, paused: PAUSED });
    const { service, panel, type, lastGhost, ghostBodies } = mount();
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    const row = panel().querySelector<HTMLElement>('[data-role="ghost-paused"]')!;
    expect(row.classList.contains('hidden')).toBe(false);
    expect(row.textContent).toBe(`Preview timed out. ${PAUSED} Turn it off and on to try again.`);
    // No button to build it anyway: the toggle is the one control.
    expect(row.querySelector('button')).toBeNull();
    expect(ghostBodies()).toBe(0);

    // Timed out, the form previews its statement but asks for no ghost.
    type('height', '12');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(1);

    flip(previewToggle(panel)!);
    expect(row.classList.contains('hidden')).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(1);
    flip(previewToggle(panel)!);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(2);
    expect(lastGhost()![0]).toMatchObject({ values: { height: 12 } });
    expect(ghostBodies()).toBe(1);

    // A fresh dialog previews live again too.
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValueOnce({ solids: null, frames: [], notice: null, paused: PAUSED });
    type('height', '13');
    await vi.advanceTimersByTimeAsync(300);
    expect(row.classList.contains('hidden')).toBe(false);
    service.exit();
    service.enter();
    expect(row.classList.contains('hidden')).toBe(true);
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(4);
  });

  it('previews live again once its module is saved — what made it slow may be gone', async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValueOnce({ solids: null, frames: [], notice: null, paused: PAUSED });
    const { service, panel, lastGhost, ghostBodies } = mount();
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    const row = panel().querySelector<HTMLElement>('[data-role="ghost-paused"]')!;
    expect(row.classList.contains('hidden')).toBe(false);

    service.codeChanged();
    expect(row.classList.contains('hidden')).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(2);
    expect(ghostBodies()).toBe(1);

    // A closed dialog has nothing to ask.
    service.exit();
    service.codeChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(2);
  });

  it('asks for no ghost when the metadata turns it off', async () => {
    const { service } = mount({ ...STANDOFF, ghost: false });
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.applyCustomFeature).toHaveBeenCalled();
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();
  });
});

describe('the feature catalog on the page', () => {
  const entry = (featureMeta: FeatureMetaSnapshot, extra: Partial<FeatureCatalogEntry> = {}): FeatureCatalogEntry => ({
    id: featureMeta.id, exportName: featureMeta.id.split('.')[1], modulePath: `/ws/${featureMeta.id}.feature.js`,
    builtIn: false, meta: featureMeta, ...extra,
  });

  /** Every catalog a test builds — its dropdown closed afterwards, so no document listener outlives the test. */
  const catalogs: FeatureCatalogDialogs[] = [];
  afterEach(() => {
    for (const dialogs of catalogs.splice(0)) {
      dialogs.menu.close();
    }
  });

  function catalog() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { viewer } = stubViewer();
    const navbar = new Navbar(container);
    // The tool groups the page builds before its catalog.
    const modify = navbar.addGroup('modify', { visible: false });
    navbar.addGroup('repeat', { visible: false });
    navbar.addGroup('connector', { visible: false, mode: 'all' });
    const registry = new FeatureDialogRegistry();
    const built: SchemaFeatureService[] = [];
    const dialogs = new FeatureCatalogDialogs(registry, navbar, (schema, icon, launcher) => {
      const service = new SchemaFeatureService(container, viewer, navbar, schema, icon, {}, launcher);
      built.push(service);
      return service;
    });
    catalogs.push(dialogs);
    const changes = vi.fn();
    dialogs.onChange = changes;
    /** The tooltips of the buttons on the bar. */
    const buttons = () => [...container.querySelectorAll<HTMLElement>('[data-tip]')].map(el => el.dataset.tip);
    const menuButton = container.querySelector<HTMLButtonElement>('[data-tool="custom-features"] button')!;
    const menuGroup = menuButton.closest<HTMLElement>('[data-tool="custom-features"]')!.parentElement!;
    /** The dropdown's cells, in grid order, while it is open. */
    const cells = () => [...document.querySelectorAll<HTMLElement>('[data-role="custom-features-menu"] [title]')];
    return { container, registry, dialogs, built, changes, buttons, navbar, modify, menuButton, menuGroup, cells };
  }

  it("registers one dialog per feature, with its icon on its timeline rows", () => {
    const { registry, dialogs, changes } = catalog();
    dialogs.apply([entry(STANDOFF), entry(BRACKET)]);
    expect(registry.ids).toEqual(['feature:acme.standoff', 'feature:acme.bracket']);
    // A workspace feature opens from the Custom dropdown, so no button on the bar to hide in a sketch.
    expect(registry.toolbarButtons).toEqual([]);
    expect(changes).toHaveBeenCalledOnce();
    expect(ObjectIcons.srcFor(undefined, 'acme.standoff')).toBe('api/features/asset?id=acme.standoff&path=.%2Fstandoff.svg');
    expect(ObjectIcons.srcFor(undefined, 'acme.bracket')).toContain('solid');
    expect(ObjectIcons.srcFor(undefined, 'extrude')).toBe('icons/extrude.png');
  });

  it('groups a package\'s features under it in the dropdown, marks a library one, and keeps the dialog when the project pins it', () => {
    const { dialogs, built, menuButton } = catalog();
    const kit = { name: '@acme/kit', version: '0.1.0', availability: 'library' as const };
    dialogs.apply([entry(BRACKET), entry(STANDOFF, { package: kit })]);
    menuButton.click();
    const panel = document.querySelector<HTMLElement>('[data-role="custom-features-menu"]')!;
    const headings = [...panel.querySelectorAll<HTMLElement>('[data-group-heading]')];
    expect(headings.map(h => h.dataset.groupHeading)).toEqual(['workspace', '@acme/kit']);
    expect(headings[0].textContent).toBe('This project');
    expect(headings[1].querySelector('[data-ref="not-in-project"]')!.textContent).toBe('not in this project');
    const standoff = panel.querySelector<HTMLElement>('[data-tool="feature:acme.standoff"]')!;
    expect(standoff.closest<HTMLElement>('[data-group]')!.dataset.group).toBe('@acme/kit');
    expect(standoff.title).toContain('From @acme/kit 0.1.0, in your library but not in this project yet');

    // Using it pinned it: same metadata, so the same dialog — its cell drops the mark.
    dialogs.apply([entry(BRACKET), entry(STANDOFF, { package: { ...kit, availability: 'dependency' } })]);
    expect(built).toHaveLength(2);
    expect(panel.querySelector('[data-ref="not-in-project"]')).toBeNull();
    expect(panel.querySelector<HTMLElement>('[data-tool="feature:acme.standoff"]')!.title).toBe('Standoff — A boss with a bore\nFrom @acme/kit 0.1.0.');
  });

  it("offers a built-in that describes itself — Draft — as a regular button in its group, with the product's own icon", () => {
    const { registry, dialogs, built, container, navbar, menuGroup } = catalog();
    dialogs.apply([{ id: 'draft', exportName: 'draft', modulePath: 'fluidcad/core', builtIn: true, meta: DRAFT }]);
    expect(registry.ids).toEqual(['feature:draft']);
    expect(registry.editsRowType('draft')).toBe(true);
    const wrap = container.querySelector<HTMLElement>('[data-tool="feature:draft"]')!;
    expect(wrap.querySelector('img')!.getAttribute('src')).toBe('icons/draft.png');
    expect(navbar.getGroup('modify')!.contains(wrap)).toBe(true);
    expect(built[0].toolbarButton).toBeNull();
    // Not in the Custom dropdown, which has nothing to list and stays off the bar.
    expect(dialogs.menu.entries).toEqual([]);
    expect(menuGroup.classList.contains('hidden')).toBe(true);
    wrap.querySelector('button')!.click();
    expect(built[0].isActive).toBe(true);
    built[0].exit();
    // Its timeline rows read the product's icon by their type, as they always did.
    expect(ObjectIcons.srcFor(undefined, 'draft')).toBe('icons/draft.png');
    dialogs.apply([]);
    expect(registry.ids).toEqual([]);
    expect(ObjectIcons.srcFor(undefined, 'draft')).toBe('icons/draft.png');
  });

  it('rebuilds a dialog whose metadata changed, closing it, and leaves the others open', () => {
    const { registry, dialogs, built, changes } = catalog();
    dialogs.apply([entry(STANDOFF), entry(BRACKET)]);
    const [standoff, bracket] = built;
    bracket.enter();
    standoff.enter();
    dialogs.apply([entry(STANDOFF), entry(BRACKET)]);
    expect(changes).toHaveBeenCalledOnce();
    expect(built).toHaveLength(2);

    const taller = { ...STANDOFF, params: { ...STANDOFF.params, height: { type: 'length' as const, default: 14, label: 'Height' } } };
    dialogs.apply([entry(taller), entry(BRACKET)]);
    expect(built).toHaveLength(3);
    expect(standoff.isActive).toBe(false);
    expect(registry.get('feature:acme.standoff')).toBe(built[2]);

    dialogs.apply([entry(BRACKET)]);
    expect(registry.ids).toEqual(['feature:acme.bracket']);
    expect(ObjectIcons.srcFor(undefined, 'acme.standoff')).toBe('icons/acme.standoff.png');
  });

  it('asks for every declared image again after a module was saved — a saved image changes no metadata, so no dialog is rebuilt for it', async () => {
    const { dialogs, built, container } = catalog();
    dialogs.apply([entry(CLIP), entry(BRACKET)]);
    // Shown, so its rows hold their defaults: the select's button wears the chosen option's image.
    built.find(service => service.id === 'feature:acme.clip')!.dialogPanel.show();
    const dialog = container.querySelector<HTMLElement>('#fluidcad-feature-acme-clip')!;
    const srcs = (root: ParentNode) => [...root.querySelectorAll('img')].map(img => img.getAttribute('src'));
    const asset = (file: string, revision: number) =>
      `api/features/asset?id=acme.clip&path=${encodeURIComponent(file)}${revision > 0 ? `&v=${revision}` : ''}`;
    const shownAt = (revision: number) => {
      expect(dialog.querySelector('[data-role="icon"]')!.getAttribute('src')).toBe(asset('./clip.svg', revision));
      expect(srcs(dialog.querySelector('[data-role="value-size"]')!)).toEqual([asset('./clip/m4.svg', revision)]);
      expect(srcs(dialog.querySelector('[data-role="value-head"]')!)).toEqual([asset('./clip/pan.svg', revision), asset('./clip/hex.svg', revision)]);
      expect(srcs(dialogs.menu.entries.find(cell => cell.el.dataset.tool === 'feature:acme.clip')!.el)).toEqual([asset('./clip.svg', revision)]);
      expect(ObjectIcons.srcFor(undefined, 'acme.clip')).toBe(asset('./clip.svg', revision));
    };
    shownAt(0);

    for (const revision of [1, 2]) {
      vi.mocked(api.getFeatureCatalog).mockResolvedValueOnce([entry(CLIP), entry(BRACKET)]);
      await dialogs.refresh({ changed: true });
      expect(built).toHaveLength(2);
      shownAt(revision);
    }
    // The popover is drawn at each opening: its images are the saved ones too.
    dialog.querySelector<HTMLElement>('[data-role="value-size"]')!.click();
    expect(srcs(document.querySelector('[role="option"]')!)).toEqual([asset('./clip/m3.svg', 2)]);
    dialog.querySelector<HTMLElement>('[data-role="value-size"]')!.click();

    // A refresh that follows no save (the engine coming up) asks for nothing again.
    vi.mocked(api.getFeatureCatalog).mockResolvedValueOnce([entry(CLIP), entry(BRACKET)]);
    await dialogs.refresh();
    shownAt(2);
  });

  it("offers an entry it can't as a greyed cell that says why — a built-in's as a greyed button", async () => {
    const { dialogs, registry, buttons, menuButton, menuGroup, cells } = catalog();
    vi.mocked(api.getFeatureCatalog).mockResolvedValueOnce([
      entry(STANDOFF, { error: "the feature id 'acme.standoff' is used by more than one builder" }),
      { id: null, exportName: null, modulePath: '/ws/bolt-boss.feature.js', builtIn: false, meta: null, error: 'boom' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await dialogs.refresh();
    expect(registry.ids).toEqual([]);
    // Listed (so the button shows), greyed, by label.
    expect(menuGroup.classList.contains('hidden')).toBe(false);
    menuButton.click();
    expect(cells().map(cell => cell.title)).toEqual([
      "Standoff can't be offered: the feature id 'acme.standoff' is used by more than one builder",
      "bolt-boss can't be offered: boom",
    ].sort((a, b) => a.localeCompare(b)));
    expect(cells().every(cell => cell.querySelector('button')!.disabled)).toBe(true);
    expect(buttons()).toEqual(['Custom features']);
    expect(dialogs.brokenButtons).toEqual([]);

    // A built-in that can't be offered greys where its button would be.
    dialogs.apply([{ id: 'draft', exportName: 'draft', modulePath: 'fluidcad/core', builtIn: true, meta: DRAFT, error: 'shared id' }]);
    warn.mockRestore();
    expect(buttons()).toEqual(['Custom features', "Draft can't be offered: shared id"]);
    expect(dialogs.brokenButtons).toHaveLength(1);
    expect(dialogs.menu.entries).toEqual([]);
    expect(menuGroup.classList.contains('hidden')).toBe(true);
    dialogs.apply([]);
    expect(buttons()).toEqual(['Custom features']);
  });

  it("lists only the workspace's features under the Custom button, create ones first, each by label", () => {
    const { dialogs, container, menuGroup, menuButton, cells, navbar, modify } = catalog();
    expect(menuGroup.classList.contains('hidden')).toBe(true);
    // The last group on the bar, after every tool group.
    expect(modify.parentElement!.lastElementChild).toBe(menuGroup);
    dialogs.apply([
      { id: 'draft', exportName: 'draft', modulePath: 'fluidcad/core', builtIn: true, meta: DRAFT },
      entry({ ...POCKET, group: 'modify' }),
      entry(STANDOFF),
      entry(BOLT_CIRCLE),
    ]);
    expect(menuGroup.classList.contains('hidden')).toBe(false);
    // None of them is a button on the bar; Draft is.
    expect(container.querySelector('[data-tool="feature:acme.standoff"]')).toBeNull();
    expect(navbar.getGroup('modify')!.querySelector('[data-tool="feature:draft"]')).not.toBeNull();
    menuButton.click();
    expect(cells().map(cell => cell.dataset.tool)).toEqual(['feature:acme.boltCircle', 'feature:acme.standoff', 'feature:acme.pocket']);
    expect(cells()[1].title).toBe('Standoff — A boss with a bore');
    expect(cells()[1].querySelector('img')!.getAttribute('src')).toBe('api/features/asset?id=acme.standoff&path=.%2Fstandoff.svg');
    expect(cells()[0].querySelector('img')!.getAttribute('src')).toBe('icons/solid.png');
  });

  it("opens a cell's dialog and reads as armed while one of its features' dialogs is open", () => {
    const { dialogs, built, menuButton, cells, container } = catalog();
    dialogs.apply([entry(STANDOFF), entry(BOLT_CIRCLE)]);
    menuButton.click();
    cells()[1].querySelector('button')!.click();
    expect(dialogs.menu.isOpen).toBe(false);
    const standoff = built.find(s => s.id === 'feature:acme.standoff')!;
    expect(built.map(s => s.isActive)).toEqual([true, false]);
    expect(container.querySelector('#fluidcad-feature-acme-standoff')!.classList.contains('hidden')).toBe(false);
    expect(menuButton.className).toContain('btn-primary');

    // Its cell reads as armed in the dropdown too; clicking it again closes the dialog, as a button does.
    menuButton.click();
    expect(cells()[1].querySelector('button')!.className).toContain('btn-primary');
    cells()[1].querySelector('button')!.click();
    expect(standoff.isActive).toBe(false);
    expect(menuButton.className).toContain('btn-ghost');

    // An edit of one of them is its dialog open too.
    const boltCircle = built.find(s => s.id === 'feature:acme.boltCircle')!;
    const parsed: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
      feature: 'custom', id: 'acme.boltCircle', callee: 'boltCircle',
      values: { count: 8 }, picks: { around: [{ text: "'z'", start: 100, end: 103 }] },
      operation: 'remove', scopeTexts: [], scopeRefs: [],
    };
    boltCircle.enterEdit(at(11, 15), parsed, { index: 5, type: 'acme.boltCircle', expectedStatement: "boltCircle('z', { count: 8 })" });
    expect(menuButton.className).toContain('btn-primary');
    boltCircle.exit();
    expect(menuButton.className).toContain('btn-ghost');
  });

  it('keeps the Custom button and an open dropdown in step with the catalog', () => {
    const { dialogs, built, menuButton, menuGroup, cells } = catalog();
    dialogs.apply([entry(STANDOFF), entry(BRACKET)]);
    menuButton.click();
    expect(cells().map(cell => cell.textContent)).toEqual(['Bracket', 'Standoff']);

    // A feature module added, one renamed: the open dropdown follows, still open.
    dialogs.apply([entry({ ...STANDOFF, label: 'Anchor post' }), entry(BRACKET), entry(BOLT_CIRCLE)]);
    expect(dialogs.menu.isOpen).toBe(true);
    expect(cells().map(cell => cell.textContent)).toEqual(['Anchor post', 'Bolt circle', 'Bracket']);
    expect(built).toHaveLength(4);

    // A rebuilt feature whose dialog was open: the armed look goes with the old dialog.
    built[3].enter();
    expect(menuButton.className).toContain('btn-primary');
    dialogs.apply([entry({ ...STANDOFF, label: 'Anchor post' }), entry(BRACKET), entry({ ...BOLT_CIRCLE, label: 'Bolt ring' })]);
    expect(menuButton.className).toContain('btn-ghost');

    // The last custom feature gone: the button leaves the bar, the dropdown with it.
    menuButton.click();
    dialogs.apply([]);
    expect(dialogs.menu.isOpen).toBe(false);
    expect(menuGroup.classList.contains('hidden')).toBe(true);
    expect(cells()).toEqual([]);
  });

  it('asks an open dialog its metadata left as it was for its preview again once a module is saved', async () => {
    // The user turned the standoff's preview on before.
    PreviewPreference.write('acme.standoff', true);
    const { dialogs, built } = catalog();
    vi.mocked(api.getFeatureCatalog).mockResolvedValue([entry(STANDOFF), entry(BRACKET)]);
    await dialogs.refresh();
    const [standoff, bracket] = built;
    standoff.update(scene());
    standoff.enter();
    standoff.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    const asked = () => vi.mocked(api.fetchFeatureGhostResult).mock.calls.length;
    expect(asked()).toBe(1);

    // The engine coming up again lists the same features: nothing to ask.
    await dialogs.refresh();
    await vi.advanceTimersByTimeAsync(300);
    expect(asked()).toBe(1);

    // A module saved, its metadata the same: the same dialog, its pick kept,
    // asks again — the engine draws the saved code. The closed one asks nothing.
    await dialogs.refresh({ changed: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(built).toEqual([standoff, bracket]);
    expect(standoff.isActive).toBe(true);
    expect(asked()).toBe(2);
    expect(vi.mocked(api.fetchFeatureGhostResult).mock.calls[1][0]).toMatchObject({
      id: 'acme.standoff', refs: { face: [{ kind: 'entities', entities: [{ shapeId: 'plate-solid', index: 4 }] }] },
    });
    standoff.exit();
  });

  it('keeps the newest answer when two refreshes overlap', async () => {
    const { dialogs, registry } = catalog();
    let resolveFirst!: (entries: FeatureCatalogEntry[]) => void;
    vi.mocked(api.getFeatureCatalog)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([entry(BRACKET)]);
    const first = dialogs.refresh();
    await dialogs.refresh({ changed: true });
    resolveFirst([entry(STANDOFF)]);
    await first;
    expect(registry.ids).toEqual(['feature:acme.bracket']);
  });

  it('takes the Custom button off the bar while a sketch is up, also when its first feature arrives mid-sketch', () => {
    const { dialogs, built, navbar, menuGroup } = catalog();
    const finish = new FinishSketchButton(navbar.addGroup('create', { immune: true }), () => [
      ...built.flatMap(s => s.toolbarButton ? [s.toolbarButton] : []),
      ...dialogs.brokenButtons,
      dialogs.menu,
    ]);
    finish.setVisible(true);
    dialogs.apply([entry(STANDOFF), entry({ ...BRACKET, group: 'modify' })]);
    finish.sync();
    expect(built.map(s => s.toolbarButton)).toEqual([null, null]);
    expect(menuGroup.classList.contains('hidden')).toBe(true);
    dialogs.menu.open();
    expect(dialogs.menu.isOpen).toBe(false);
    finish.setVisible(false);
    expect(menuGroup.classList.contains('hidden')).toBe(false);
  });
});

describe('a select of several in a custom feature dialog', () => {
  /** A face treated by the finishes chosen — up to two of them, deburring unless told otherwise. */
  const TREAT = meta('acme.treat', 'Treat', {
    face: { picker: 'face', label: 'Face' },
    finishes: {
      type: 'select', multiple: true, label: 'Finishes', default: ['deburr'], max: 2,
      options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Chamfer', value: 'chamfer' }, { label: 'Polish', value: 'polish' }],
    },
    marks: { type: 'select', multiple: true, label: 'Marks', default: [], options: [{ label: 'Lot', value: 1 }, { label: 'Date', value: 2 }] },
  }, { operations: ['remove'], defaultOperation: 'remove', call: ['face', { finishes: 'finishes', marks: 'marks' }] });
  const apply = async (service: SchemaFeatureService) => {
    await service.dialogPanel.onApply!();
    await vi.advanceTimersByTimeAsync(0);
  };
  const created = () => vi.mocked(api.applyCustomFeature).mock.calls.map(call => call[0]).filter(request => !request.preview);
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

  it('writes nothing for a list left alone — the default it shows is the builder\'s — and the ghost carries what the rows hold', async () => {
    const { service, input, lastCreate, lastGhost } = mount(TREAT);
    service.enter();
    expect(input('finishes').tagName).toBe('BUTTON');
    expect(input('finishes').textContent).toBe('Deburr');
    expect(input('marks').textContent).toBe('None');
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()).toMatchObject({ id: 'acme.treat', values: {}, preview: true });
    expect(lastGhost()![0].values).toEqual({ finishes: ['deburr'], marks: [] });
    await apply(service);
    expect(created()).toHaveLength(1);
    expect(created()[0].values).toEqual({});
  });

  it('writes the list the user chose in the options\' order, the popover open through every toggle, and refuses one over its max', async () => {
    const { service, input, lastCreate, lastGhost, message } = mount(TREAT);
    service.enter();
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    input('finishes').click();
    options()[2].click();
    expect(input('finishes').getAttribute('aria-expanded')).toBe('true');
    expect(input('finishes').textContent).toBe('Deburr, Polish');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({ finishes: ['deburr', 'polish'] });
    expect(lastGhost()![0].values).toEqual({ finishes: ['deburr', 'polish'], marks: [] });

    options()[1].click();
    expect(input('finishes').textContent).toBe('3 selected');
    const before = created().length;
    await apply(service);
    expect(message()).toBe('Finishes takes at most 2.');
    expect(created()).toHaveLength(before);

    options()[0].click();
    await apply(service);
    expect(created().at(-1)!.values).toEqual({ finishes: ['chamfer', 'polish'] });
  });

  it('edits a statement\'s list: shown as written, kept while untouched, and emptied it writes an empty list', async () => {
    const { service, input, lastEdit } = mount(TREAT);
    const rendered = [...scene(), {
      id: 'tr', type: 'acme.treat', name: 'Treat', parentId: 'part', ownShapes: [], sourceLocation: at(12, 2),
      sceneShapes: [{ shapeId: 'treat-solid', shapeType: 'solid', meshes: MESH }],
    }] as SceneObjectRender[];
    const statement: Extract<ParsedFeatureStatement, { feature: 'custom' }> = {
      feature: 'custom', id: 'acme.treat', callee: 'treat',
      values: { finishes: ['deburr', 'polish'] }, picks: { face: [{ text: 'pad.endFaces()', start: 0, end: 14 }] },
      operation: 'remove', scopeTexts: [], scopeRefs: [],
    };
    service.enterEdit(at(12, 2), statement, { index: 6, type: 'acme.treat', expectedStatement: "treat(pad.endFaces(), { finishes: ['deburr', 'polish'] })" });
    service.handleSceneRendered(rendered, 5, true);
    expect(input('finishes').textContent).toBe('Deburr, Polish');
    // A list the statement leaves out shows its default.
    expect(input('marks').textContent).toBe('None');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({});

    input('finishes').click();
    options()[0].click();
    options()[2].click();
    expect(input('finishes').textContent).toBe('None');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({ finishes: [] });

    // A click on the open trigger closes its popover; the other row's opens alone.
    input('finishes').click();
    input('marks').click();
    options()[1].click();
    await vi.advanceTimersByTimeAsync(300);
    expect(lastEdit()!.values).toEqual({ finishes: [], marks: [2] });
  });
});

describe('options that wait on another value in a custom feature dialog', () => {
  /** A tapped hole: the sizes on offer are the standard's own. */
  const TAP = meta('acme.tap', 'Tap', {
    face: { picker: 'face', label: 'Face' },
    standard: { type: 'select', label: 'Standard', default: 'iso', options: [{ label: 'Metric', value: 'iso' }, { label: 'Imperial', value: 'unc' }] },
    size: {
      type: 'select', label: 'Size', default: 'm3',
      options: [
        { label: 'M3', value: 'm3', when: { standard: 'iso' } },
        { label: 'M4', value: 'm4', when: { standard: 'iso' } },
        { label: '#4', value: 'n4', when: { standard: 'unc' } },
        { label: '#6', value: 'n6', when: { standard: 'unc' } },
      ],
    },
  }, { operations: ['remove'], defaultOperation: 'remove', call: ['face', { standard: 'standard', size: 'size' }] });

  it('writes nothing while untouched, and the size that moved with the standard once it is switched', async () => {
    const { service, type, input, lastCreate, lastGhost } = mount(TAP);
    service.enter();
    expect([...input('size').options].map(o => o.textContent)).toEqual(['M3', 'M4']);
    service.handleClick('plate-solid', faceOf('plate-solid', 4).sub);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({});

    // The user changed the standard only: its sizes replace the others, and the size shown is written with it.
    type('standard', '1');
    await vi.advanceTimersByTimeAsync(300);
    expect([...input('size').options].map(o => o.textContent)).toEqual(['#4', '#6']);
    expect(lastCreate()!.values).toEqual({ standard: 'unc', size: 'n4' });
    expect(lastGhost()![0].values).toEqual({ standard: 'unc', size: 'n4' });

    type('size', '1');
    await vi.advanceTimersByTimeAsync(300);
    expect(lastCreate()!.values).toEqual({ standard: 'unc', size: 'n6' });
    service.exit();
  });
});

describe('a dialog laid out by its feature', () => {
  const VALUES: FeatureMetaSnapshot['params'] = {
    height: { type: 'length', label: 'Height', default: 10 },
    count: { type: 'integer', label: 'Count', default: 4 },
    depth: { type: 'length', label: 'Depth' },
    base: { picker: 'face', label: 'Base' },
  };
  const LAID = meta('acme.laid', 'Laid', VALUES, {
    width: 'wider',
    aside: [{ note: 'Seen from the side.' }],
    layout: [
      { row: ['height', 'count'] },
      { tabs: [
        { label: 'Main', items: [{ note: 'Nothing to set here.' }] },
        { label: 'More', items: [
          { section: 'Deep', collapsed: true, items: ['depth'] },
          { section: 'Place', collapsed: true, items: ['base'] },
        ] },
      ] },
    ],
  });
  const DEFAULTS: FeatureMetaSnapshot['params'] = { ...VALUES, depth: { type: 'length', label: 'Depth', default: 3 }, base: { picker: 'face', label: 'Base', optional: true } };

  const services: SchemaFeatureService[] = [];
  const open = (featureMeta: FeatureMetaSnapshot) => {
    const mounted = mount(featureMeta);
    services.push(mounted.service);
    mounted.service.enter();
    const rowShown = (name: string) => !mounted.panel().querySelector(`[data-param="${name}"]`)!.closest('.hidden');
    const apply = async () => {
      await mounted.service.dialogPanel.onApply!();
      await vi.advanceTimersByTimeAsync(0);
    };
    return { ...mounted, rowShown, apply };
  };
  const created = () => vi.mocked(api.applyCustomFeature).mock.calls.map(call => call[0]).filter(request => !request.preview);

  afterEach(() => {
    services.splice(0).forEach(service => service.destroy());
  });

  it('brings the value that blocks Apply into view — its tab shown, its section unfolded — and names it; a preview moves nothing', async () => {
    const { type, message, rowShown, apply, panel } = open(LAID);
    type('height', '12');
    await vi.advanceTimersByTimeAsync(300);
    // The statement preview asked for the request too: the dialog stays where the user left it.
    expect(rowShown('depth')).toBe(false);
    await apply();
    expect(message()).toBe('Depth is required.');
    expect(rowShown('depth')).toBe(true);
    expect(panel().querySelector('[data-group="Deep"] [data-role="section-toggle"]')!.getAttribute('aria-expanded')).toBe('true');
    // The section of the value that didn't block stays folded.
    expect(rowShown('base')).toBe(false);
    type('depth', '3');
    await apply();
    // Now the pick left out blocks: its section unfolds.
    expect(message()).not.toBe('Depth is required.');
    expect(message()).not.toBe('');
    expect(rowShown('base')).toBe(true);
    expect(created()).toEqual([]);
  });

  it('writes nothing for an untouched create, and the same request as the dialog without a layout', async () => {
    const laid = open(meta('acme.laid', 'Laid', DEFAULTS, { width: LAID.width, aside: LAID.aside, layout: LAID.layout }));
    expect(laid.panel().innerHTML).toContain('sm:w-72');
    expect(laid.panel().querySelector('[data-role="side-card"]')!.textContent).toBe('Seen from the side.');
    await laid.apply();
    const plain = open(meta('acme.laid', 'Laid', DEFAULTS));
    await plain.apply();
    expect(created()).toHaveLength(2);
    expect(created()[0].values).toEqual({});
    expect(created()[0]).toEqual(created()[1]);
  });
});
