// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The assembly Copy dialog (connector copies stage 3): `copy()` of the
// assembly's own connectors. It opens on a connector (a Connectors row's
// "Copy…") or on a copy statement, picks assembly connectors — gizmos or
// rail rows — as targets and axes through the mate dialog's pick channel,
// refuses an inserted part's connector, a copy and an already-copied
// connector at the pick (a copy's rail row is a no-op instead, the rail
// having sat it out), takes a world axis from the shown axes, ghosts the
// copies as triads, and applies through /api/assembly-connector-copy.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  parseFeatureAt: vi.fn(async () => ({ ok: false, reason: 'unset' })),
  fetchFeatureGhostResult: vi.fn(async () => ({ solids: [], frames: [], notice: null })),
  applyAssemblyConnectorCopy: vi.fn(async () => ({ success: true, preview: 'copy(…)' })),
}));

import { Group, PerspectiveCamera, Scene } from 'three';
import * as api from '../src/api';
import { AssemblyConnectorCopyService } from '../src/interactive/assembly-connector-copy/copy-service';
import { WORLD_BODY_ID } from '../src/solver';
import type { SerializedAssembly, SerializedAssemblyConnector } from '../src/types';
import type { Viewer } from '../src/viewer';

beforeEach(() => {
  vi.useFakeTimers();
});

/** Every dialog a test opened — closed after it, so none stays on the shared Escape stack. */
const services: AssemblyConnectorCopyService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) {
    service.exit();
  }
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/rack.assembly.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });

