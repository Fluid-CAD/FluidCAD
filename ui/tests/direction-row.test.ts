// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorPicks } from '../src/interactive/create-feature/connector-picks';
import { DirectionRow } from '../src/interactive/create-feature/direction-row';
import { DirectionSlotControl } from '../src/interactive/create-feature/direction-slot';
import type { PickOutcome } from '../src/interactive/create-feature/schema/schema-pickers';
import type { SceneObjectRender } from '../src/types';
import type { Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// The Direction row an operand-row dialog opts into beside its operand rows
// (Project's; ruled's Direction type next): the direction slot, with what
// the service does for it — the world axes and origin planes shown while it
// is armed, the plane quads and connector gizmos it takes, the option that
// hides it — and the direction as the create, edit and preview requests
// carry it. The network is stubbed (the slot asks for variable names).

beforeEach(() => {
  new FakeSelectionServer().install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const FILE = '/ws/m.part.js';
const at = (line: number, column = 2) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];
const FRAME = {
  origin: { x: 30, y: 0, z: 10 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

/** A block, an axis and a plane statement, and a connector. */
function scene(): SceneObjectRender[] {
  return [
    {
      id: 'block', type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: 'block-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'ax', type: 'axis', name: 'Axis 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'axis-line', shapeType: 'edge', isMetaShape: true, meshes: MESH }],
    },
    {
      id: 'pl', type: 'plane', name: 'Plane 1', ownShapes: [], sourceLocation: at(7),
      sceneShapes: [{ shapeId: 'plane-quad', shapeType: 'face', isMetaShape: true, meshes: MESH }],
    },
    {
      id: 'bolt', type: 'connector', name: 'bolt', sceneShapes: [], ownShapes: [], sourceLocation: at(8),
      object: { name: 'bolt', ...FRAME },
    },
  ];
}

/** A viewer that records what the row shows and marks; every other call is a no-op. */
function stubViewer() {
  const state = {
    axes: false,
    planes: false,
    onPick: null as null | ((name: string) => void),
    selectedAxes: [] as readonly string[],
    pickedConnectors: [] as readonly string[],
    connectorPicking: true,
  };
  const base: Record<string, unknown> = {
    pickPlanes: true,
    showStandardAxes: (onPick: (name: string) => void) => {
      state.axes = true;
      state.onPick = onPick;
    },
    hideStandardAxes: () => {
      state.axes = false;
    },
    showStandardPlanes: (onPick: (name: string) => void) => {
      state.planes = true;
      state.onPick = onPick;
    },
    hideStandardPlanes: () => {
      state.planes = false;
    },
    setSelectedStandardAxes: (axes: readonly string[]) => {
      state.selectedAxes = axes;
    },
    setPickedConnectors: (ids: readonly string[]) => {
      state.pickedConnectors = ids;
    },
    setConnectorPicking: (armed: boolean) => {
      state.connectorPicking = armed;
    },
  };
  const viewer = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Viewer;
  return { viewer, state, fields: base };
}

function mount() {
  const container = document.createElement('div');
  const host = document.createElement('div');
  container.appendChild(host);
  document.body.appendChild(container);
  const control = new DirectionSlotControl(host, { optional: true, classify: async () => 'straight' });
  const { viewer, state, fields } = stubViewer();
  const visible = { shown: true };
  const row = new DirectionRow(control, container, viewer, () => visible.shown);
  row.setScene(scene(), { dropEntities: true });
  const picks: PickOutcome[] = [];
  row.onPick = outcome => picks.push(outcome);
  const remove = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '✕')!.click();
  return { container, host, control, row, state, fields, visible, picks, remove };
}

describe('DirectionRow', () => {
  it('leaves a hidden row out of every request and lights nothing for it, keeping its pick for when it shows again', () => {
    const { row, control, state, visible } = mount();
    control.takeStandard('z');
    expect(row.createValue()).toEqual({ kind: 'standard', axis: 'z' });
    expect(row.ghost()).toEqual({ kind: 'standard', axis: 'z' });
    row.paint();
    expect(state.selectedAxes).toEqual(['z']);

    visible.shown = false;
    expect(row.createValue()).toBeNull();
    expect(row.ghost()).toBeNull();
    expect(row.editValue(null)).toBeUndefined();
    expect(row.editValue("'z'")).toEqual({ kind: 'cleared' });
    expect(row.paint()).toEqual({ entities: [], wireIds: [], planeQuadIds: [] });
    expect(state.selectedAxes).toEqual([]);

    visible.shown = true;
    expect(row.createValue()).toEqual({ kind: 'standard', axis: 'z' });
  });

  it('reads an edit\'s direction against the statement\'s own: kept, written as the axis picked, cleared, or the new one', () => {
    const { row, control, remove } = mount();
    // A literal reads back as its axis: picking nothing else keeps it as written.
    row.seedKeep("'z'");
    expect(row.editValue("'z'")).toBeUndefined();

    // Anything else stays kept until the engine says what it stands for.
    row.seedKeep('datum');
    expect(row.createValue()).toBeNull();
    expect(row.editValue('datum')).toBeUndefined();
    expect(row.ghost()).toBeUndefined();
    row.setKeptSource({ kind: 'sketch', ...at(7) });
    expect(row.ghost()).toEqual({ kind: 'plane', filePath: FILE, line: 7 });

    control.takeStandard('y');
    expect(row.editValue('datum')).toEqual({ kind: 'standard', axis: 'y' });

    // The re-pick's ✕ goes back to the statement's own; that one's ✕ clears it.
    remove();
    expect(row.editValue('datum')).toBeUndefined();
    remove();
    expect(row.editValue('datum')).toEqual({ kind: 'cleared' });
    expect(row.editValue(null)).toBeUndefined();
  });

  it('says which edit directions need the session boundary: a picked edge or face', async () => {
    const { row, control } = mount();
    await control.takeClick('block-solid', { type: 'edge', index: 2 });
    const picked = row.editValue(null);
    expect(picked).toEqual({ kind: 'edge', entity: { shapeId: 'block-solid', sub: { type: 'edge', index: 2 } } });
    expect(DirectionRow.picksEntity(picked)).toBe(true);
    expect(DirectionRow.picksEntity({ kind: 'standard', axis: 'x' })).toBe(false);
    expect(DirectionRow.picksEntity({ kind: 'cleared' })).toBe(false);
    expect(DirectionRow.picksEntity(undefined)).toBe(false);
  });

  it('shows the world axes and origin planes only while armed, and lands their picks only then', () => {
    const { row, control, state, fields, picks } = mount();
    row.aim(true);
    expect(state).toMatchObject({ axes: true, planes: true });
    const pickStandard = state.onPick!;
    pickStandard('x');
    expect(picks).toEqual(['taken']);
    expect(control.value()).toEqual({ kind: 'standard', axis: 'x' });

    row.aim(false);
    expect(state).toMatchObject({ axes: false, planes: false });
    pickStandard('y');
    expect(picks).toEqual(['taken']);

    row.aim(true);
    row.release();
    expect(state).toMatchObject({ axes: false, planes: false, connectorPicking: false, pickedConnectors: [], selectedAxes: [] });
    expect(fields.pickPlanes).toBe(false);
    pickStandard('z');
    expect(picks).toEqual(['taken']);
  });

  it('lands a plane quad, a connector gizmo and a timeline row it takes, and refuses a gizmo no statement names', () => {
    const { row, control, picks } = mount();
    row.pickPlaneQuad('plane-quad');
    expect(control.value()).toEqual({ kind: 'plane', ...at(7) });
    row.pickConnector('bolt', undefined);
    expect(control.value()).toMatchObject({ kind: 'connector', ...at(8) });
    row.pickConnector('nothing', undefined);
    expect(picks).toEqual(['taken', 'taken', { message: ConnectorPicks.UNREFERENCEABLE }]);

    expect(row.takeRow(scene()[1])).toBe('taken');
    expect(control.value()).toEqual({ kind: 'axis', ...at(6) });
    expect(row.takeRow(scene()[0])).toBe('ignored');
    expect(row.rowRefusal).toBe('gives no direction — pick an axis, a plane or a connector row, or an edge or a face in the viewport.');
  });
});
