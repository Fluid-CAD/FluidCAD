// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import type {
  ApplyFeatureResponse, FeatureEditTarget, FeatureSourcesResult, IntersectionCurveApplyOptions, IntersectionCurveEditOptions,
  IntersectionCurveGhostRequest, OperandInputRef, GhostOperandRef, SelectionGroup,
} from '../src/api';
import type { ExtraPickRow, ExtraRowHighlight } from '../src/interactive/create-feature/extra-pick-row';
import type { FeatureLauncher } from '../src/interactive/create-feature/feature-button';
import { OperandRowPanel, type ArmableControl } from '../src/interactive/create-feature/operand-row-panel';
import { OperandRowService, type RowEdits, type RowLists } from '../src/interactive/create-feature/operand-row-service';
import { RecentClicks, type ClickedPick } from '../src/interactive/create-feature/recent-clicks';
import { NO_CHANNELS, type PickChannels, type PickOutcome } from '../src/interactive/create-feature/schema/schema-pickers';
import type { ParsedFeatureOf } from '../src/interactive/feature-dialog-registry';
import type { SceneObjectRender, SubSelection } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// The shared layer of the operand-row dialogs (Curves › Intersect, Curves ›
// Project, and the curve and surface tools after them), on a fixture tool of
// its own: a curve row, a surface row and a stub row beside them. What the
// layer owns is pinned here — the arming order, every gesture landing in the
// armed row, a double-click's echo coming back out of the next row, edit
// seeding by the rows' names, and the rows each request carries — and not
// what either real dialog adds. The network is stubbed (FakeSelectionServer)
// because the suite shares one worker across files.

let server: FakeSelectionServer;
const services: FixtureService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSelectionServer().install();
});

/** Close every dialog a test mounted and empty the page, so a second mount is the one the queries find. */
function unmount(): void {
  for (const service of services.splice(0)) {
    service.exit();
  }
  document.body.innerHTML = '';
}

afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/fixture.part.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];
const face = (index: number, shapeId = 'block-solid'): SelectedEntity => ({ shapeId, sub: { type: 'face', index } });
const edge = (index: number, shapeId = 'block-solid'): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });

/** A sketch with a drawn ring, a block, a loaded surface and, with `withCurve`, the statement an edit opens over. */
function scene(withCurve = false): SceneObjectRender[] {
  return [
    { id: 'sk', type: 'sketch', name: 'Sketch 1', isContainer: true, ownShapes: [], sceneShapes: [], sourceLocation: at(2) },
    {
      id: 'ring', type: 'circle', parentId: 'sk', ownShapes: [], sourceLocation: at(3),
      sceneShapes: [{ shapeId: 'ring-wire', shapeType: 'edge', meshes: MESH }],
    },
    {
      id: 'block', type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: 'block-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'wing', type: 'load', name: 'Load 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'wing-surface', shapeType: 'surface', meshes: MESH }],
    },
    ...(withCurve ? [{
      id: 'fc', type: 'intersection-curve', name: 'Fixture Curve 1', ownShapes: [], sourceLocation: at(8),
      sceneShapes: [{ shapeId: 'fc-wire', shapeType: 'wire', meshes: MESH }],
    }] : []),
  ] as unknown as SceneObjectRender[];
}
const rowOf = (id: string) => scene().find(o => o.id === id)!;

type FixtureRow = 'first' | 'second';

/** The fixture borrows the intersection curve's wires (rows `first` and `second`), with an option of its own. */
type FixtureWires = {
  parsed: ParsedFeatureOf<'intersection-curve'>;
  sources: Extract<FeatureSourcesResult, { feature: 'intersection-curve' }>;
  create: IntersectionCurveApplyOptions & { option: string };
  edit: IntersectionCurveEditOptions & { option?: string };
  ghost: IntersectionCurveGhostRequest & { option: string };
};