const FRAME = {
  origin: { x: 0, y: 0, z: 20 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

/**
 * A rack: `bay` (line 4), `pivot` (line 5) and `lug` (line 6), and a
 * `copy()` on line 8 that made `lug.instance(1)`. `suffix` re-mints every
 * id, as a render does.
 */
function rack(suffix = ''): SerializedAssembly {
  const connector = (name: string, line: number, extra: Partial<SerializedAssemblyConnector> = {}): SerializedAssemblyConnector => ({
    connectorId: `${name}${suffix}`, name, owner: '', ...FRAME, sourceLocation: at(line, 12), ...extra,
  });
  return {
    instances: [{
      instanceId: 'inst-0', partId: 'p-card', partName: 'Card', name: 'Card',
      position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, grounded: false, owner: '',
      sourceLocation: at(3),
    }],
    mates: [],
    occurrences: [],
    connectors: [
      connector('bay', 4),
      connector('pivot', 5, { origin: { x: 100, y: 0, z: 0 } }),
      connector('lug', 6),
      {
        ...connector('lug', 8, { origin: { x: 40, y: 0, z: 20 } }),
        connectorId: `lug-1${suffix}`,
        sourceLocation: at(8),
        copy: { slot: 1, seedId: `lug${suffix}` },
      },
    ],
  };
}

/** A viewer recording what the dialog asks of it and of the assembly controller. */
function stubViewer() {
  const scene = new Scene();
  const state = {
    matePicking: null as { armed: boolean; revealAll: boolean } | null,
    picked: [] as { instanceId: string; connectorId: string }[],
    axesShown: false,
    selectedAxes: [] as string[],
    onAxisPick: null as ((axis: 'x' | 'y' | 'z') => void) | null,
  };
  const controller = {
    setMatePicking: (armed: boolean, revealAll = true) => {
      state.matePicking = { armed, revealAll };
    },
    setMatePickedConnectors: (slots: { instanceId: string; connectorId: string }[]) => {
      state.picked = [...slots];
    },
    setHighlightedConnector: () => {},
    getConnectorRef: () => ({ name: 'edge' }),
  };
  const viewer = {
    pickConnectors: false,
    sceneContext: { scene, camera: new PerspectiveCamera(), requestRender: () => {} },
    getAssemblyController: () => controller,
    showStandardAxes: (onPick: (axis: 'x' | 'y' | 'z') => void) => {
      state.axesShown = true;
      state.onAxisPick = onPick;
    },
    hideStandardAxes: () => {
      state.axesShown = false;
      state.onAxisPick = null;
    },
    setSelectedStandardAxes: (axes: string[]) => {
      state.selectedAxes = [...axes];
    },
  };
  return { viewer: viewer as unknown as Viewer, state, scene };
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state, scene } = stubViewer();
  let assembly = rack();
  const events: string[] = [];
  const service = new AssemblyConnectorCopyService(container, viewer, {
    getAssembly: () => assembly,
    getCurrentFile: () => FILE,
    onEnter: () => events.push('enter'),
    onExit: () => events.push('exit'),
    onPickingChange: (picking) => events.push(`picking ${picking}`),
  });
  services.push(service);
  const text = (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)?.textContent ?? '';
  const chips = (role: string) => [...container.querySelectorAll<HTMLElement>(`[data-role="${role}"] span.truncate[title]`)]
    .map(el => el.getAttribute('title'));
  const setKind = (kind: 'linear' | 'circular') => {
    const select = container.querySelector<HTMLSelectElement>('[data-role="kind"]')!;
    select.value = kind;
    select.dispatchEvent(new Event('change'));
  };
  const armAxis = () => container.querySelector<HTMLElement>('[data-role="axis-slot-1"]')!.click();
  const setCount = (value: string) => {
    const input = container.querySelector<HTMLInputElement>('[data-role="count"]')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const ghostGroup = () => scene.getObjectByName('featureGhost') as Group;
  const rerender = (next: SerializedAssembly) => {
    assembly = next;
    service.handleSceneRendered('assembly');
  };
  const gizmo = (connectorId: string) => service.handleClick(connectorId, { type: 'connector', index: 0 }, WORLD_BODY_ID);
  const apply = async () => {
    container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.runAllTimersAsync();
    return vi.mocked(api.applyAssemblyConnectorCopy).mock.calls.find(([, , opts]) => !opts?.preview);
  };
  return { service, container, state, events, text, chips, setKind, armAxis, setCount, ghostGroup, rerender, gizmo, apply };
}

describe('assembly Copy dialog', () => {
  it('opens on a connector, picking through the mate channel, and drops it all on exit', () => {
    const { service, state, events, chips } = mount();
    service.enterWithConnector('bay');

    expect(service.isActive).toBe(true);
    // The rail learns what its rows pick into: the targets, on open.
    expect(events).toEqual(['enter', 'picking targets']);
    expect(chips('targets-slot')).toEqual(['Connector bay']);
    // Assembly connectors all show; an inserted part's only on hover.
    expect(state.matePicking).toEqual({ armed: true, revealAll: false });
    expect(state.picked).toEqual([{ instanceId: WORLD_BODY_ID, connectorId: 'bay' }]);

    service.exit();
    expect(events).toEqual(['enter', 'picking targets', 'exit']);
    expect(state.matePicking).toEqual({ armed: false, revealAll: false });
    expect(state.picked).toEqual([]);
  });

  it('toggles assembly connectors in the targets, by gizmo or rail row', () => {
    const { service, chips, gizmo } = mount();
    service.enterWithConnector('bay');
    gizmo('pivot');
    service.pickWorldConnector('bay');
    expect(chips('targets-slot')).toEqual(['Connector pivot']);
  });

  it("refuses an inserted part's connector, a copy, and a connector another copy() copies", () => {
    const { service, text, chips, gizmo } = mount();
    service.enterWithConnector('bay');

    service.handleClick('edge', { type: 'connector', index: 0 }, 'inst-0');
    expect(text('message')).toBe("An inserted part's connectors are copied in its own part file — here, pick the assembly's own connectors.");

    gizmo('lug-1');
    expect(text('message')).toContain('lug.instance(1) is itself a copy — copy lug instead');

    service.pickWorldConnector('lug');
    expect(text('message')).toBe(
      'lug is already copied by the copy on line 8 — one copy statement per connector: edit that one instead.',
    );
    service.handleClick('face-1', { type: 'face', index: 0 }, 'inst-0');
    expect(text('message')).toMatch(/copies its own connectors/);
    expect(chips('targets-slot')).toEqual(['Connector bay']);
  });

  it("a copy's rail row is a no-op while the targets are armed — no chip, no message", () => {
    const { service, text, chips, events } = mount();
    service.enterWithConnector('bay');
    service.pickWorldConnector('lug-1');
    expect(chips('targets-slot')).toEqual(['Connector bay']);
    expect(text('message')).toBe('');
    // The rail was told the targets are picking, so it sat the copy rows out itself.
    expect(events.at(-1)).toBe('picking targets');
  });

  it('takes a world axis from the axes shown while an axis slot is armed, or a connector — a copy too', () => {
    const { service, state, chips, setKind, armAxis, gizmo, text, events } = mount();
    service.enterWithConnector('bay');
    expect(state.axesShown).toBe(false);
    armAxis();
    expect(state.axesShown).toBe(true);
    // The rail follows the armed slot: copy rows pick again as an axis.
    expect(events.at(-1)).toBe('picking axis');
    service.pickWorldConnector('lug-1');
    expect(text('axis-slot-1')).toContain('lug.instance(1)');

    state.onAxisPick!('y');
    expect(text('axis-slot-1')).toContain('World Y axis');
    expect(state.selectedAxes).toEqual(['y']);

    setKind('circular');
    gizmo('pivot');
    expect(chips('axis-slot-1')).toEqual(['Connector pivot']);
    gizmo('lug-1');
    expect(text('axis-slot-1')).toContain('lug.instance(1)');
    // An inserted part's connector is no axis: its pose is the solver's.
    service.handleClick('edge', { type: 'connector', index: 0 }, 'inst-0');
    expect(text('message')).toMatch(/can't be the copy axis/);
    // The picks stayed out of the targets.
    expect(chips('targets-slot')).toEqual(['Connector bay']);
  });

  it('previews through the route and applies the create with connector refs', async () => {
    const { service, setKind, armAxis, gizmo, apply, text } = mount();
    service.enterWithConnector('bay');
    setKind('circular');
    armAxis();
    gizmo('lug-1');
    await vi.advanceTimersByTimeAsync(300);

    const preview = vi.mocked(api.applyAssemblyConnectorCopy).mock.calls.at(-1)!;
    expect(preview[0]).toBe(FILE);
    expect(preview[2]).toMatchObject({ preview: true });
    expect(text('preview')).toBe('copy(…)');

    const applied = (await apply())!;
    expect(applied[1]).toEqual({
      create: {
        kind: 'circular',
        targets: [{ kind: 'connector', connectorLine: 4, connectorName: 'bay' }],
        axis: { kind: 'connector', connectorLine: 6, connectorName: 'lug', slot: 1 },
        count: 3,
        sweep: { mode: 'angle', value: 360 },
      },
    });
    expect(service.isActive).toBe(false);
  });

  it('applies a linear copy along a world axis', async () => {
    const { service, armAxis, state, setCount, apply } = mount();
    service.enterWithConnector('bay');
    armAxis();
    state.onAxisPick!('x');
    setCount('4');

    const applied = (await apply())!;
    expect(applied[1]).toEqual({
      create: {
        kind: 'linear',
        targets: [{ kind: 'connector', connectorLine: 4, connectorName: 'bay' }],
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 4, value: 20 }],
        spacingMode: 'offset',
      },
    });
  });

  it('ghosts the copies as triads, asking with the connectors\' statements', async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [], frames: [FRAME, FRAME, FRAME], notice: null });
    const { service, armAxis, state, ghostGroup } = mount();
    service.enterWithConnector('bay');
    armAxis();
    state.onAxisPick!('x');
    await vi.advanceTimersByTimeAsync(300);

    const [request, scope] = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)!;
    expect(request).toMatchObject({
      feature: 'copy', kind: 'linear',
      targets: [{ filePath: FILE, line: 4 }],
      axes: [{ kind: 'standard', axis: 'x' }],
      directions: [{ count: 3, offset: 20, length: null }],
    });
    expect(scope).toBeNull();
    expect(ghostGroup().children).toHaveLength(3);
    service.exit();
    expect(ghostGroup().children).toHaveLength(0);
  });

  it('re-finds its picks after a render re-mints the ids, and closes on a part scene', () => {
    const { service, chips, state, setKind, armAxis, gizmo, rerender } = mount();
    service.enterWithConnector('bay');
    setKind('circular');
    armAxis();
    gizmo('pivot');

    rerender(rack('-r2'));
    expect(chips('targets-slot')).toEqual(['Connector bay']);
    expect(chips('axis-slot-1')).toEqual(['Connector pivot']);
    expect(state.picked.map(p => p.connectorId)).toEqual(['bay-r2', 'pivot-r2']);

    service.handleSceneRendered('part');
    expect(service.isActive).toBe(false);
  });

  it('edits a copy statement: its connectors as chips, its axis kept, its own seed not refused', async () => {
    vi.mocked(api.parseFeatureAt).mockResolvedValue({
      ok: true,
      statement: `copy('circular', pivot, { count: 4, angle: 360 }, lug)`,
      parsed: {
        feature: 'copy', kind: 'circular', axisTexts: ['pivot'], axisRefs: [{ line: 5, column: 14 }],
        directions: null, spacingMode: null, centered: false, count: 4, sweep: { mode: 'angle', value: 360 },
        center: null, skip: null, targetTexts: ['lug'], targetRefs: [{ line: 6, column: 12 }],
      },
    });
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [], frames: [FRAME], notice: null });
    const { service, container, chips, text, setCount, apply } = mount();

    expect(await service.enterEdit(at(8))).toBeNull();
    expect(container.textContent).toContain('Edit copy');
    expect(chips('targets-slot')).toEqual(['Connector lug']);
    expect(text('axis-slot-1')).toContain('Current: pivot');

    // lug is copied by the very statement being edited: toggling it is fine.
    service.pickWorldConnector('lug');
    service.pickWorldConnector('lug');
    expect(text('message')).toBe('');
    expect(chips('targets-slot')).toEqual(['Connector lug']);

    await vi.advanceTimersByTimeAsync(300);
    const [request, scope] = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)!;
    expect(request).toMatchObject({ axes: [{ kind: 'connector', filePath: FILE, line: 5 }], targets: [{ filePath: FILE, line: 6 }] });
    expect(scope).toEqual({ kind: 'statement', ...at(8) });

    setCount('5');
    const applied = (await apply())!;
    expect(applied[1]).toEqual({
      edit: {
        sourceLine: 8,
        kind: 'circular',
        targets: [{ kind: 'connector', connectorLine: 6, connectorName: 'lug' }],
        axis: { kind: 'keep', sourceIndex: 0 },
        count: 5,
        sweep: { mode: 'angle', value: 360 },
      },
    });
  });

  it('answers why a statement cannot be edited, staying closed', async () => {
    vi.mocked(api.parseFeatureAt).mockResolvedValue({ ok: false, reason: 'no call found at line 9' });
    const { service } = mount();
    expect(await service.enterEdit(at(9))).toBe('no call found at line 9');
    expect(service.isActive).toBe(false);
  });
});