/** A row beside the operand rows that takes what the test tells it to, and records what the service asked of it. */
class StubExtraRow implements ExtraPickRow {
  onPick?: (outcome: PickOutcome) => void;
  readonly rowRefusal = 'takes nothing from it.';
  readonly calls: string[] = [];
  clickAnswer: PickOutcome = 'taken';
  rowAnswer: PickOutcome = 'ignored';

  channels(): PickChannels {
    return { ...NO_CHANNELS, pickFilter: 'vertex', vertices: true };
  }

  aim(armed: boolean): void {
    this.calls.push(`aim:${armed}`);
  }

  async takeClick(shapeId: string): Promise<PickOutcome> {
    this.calls.push(`click:${shapeId}`);
    return this.clickAnswer;
  }

  takeRow(row: SceneObjectRender): PickOutcome {
    this.calls.push(`row:${row.id}`);
    return this.rowAnswer;
  }

  setScene(_scene: SceneObjectRender[], opts: { dropEntities: boolean }): boolean {
    this.calls.push(`scene:${opts.dropEntities}`);
    return false;
  }

  paint(): ExtraRowHighlight {
    return { entities: [], wireIds: [], planeQuadIds: ['extra-quad'] };
  }

  close(): void {
    this.calls.push('close');
  }

  release(): void {
    this.calls.push('release');
  }
}

/** The DOM half of the row beside the operand rows. */
class StubControl implements ArmableControl {
  onArm?: () => void;
  onChange?: () => void;
  armed = false;
  resets = 0;

  setArmed(armed: boolean): void {
    this.armed = armed;
  }

  reset(): void {
    this.resets++;
  }
}

/** A curve row, a surface row, a row beside them and one option. */
class FixturePanel extends OperandRowPanel<FixtureRow, 'extra'> {
  readonly extra: StubControl;
  option = 'default';

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fixture-tool',
      title: 'Fixture',
      editTitle: 'Edit fixture',
      rows: [
        { row: 'first', kind: 'curve', label: 'Curves', prompt: 'Pick curves', empty: 'Pick the curves.' },
        { row: 'second', kind: 'surface', label: 'Faces', prompt: 'Pick faces', empty: 'Pick the faces.' },
      ],
    });
    this.extra = this.armable('extra', new StubControl());
  }

  protected override resetOptions(): void {
    this.option = 'default';
  }
}

/** What the fixture tool's api calls were handed. */
type Sent = { kind: 'create' | 'edit'; request: object & { preview?: boolean } };

const APPLIED: ApplyFeatureResponse = { success: true, preview: 'fixture(…)' };

class FixtureService extends OperandRowService<FixtureRow, 'extra', FixtureWires, FixturePanel> {
  readonly sent: Sent[];
  readonly extraRow: StubExtraRow;
  /** What the tool's seeding hooks saw, in order. */
  readonly seeds: string[] = [];
  /** The tool's own fields name an edge or a face (as a picked direction does). */
  ownEntityPick = false;
  /** The tool's preview request is complete. */
  previewReady = true;

  constructor(container: HTMLElement, viewer: Viewer, launcher: FeatureLauncher) {
    const sent: Sent[] = [];
    const extraRow = new StubExtraRow();
    super(container, viewer, launcher, {}, new FixturePanel(container), {
      kind: 'intersection-curve',
      noun: 'fixture curve',
      create: async request => {
        sent.push({ kind: 'create', request });
        return APPLIED;
      },
      edit: async (_target, request) => {
        sent.push({ kind: 'edit', request });
        return APPLIED;
      },
      extraRows: { extra: extraRow },
    });
    this.sent = sent;
    this.extraRow = extraRow;
  }

  protected isAvailable(sceneObjects: SceneObjectRender[]): boolean {
    return sceneObjects.length > 0;
  }

  protected createRequest(rows: RowLists<FixtureRow, OperandInputRef>): FixtureWires['create'] {
    return { ...rows, option: this.panel.option };
  }

  protected editRequest(rows: RowEdits<FixtureRow>): FixtureWires['edit'] {
    return {
      ...rows,
      option: this.panel.option !== 'default' ? this.panel.option : undefined,
      ...this.editSession(rows, this.ownEntityPick),
    };
  }

  protected ghostRequest(rows: RowLists<FixtureRow, GhostOperandRef>): FixtureWires['ghost'] | null {
    return this.previewReady ? { feature: 'intersection-curve', ...rows, option: this.panel.option } : null;
  }

  protected override seedEdit(parsed: FixtureWires['parsed']): void {
    const held = this.panel.slot('first').picks();
    this.seeds.push(`edit:${parsed.firstTexts.join(',')}:${'keep' in held ? 'rows seeded' : 'rows empty'}`);
  }

  protected override seedSources(sources: FixtureWires['sources'] | null): void {
    this.seeds.push(sources ? `sources:${sources.feature}` : 'sources:none');
  }
}

/** A viewer that records the highlight and the pick channels; every other call is a no-op. */
function stubViewer() {
  const highlights: { entities: SelectedEntity[]; wireIds: string[]; shapeIds: string[]; planeQuadIds: string[] }[] = [];
  const base: Record<string, unknown> = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    pickVertices: false,
    sceneContext: { scene: new Scene(), camera: new PerspectiveCamera(), requestRender: () => {} },
    highlightEntities: (entities: SelectedEntity[], wireIds: string[] = [], shapeIds: string[] = [], planeQuadIds: string[] = []) =>
      highlights.push({ entities, wireIds, shapeIds, planeQuadIds }),
    clearHighlight: () => highlights.push({ entities: [], wireIds: [], shapeIds: [], planeQuadIds: [] }),
  };
  const viewer = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Viewer;
  return { viewer, highlights, channels: base };
}

function mount() {
  unmount();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const launcherState = { active: false, disabled: true };
  const launcher: FeatureLauncher = {
    setActive: (active) => {
      launcherState.active = active;
    },
    setDisabled: (disabled) => {
      launcherState.disabled = disabled;
    },
    remove: () => {},
  };
  const { viewer, highlights, channels } = stubViewer();
  const service = new FixtureService(container, viewer, launcher);
  services.push(service);
  service.update(scene());
  const panel = () => document.getElementById('fluidcad-fixture-tool-panel')!;
  const chips = (row: FixtureRow) =>
    [...panel().querySelectorAll<HTMLElement>(`[data-role="${row}-slot"] span.truncate[title]`)].map(el => el.textContent);
  const message = () => panel().querySelector('[data-role="message"]')!.textContent;
  const armRow = (row: FixtureRow) => panel().querySelector<HTMLElement>(`[data-role="${row}-slot"]`)!.click();
  const apply = () => panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
  const click = (entity: SelectedEntity) => service.handleClick(entity.shapeId, entity.sub);
  return {
    container, service, viewer, highlights, channels, launcher, launcherState, panel, chips, message, armRow, apply, click,
    extra: service.extraRow, dialog: service.dialogPanel,
  };
}

/** What the tool's api calls were handed for Apply (previews left out). */
const applied = (service: FixtureService) => service.sent.filter(entry => !entry.request.preview);

describe('the operand-row panel and service — arming', () => {
  it('opens on the first operand row, hands the border to the next only while it is empty, and arms a row beside them only when asked', async () => {
    const rig = mount();
    rig.service.enter();
    expect(rig.dialog.armedRow).toBe('first');
    expect(rig.channels).toMatchObject({ pickFilter: 'edge', pickSketchWires: true });
    expect(rig.dialog.extra.armed).toBe(false);

    rig.click(edge(4));
    expect(rig.chips('first')).toEqual(['Picked edge']);
    expect(rig.dialog.armedRow).toBe('second');
    expect(rig.channels).toMatchObject({ pickFilter: 'face', pickSketchWires: false });

    rig.click(face(2));
    expect(rig.chips('second')).toEqual(['Picked face']);
    expect(rig.dialog.armedRow).toBe('second');

    // A click on a row arms it; the next one holding something, it keeps the border.
    rig.armRow('first');
    rig.click(edge(5));
    expect(rig.chips('first')).toEqual(['Picked edge', 'Picked edge']);
    expect(rig.dialog.armedRow).toBe('first');

    // The row beside them: its channels, its own viewer extras, and no hand-on.
    rig.dialog.armRow('extra');
    expect(rig.dialog.extra.armed).toBe(true);
    expect(rig.channels).toMatchObject({ pickFilter: 'vertex', pickVertices: true });
    expect(rig.extra.calls.at(-1)).toBe('aim:true');
    rig.click(edge(6));
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.extra.calls).toContain('click:block-solid');
    expect(rig.dialog.armedRow).toBe('extra');

    // Leaving it closes what it opened and takes its extras back.
    rig.extra.calls.length = 0;
    rig.armRow('second');
    expect(rig.extra.calls).toEqual(['close', 'aim:false']);
  });

  it('opens empty with the options at their defaults, keeps the launcher in step, and lets go of every row on exit', () => {
    const rig = mount();
    expect(rig.launcherState).toEqual({ active: false, disabled: false });
    rig.service.enter();
    rig.click(edge(4));
    rig.dialog.option = 'changed';
    expect(rig.launcherState.active).toBe(true);

    rig.service.exit();
    expect(rig.launcherState.active).toBe(false);
    expect(rig.extra.calls.slice(-2)).toEqual(['close', 'release']);
    expect(rig.channels.pickFilter).toBe('all');
    expect(rig.dialog.extra.resets).toBe(2);

    rig.service.enter();
    expect(rig.chips('first')).toEqual([]);
    expect(rig.dialog.option).toBe('default');
    expect(rig.dialog.armedRow).toBe('first');

    // A scene with nothing to work on greys the launcher and closes the dialog.
    rig.service.update([]);
    expect(rig.launcherState).toEqual({ active: false, disabled: true });
    expect(rig.service.isActive).toBe(false);
  });
});

describe('the operand-row service — gestures into the armed row', () => {
  it('takes a sketch\'s wire only into a curve row, and a timeline row of the armed row\'s kind, refusing any other in the row\'s words', () => {
    const rig = mount();
    rig.service.enter();
    expect(rig.service.isCurvePicking).toBe(true);
    expect(rig.service.handleSketchPick('ring-wire')).toBe(true);
    expect(rig.chips('first')).toEqual(['Sketch']);
    expect(rig.dialog.armedRow).toBe('second');
    expect(rig.service.isCurvePicking).toBe(false);
    expect(rig.service.handleSketchPick('ring-wire')).toBe(false);

    expect(rig.service.handleTimelinePick(rowOf('block'))).toBe(true);
    expect(rig.message()).toBe('Extrude 1 holds no surface — pick a surface\'s row, or faces in the viewport.');
    expect(rig.service.handleTimelinePick(rowOf('wing'))).toBe(true);
    expect(rig.chips('second')).toEqual(['Load 1']);
    expect(rig.message()).toBe('');

    rig.armRow('first');
    rig.service.handleTimelinePick(rowOf('block'));
    expect(rig.message()).toBe('Extrude 1 holds no curve — pick a sketch\'s or a curve\'s row, or edges in the viewport.');

    // The row beside them answers for itself, in its own words.
    rig.dialog.armRow('extra');
    rig.service.handleTimelinePick(rowOf('wing'));
    expect(rig.extra.calls).toContain('row:wing');
    expect(rig.message()).toBe('Load 1 takes nothing from it.');
    rig.extra.rowAnswer = { message: 'Not that one.' };
    rig.service.handleTimelinePick(rowOf('wing'));
    expect(rig.message()).toBe('Not that one.');
    rig.extra.rowAnswer = 'taken';
    rig.service.handleTimelinePick(rowOf('wing'));
    expect(rig.message()).toBe('');
  });

  it('lands the answer of a row beside them once it comes, and the picks it takes by its own channels', async () => {
    const rig = mount();
    rig.service.enter();
    rig.dialog.armRow('extra');
    rig.extra.clickAnswer = { message: 'That edge is curved.' };
    rig.click(edge(1));
    expect(rig.message()).toBe('');
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('That edge is curved.');

    rig.extra.onPick!({ message: 'That gizmo is no connector.' });
    expect(rig.message()).toBe('That gizmo is no connector.');
    rig.extra.onPick!('taken');
    expect(rig.message()).toBe('');
    // Its share of the highlight joins the rows'.
    expect(rig.highlights.at(-1)!.planeQuadIds).toEqual(['extra-quad']);
  });

  it('grows the row a double-click started in from its first click, taking the echo back out of the next row', async () => {
    server.bucket = () => ({ members: [edge(1), edge(2), edge(3)] });
    const rig = mount();
    rig.service.enter();
    // The viewer delivers the double-click's own clicks first: the edge fills
    // the curve row and hands the border on; the face behind it lands in the
    // surface row.
    rig.click(edge(1));
    rig.click(face(4));
    expect(rig.chips('second')).toEqual(['Picked face']);
    await rig.service.handleDoubleClick('block-solid', face(4).sub);
    expect(rig.chips('second')).toEqual([]);
    expect(rig.chips('first')).toEqual(['Picked edge', 'Picked edge', 'Picked edge']);
    expect(server.bodies('api/selection/expand-loop').map(body => body.entity)).toEqual([edge(1)]);
    // Grown, the curve row hands the border on again.
    expect(rig.dialog.armedRow).toBe('second');
  });

  it('reads no echo across a click into the row beside them, and grows nothing while that row is armed', async () => {
    server.bucket = () => ({ members: [face(4), face(5)] });
    const rig = mount();
    rig.service.enter();
    rig.click(edge(1));
    rig.dialog.armRow('extra');
    rig.click(edge(9));
    await vi.advanceTimersByTimeAsync(0);
    rig.armRow('second');
    rig.click(face(4));
    await rig.service.handleDoubleClick('block-solid', face(4).sub);
    // A gesture of the surface row's own: it grows there.
    expect(rig.chips('first')).toEqual(['Picked edge']);
    expect(rig.chips('second')).toEqual(['Picked face', 'Picked face']);

    rig.dialog.armRow('extra');
    const asked = server.requests.length;
    await rig.service.handleDoubleClick('block-solid', face(6).sub);
    rig.service.handleContextMenu('block-solid', face(6).sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.requests.slice(asked).map(request => request.route)).not.toContain('api/selection/expand-bucket');
    expect(server.count('api/selection/groups')).toBe(0);
  });

  it('lands a right-click group in the armed operand row as plain picks', async () => {
    server.groups = [{ kind: 'tangent', label: 'Tangent Edges', members: [edge(2), edge(3)] }] as SelectionGroup[];
    const rig = mount();
    rig.service.enter();
    rig.service.handleContextMenu('block-solid', edge(2).sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    const items = [...rig.container.querySelectorAll<HTMLButtonElement>('#fluidcad-intersection-curve-select-menu button')];
    expect(items.map(item => item.textContent)).toEqual(['Tangent Edges (2)']);
    items[0].click();
    expect(rig.chips('first')).toEqual(['Picked edge', 'Picked edge']);
    expect(rig.dialog.armedRow).toBe('second');
  });
});

describe('the operand-row service — editing', () => {
  const TARGET: FeatureEditTarget = at(8);
  const PARSED = {
    feature: 'intersection-curve',
    firstTexts: ['sk'],
    firstRefs: [{ line: 2, column: 0 }],
    secondTexts: ['block.faces()'],
    secondRefs: [null],
    firstArg: 'sk',
    secondArg: 'block.faces()',
  } as ParsedFeatureOf<'intersection-curve'>;
  const INFO = { index: 4, type: 'intersection-curve', expectedStatement: 'fixture(sk, block.faces())' };
  const BOUNDARY = { index: 4, type: 'intersection-curve', line: 8, column: 0 };

  /** The engine resolves the sketch and two faces, unless a test answers otherwise. */
  function answerSources(answer: unknown = {
    ok: true, feature: 'intersection-curve', first: [{ kind: 'sketch', ...at(2) }], second: [{ kind: 'entities', entities: [face(1), face(2)] }],
  }): void {
    server.routes.set('api/feature/sources', () => answer);
  }

  /** Open over the statement and land at the boundary. */
  async function openEdit(rig = mount()) {
    rig.service.enterEdit(TARGET, PARSED, INFO);
    await vi.advanceTimersByTimeAsync(0);
    rig.service.handleSceneRendered(scene(true), 3, true);
    await vi.advanceTimersByTimeAsync(300);
    return rig;
  }

  it('opens each row on its own texts before the tool seeds its options, and lights them as the engine resolved them', async () => {
    answerSources();
    const rig = await openEdit();
    expect(rig.panel().textContent).toContain('Edit fixture');
    expect(rig.chips('first')).toEqual(['Current: sk']);
    expect(rig.chips('second')).toEqual(['Current: block.faces()']);
    expect(rig.service.seeds).toEqual(['edit:sk:rows seeded', 'sources:intersection-curve']);
    expect(server.bodies('api/feature/sources')).toEqual([{ before: BOUNDARY }]);
    expect(rig.highlights.at(-1)).toMatchObject({ entities: [face(1), face(2)], wireIds: ['ring-wire'] });
  });

  it('keeps a row re-picked before the engine answered, and seeds nothing from an answer about another statement', async () => {
    answerSources();
    const rig = mount();
    rig.service.enterEdit(TARGET, PARSED, INFO);
    rig.service.handleSketchPick('ring-wire');
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.chips('first')).toEqual(['Sketch']);
    expect(rig.chips('second')).toEqual(['Current: block.faces()']);

    answerSources({ ok: true, feature: 'helix', source: { kind: 'opaque' } });
    const other = await openEdit();
    expect(other.service.seeds).toEqual(['edit:sk:rows seeded', 'sources:none']);
    expect(other.chips('second')).toEqual(['Current: block.faces()']);
  });
});

describe('the operand-row service — requests', () => {
  it('sends every row under its name in pick order with the tool\'s options, and refuses Apply at the first empty row', async () => {
    const rig = mount();
    rig.service.enter();
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Pick the curves.');
    rig.click(edge(4));
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Pick the faces.');
    expect(applied(rig.service)).toEqual([]);

    rig.click(face(2));
    rig.service.handleTimelinePick(rowOf('wing'));
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied(rig.service)).toEqual([{
      kind: 'create',
      request: {
        first: [{ kind: 'edge', shapeId: 'block-solid', index: 4 }],
        second: [{ kind: 'face', shapeId: 'block-solid', index: 2 }, { kind: 'statement', ...at(6) }],
        option: 'default',
      },
    }]);
    expect(rig.service.isActive).toBe(false);
  });

  it('previews once every row holds something it can address and the tool\'s request is complete', async () => {
    server.routes.set('api/feature-ghost', () => ({ success: true, solids: [] }));
    const rig = mount();
    rig.service.enter();
    rig.service.handleSketchPick('ring-wire');
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/feature-ghost')).toBe(0);

    rig.service.previewReady = false;
    rig.click(face(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/feature-ghost')).toBe(0);

    rig.service.previewReady = true;
    rig.click(face(3));
    await vi.advanceTimersByTimeAsync(300);
    expect(server.bodies('api/feature-ghost').map(({ activePart: _p, valueScope: _s, ...body }) => body)).toEqual([{
      feature: 'intersection-curve',
      first: [{ kind: 'statement', filePath: FILE, line: 2 }],
      second: [2, 3].map(index => ({ kind: 'face', shapeId: 'block-solid', index })),
      option: 'default',
    }]);
  });

  it('previews a kept row as what the engine resolved it to, an edge in a curve row and a face in a surface row only', async () => {
    server.routes.set('api/feature-ghost', () => ({ success: true, solids: [] }));
    const TARGET: FeatureEditTarget = at(8);
    const PARSED = {
      feature: 'intersection-curve', firstTexts: ['block.edges(7)'], firstRefs: [null], secondTexts: ['block.faces()'],
      secondRefs: [null], firstArg: 'block.edges(7)', secondArg: 'block.faces()',
    } as ParsedFeatureOf<'intersection-curve'>;
    const INFO = { index: 4, type: 'intersection-curve', expectedStatement: 'fixture(block.edges(7), block.faces())' };
    const open = async (first: SelectedEntity[]) => {
      server.routes.set('api/feature/sources', () => ({
        ok: true, feature: 'intersection-curve',
        first: [{ kind: 'entities', entities: first }], second: [{ kind: 'entities', entities: [face(1)] }],
      }));
      const rig = mount();
      rig.service.enterEdit(TARGET, PARSED, INFO);
      await vi.advanceTimersByTimeAsync(0);
      rig.service.handleSceneRendered(scene(true), 3, true);
      await vi.advanceTimersByTimeAsync(300);
      return rig;
    };

    await open([edge(7)]);
    expect(server.bodies('api/feature-ghost').at(-1)).toMatchObject({
      first: [{ kind: 'edge', shapeId: 'block-solid', index: 7 }],
      second: [{ kind: 'face', shapeId: 'block-solid', index: 1 }],
    });
    const asked = server.count('api/feature-ghost');
    await open([face(7)]);
    expect(server.count('api/feature-ghost')).toBe(asked);
  });

  it('edits only the re-picked rows, with the boundary only when an edge or a face is named, by a row or by the tool', async () => {
    const TARGET: FeatureEditTarget = at(8);
    const PARSED = {
      feature: 'intersection-curve', firstTexts: ['sk'], firstRefs: [{ line: 2, column: 0 }], secondTexts: ['p'],
      secondRefs: [null], firstArg: 'sk', secondArg: 'p',
    } as ParsedFeatureOf<'intersection-curve'>;
    const INFO = { index: 4, type: 'intersection-curve', expectedStatement: 'fixture(sk, p)' };
    const BOUNDARY = { index: 4, type: 'intersection-curve', line: 8, column: 0 };
    server.routes.set('api/feature/sources', () => ({
      ok: true, feature: 'intersection-curve', first: [{ kind: 'sketch', ...at(2) }], second: [{ kind: 'opaque' }],
    }));
    const open = async () => {
      const rig = mount();
      rig.service.enterEdit(TARGET, PARSED, INFO);
      await vi.advanceTimersByTimeAsync(0);
      rig.service.handleSceneRendered(scene(true), 3, true);
      await vi.advanceTimersByTimeAsync(300);
      return rig;
    };
    const lastEdit = (rig: ReturnType<typeof mount>) => applied(rig.service).at(-1);

    const untouched = await open();
    untouched.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastEdit(untouched)).toEqual({ kind: 'edit', request: { expectedStatement: INFO.expectedStatement } });

    const surface = await open();
    surface.armRow('second');
    surface.service.handleTimelinePick(rowOf('wing'));
    surface.dialog.option = 'changed';
    surface.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastEdit(surface)).toEqual({
      kind: 'edit',
      request: { second: [{ kind: 'statement', ...at(6) }], option: 'changed', expectedStatement: INFO.expectedStatement },
    });

    const picked = await open();
    picked.armRow('second');
    picked.click(face(3));
    picked.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastEdit(picked)).toEqual({
      kind: 'edit',
      request: { second: [{ kind: 'face', shapeId: 'block-solid', index: 3 }], expectedStatement: INFO.expectedStatement, before: BOUNDARY },
    });

    const own = await open();
    own.service.ownEntityPick = true;
    own.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastEdit(own)).toEqual({ kind: 'edit', request: { expectedStatement: INFO.expectedStatement, before: BOUNDARY } });
  });
});

describe('RecentClicks — a double-click read back from its two clicks', () => {
  const pick = (entity: SelectedEntity): ClickedPick => entity;
  const SKETCH_WIRE: ClickedPick = { shapeId: 'ring-wire', sub: { type: 'sketch', index: 0 } as NonNullable<SubSelection> };

  it('takes the second click for an echo of the first on the same pick when both rows pick alike', () => {
    const clicks = new RecentClicks<'a' | 'b'>();
    clicks.remember('a', pick(face(1)), true, true);
    clicks.remember('b', pick(face(1)), true, false);
    expect(clicks.gestureStart('b', pick(face(1)))).toEqual({
      repaired: true, row: 'a', seed: face(1), takeBack: { row: 'b', pick: face(1) },
    });

    // Two different faces: the pointer moved, and the gesture is the armed row's.
    clicks.remember('a', pick(face(1)), true, true);
    clicks.remember('b', pick(face(2)), true, false);
    expect(clicks.gestureStart('b', pick(face(2)))).toEqual({ repaired: false, row: 'b', seed: face(2) });
  });

  it('takes the face behind an edge or a sketch\'s wire for the echo when the rows pick differently, growing from the first', () => {
    const clicks = new RecentClicks<'a' | 'b'>();
    clicks.remember('a', pick(edge(1)), true, true);
    clicks.remember('b', pick(face(4)), true, false);
    expect(clicks.gestureStart('b', pick(face(4)))).toEqual({
      repaired: true, row: 'a', seed: edge(1), takeBack: { row: 'b', pick: face(4) },
    });

    // A second click the next row did not take has nothing to take back.
    clicks.remember('a', SKETCH_WIRE, true, true);
    clicks.remember('b', pick(face(4)), false, false);
    expect(clicks.gestureStart('b', pick(face(4)))).toEqual({ repaired: true, row: 'a', seed: SKETCH_WIRE, takeBack: null });
  });

  it('reads nothing without a hand-on, within one row, at another pick, or once read or forgotten', () => {
    const clicks = new RecentClicks<'a' | 'b'>();
    const armed = (entity: SelectedEntity) => ({ repaired: false, row: 'b', seed: entity });
    clicks.remember('a', pick(edge(1)), true, false);
    clicks.remember('b', pick(face(4)), true, false);
    expect(clicks.gestureStart('b', pick(face(4)))).toEqual(armed(face(4)));

    clicks.remember('b', pick(face(4)), true, true);
    clicks.remember('b', pick(face(4)), true, false);
    expect(clicks.gestureStart('b', pick(face(4)))).toEqual(armed(face(4)));

    clicks.remember('a', pick(edge(1)), true, true);
    clicks.remember('b', pick(face(4)), true, false);
    expect(clicks.gestureStart('b', pick(face(5)))).toEqual(armed(face(5)));
    expect(clicks.gestureStart('b', pick(face(4)))).toEqual(armed(face(4)));

    clicks.remember('a', pick(edge(1)), true, true);
    clicks.remember('b', pick(face(4)), true, false);
    clicks.forget();
    expect(clicks.gestureStart('b', pick(face(4)))).toEqual(armed(face(4)));
  });
});
