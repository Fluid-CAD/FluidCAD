// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssemblyReplicateService } from '../src/interactive/assembly-replicate/replicate-service';
import { buildProvisionalSpec, outerTargets, seedHasMates } from '../src/interactive/assembly-replicate/replicate-columns';
import {
  renderPartsPath,
  resolveConnectorPick,
  resolveSideChain,
} from '../src/interactive/assembly-mate/side-resolve';
import { provisionalReplicaId } from '../src/scene/provisional-replicas';
import { WORLD_BODY_ID } from '../src/solver';
import type { Viewer } from '../src/viewer';
import type {
  SerializedAssembly,
  SerializedAssemblyInstance,
  SerializedAssemblyMate,
  SerializedAssemblyOccurrence,
  SerializedAssemblyReplicate,
} from '../src/types';

// The replicate dialog on the engine's shape: a crank shaft with pin
// connectors, a piston sub-assembly mated by a slider (to an assembly
// connector, the bore) and a revolute (to a crank pin). Columns come from
// the seed's outer mate sides; picks fill cells left to right and auto-add
// rows; the preview spec re-targets the seed's mates onto ghost bodies;
// Apply posts the writer's refs; edit seeds from the payload record; replica
// records address themselves by replicate line + row.

const FILE = '/engine/main.assembly.js';
const SUB_FILE = '/engine/piston.assembly.js';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function instance(
  id: string,
  partId: string,
  name: string,
  line: number,
  extra: Partial<SerializedAssemblyInstance> = {},
): SerializedAssemblyInstance {
  return {
    instanceId: id,
    partId,
    partName: name,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    owner: '',
    name,
    sourceLocation: { filePath: FILE, line, column: 0 },
    ...extra,
  };
}

function occurrence(id: string, name: string, line: number, extra: Partial<SerializedAssemblyOccurrence> = {}): SerializedAssemblyOccurrence {
  return {
    occurrenceId: id,
    assemblyName: name,
    name,
    parentPath: '',
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    groundConnected: false,
    exports: [
      { path: ['piston1'], instanceId: `${id}/inst-2` },
      { path: ['connectingRodCap1'], instanceId: `${id}/inst-1` },
      { path: ['connectingRod1'], instanceId: `${id}/inst-0` },
    ],
    sourceLocation: { filePath: FILE, line, column: 0 },
    ...extra,
  };
}

function mate(mateId: string, type: SerializedAssemblyMate['type'], sides: Partial<SerializedAssemblyMate>, owner = ''): SerializedAssemblyMate {
  return {
    mateId,
    owner,
    type,
    status: 'satisfied',
    sourceLocation: { filePath: owner ? SUB_FILE : FILE, line: 30, column: 0 },
    ...sides,
  };
}

/** Crank at root, one piston occurrence (rod, cap, piston), three bores. */
function engine(): SerializedAssembly {
  return {
    instances: [
      instance('inst-0', 'p-crank', 'Crank Shaft', 5, { grounded: true }),
      instance('asm-0/inst-0', 'p-rod', 'Connecting Rod', 3, { owner: 'asm-0', sourceLocation: { filePath: SUB_FILE, line: 3, column: 0 } }),
      instance('asm-0/inst-1', 'p-cap', 'Connecting Rod Cap', 4, { owner: 'asm-0', sourceLocation: { filePath: SUB_FILE, line: 4, column: 0 } }),
      instance('asm-0/inst-2', 'p-piston', 'Piston', 5, { owner: 'asm-0', sourceLocation: { filePath: SUB_FILE, line: 5, column: 0 } }),
    ],
    occurrences: [occurrence('asm-0', 'Piston Assembly', 10)],
    connectors: [
      { connectorId: 'w-bore1', name: 'bore1', owner: '', origin: { x: 0, y: 159, z: 157 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, sourceLocation: { filePath: FILE, line: 7, column: 0 } },
      { connectorId: 'w-bore2', name: 'bore2', owner: '', origin: { x: 0, y: 273, z: 157 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, sourceLocation: { filePath: FILE, line: 8, column: 0 } },
      { connectorId: 'w-bore3', name: 'bore3', owner: '', origin: { x: 0, y: 387, z: 157 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, sourceLocation: { filePath: FILE, line: 9, column: 0 } },
    ],
    mates: [
      mate('mate-0', 'revolute', { connectorA: { instanceId: 'inst-0', connectorId: 'c-crank-c1' }, frameB: { connectorId: 'w-origin' } }),
      mate('asm-0/mate-0', 'fastened', { connectorA: { instanceId: 'asm-0/inst-1', connectorId: 'c-cap-c1' }, connectorB: { instanceId: 'asm-0/inst-0', connectorId: 'c-rod-c1' } }, 'asm-0'),
      mate('mate-1', 'slider', { frameA: { connectorId: 'w-bore1' }, connectorB: { instanceId: 'asm-0/inst-2', connectorId: 'c-piston-c2' } }),
      mate('mate-2', 'revolute', { connectorA: { instanceId: 'asm-0/inst-1', connectorId: 'c-cap-c2' }, connectorB: { instanceId: 'inst-0', connectorId: 'c-crank-c2' } }),
    ],
    replicates: [],
  };
}

const CONNECTOR_NAMES: Record<string, string> = {
  'c-crank-c1': 'c1', 'c-crank-c2': 'c2', 'c-crank-c3': 'c3', 'c-crank-c4': 'c4', 'c-crank-c5': 'c5',
  'c-piston-c2': 'c2', 'c-cap-c1': 'c1', 'c-cap-c2': 'c2', 'c-rod-c1': 'c1',
};

function fakeController() {
  const calls = {
    provisional: [] as unknown[],
    picked: [] as unknown[],
    matePicking: [] as [boolean, boolean][],
    committed: 0,
  };
  const controller = {
    getConnectorName: (id: string) => CONNECTOR_NAMES[id] ?? null,
    findConnectorId: (instanceId: string, name: string) => {
      const prefix = instanceId === 'inst-0' ? 'c-crank-' : instanceId.endsWith('inst-2') ? 'c-piston-' : instanceId.endsWith('inst-1') ? 'c-cap-' : 'c-rod-';
      const id = `${prefix}${name}`;
      return CONNECTOR_NAMES[id] ? id : null;
    },
    getContactState: () => null,
    listInstanceConnectors: (instanceId: string) => instanceId === 'inst-0'
      ? ['c1', 'c2', 'c3', 'c4', 'c5'].map(n => ({ connectorId: `c-crank-${n}`, name: n }))
      : [],
    setMatePicking: (armed: boolean, revealAll: boolean) => { calls.matePicking.push([armed, revealAll]); },
    setMatePickedConnectors: (slots: Iterable<unknown>) => { calls.picked.push([...slots]); },
    setProvisionalReplicas: (spec: unknown) => { calls.provisional.push(spec); },
    commitProvisionalReplicas: () => { calls.committed += 1; },
    setHighlightedConnector: () => {},
  };
  return { controller, calls };
}

function mount(assembly: SerializedAssembly = engine()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { controller, calls } = fakeController();
  const viewer = { pickConnectors: false, getAssemblyController: () => controller } as unknown as Viewer;
  const service = new AssemblyReplicateService(container, viewer, { getAssembly: () => assembly });
  const pick = (connectorId: string, instanceId: string | null) =>
    service.handleClick(connectorId, { type: 'connector', index: 0 }, instanceId);
  const q = <T extends HTMLElement>(sel: string) => container.querySelector<T>(sel);
  const qa = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const lastProvisional = () => calls.provisional[calls.provisional.length - 1] as { rows: { clones: { sourceInstanceId: string; provisionalId: string }[]; mates: any[] }[] } | null;
  return { container, service, calls, viewer, pick, q, qa, lastProvisional, assembly };
}

describe('replicate columns (pure)', () => {
  it('lists the seed\'s outer sides in mate order, deduplicated', () => {
    const targets = outerTargets(engine(), { kind: 'occurrence', id: 'asm-0' });
    expect(targets.map(t => t.side)).toEqual([
      { kind: 'frame', connectorId: 'w-bore1' },
      { kind: 'connector', instanceId: 'inst-0', connectorId: 'c-crank-c2' },
    ]);
    expect(targets.map(t => t.mateType)).toEqual(['slider', 'revolute']);
  });

  it('knows which records have mates to replicate', () => {
    expect(seedHasMates(engine(), { kind: 'occurrence', id: 'asm-0' })).toBe(true);
    expect(seedHasMates(engine(), { kind: 'instance', id: 'inst-0' })).toBe(true);
    const lonely = engine();
    lonely.instances.push(instance('inst-9', 'p-bolt', 'Bolt', 40));
    expect(seedHasMates(lonely, { kind: 'instance', id: 'inst-9' })).toBe(false);
  });

  it('builds provisional rows: ghosts per seed instance, internal mates cloned, outer mates re-targeted', () => {
    const spec = buildProvisionalSpec(
      engine(),
      { kind: 'occurrence', id: 'asm-0' },
      [
        { side: { kind: 'frame', connectorId: 'w-bore1' }, on: true },
        { side: { kind: 'connector', instanceId: 'inst-0', connectorId: 'c-crank-c2' }, on: true },
      ],
      [
        [{ kind: 'frame', connectorId: 'w-bore2' }, { kind: 'connector', instanceId: 'inst-0', connectorId: 'c-crank-c3' }],
        [{ kind: 'frame', connectorId: 'w-bore3' }, null],
      ],
    );
    // The second row is incomplete and is skipped.
    expect(spec.rows).toHaveLength(1);
    const row = spec.rows[0];
    expect(row.clones.map(c => c.sourceInstanceId)).toEqual(['asm-0/inst-0', 'asm-0/inst-1', 'asm-0/inst-2']);
    const piston = provisionalReplicaId(0, 'asm-0/inst-2');
    const cap = provisionalReplicaId(0, 'asm-0/inst-1');
    const rod = provisionalReplicaId(0, 'asm-0/inst-0');
    expect(row.mates.map(m => m.type)).toEqual(['fastened', 'slider', 'revolute']);
    expect(row.mates[0].connectorA).toEqual({ instanceId: cap, connectorId: 'c-cap-c1' });
    expect(row.mates[0].connectorB).toEqual({ instanceId: rod, connectorId: 'c-rod-c1' });
    expect(row.mates[1].connectorA).toEqual({ instanceId: WORLD_BODY_ID, connectorId: 'w-bore2' });
    expect(row.mates[1].connectorB).toEqual({ instanceId: piston, connectorId: 'c-piston-c2' });
    expect(row.mates[2].connectorA).toEqual({ instanceId: cap, connectorId: 'c-cap-c2' });
    expect(row.mates[2].connectorB).toEqual({ instanceId: 'inst-0', connectorId: 'c-crank-c3' });
  });

  it('keeps an OFF column\'s target shared', () => {
    const spec = buildProvisionalSpec(
      engine(),
      { kind: 'occurrence', id: 'asm-0' },
      [
        { side: { kind: 'frame', connectorId: 'w-bore1' }, on: false },
        { side: { kind: 'connector', instanceId: 'inst-0', connectorId: 'c-crank-c2' }, on: true },
      ],
      [[null, { kind: 'connector', instanceId: 'inst-0', connectorId: 'c-crank-c3' }]],
    );
    expect(spec.rows[0].mates[1].connectorA).toEqual({ instanceId: WORLD_BODY_ID, connectorId: 'w-bore1' });
  });
});

describe('AssemblyReplicateService', () => {
  it('opens on a seed with its outer targets as ON columns and one armed row', () => {
    const { service, q, qa, calls, viewer } = mount();
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    expect(service.isPicking).toBe(true);
    expect(viewer.pickConnectors).toBe(true);
    expect(calls.matePicking.at(-1)).toEqual([true, true]);
    expect(q('[data-role="title"]')!.textContent).toBe('Replicate · Piston Assembly');
    const toggles = qa('[data-target-toggle]') as HTMLInputElement[];
    expect(toggles).toHaveLength(2);
    expect(toggles.every(t => t.checked)).toBe(true);
    expect(qa('[data-target]').map(l => l.textContent!.trim())).toEqual([
      'Slider · on bore1 (assembly)',
      'Revolute · on Crank Shaft · c2',
    ]);
    expect(qa('[data-replica-row]')).toHaveLength(1);
    expect(qa('[data-replica-cell]')).toHaveLength(2);
    expect(q<HTMLButtonElement>('[data-role="apply"]')!.disabled).toBe(true);
    expect(q('[data-role="hint"]')!.textContent).toBe(
      'Copy 2: click a connector on another part in the 3D view for its Slider mate.',
    );
    expect(qa('[data-replica-row] span').map(s => s.textContent).some(t => t === 'Piston Assembly (2)')).toBe(true);
  });

  it('refuses a seed without mates, inside a sub-assembly, or that is itself a replica', () => {
    const assembly = engine();
    assembly.instances.push(instance('inst-9', 'p-bolt', 'Bolt', 40));
    assembly.instances.push(instance('inst-3', 'p-crank', 'Crank Shaft (2)', 50, { replica: { of: 'inst-0', statement: 'rep-0', row: 0 } }));
    const { service, q } = mount(assembly);
    service.begin({ kind: 'instance', id: 'inst-9' });
    expect(q('[data-role="message"]')!.textContent).toContain('no mates to replicate');
    expect(q('[data-role="seed-prompt"]')!.classList.contains('hidden')).toBe(false);
    service.begin({ kind: 'instance', id: 'asm-0/inst-2' });
    expect(q('[data-role="message"]')!.textContent).toContain('inside a sub-assembly');
    service.begin({ kind: 'instance', id: 'inst-3' });
    expect(q('[data-role="message"]')!.textContent).toContain('itself a replica');
  });

  it('fills cells left to right, auto-adds the next row, previews and solves each complete row', () => {
    const { service, pick, q, qa, lastProvisional } = mount();
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    pick('w-bore2', WORLD_BODY_ID);
    expect(qa('[data-replica-row]')).toHaveLength(1);
    expect(lastProvisional()).toBeNull();
    pick('c-crank-c3', 'inst-0');
    // Row 2 complete → row 3 appended and armed.
    expect(qa('[data-replica-row]')).toHaveLength(2);
    expect(q('[data-role="preview"]')!.textContent).toBe(
      'replicate(Piston Assembly, [bore1, Crank Shaft.connectors.c2], [[bore2, Crank Shaft.connectors.c3]]);',
    );
    expect(q<HTMLButtonElement>('[data-role="apply"]')!.disabled).toBe(false);
    const spec = lastProvisional()!;
    expect(spec.rows).toHaveLength(1);
    expect(spec.rows[0].clones).toHaveLength(3);
    expect(spec.rows[0].mates.find(m => m.type === 'slider').connectorA).toEqual({ instanceId: WORLD_BODY_ID, connectorId: 'w-bore2' });
    // Second replica.
    pick('w-bore3', WORLD_BODY_ID);
    pick('c-crank-c4', 'inst-0');
    expect(qa('[data-replica-row]')).toHaveLength(3);
    expect(lastProvisional()!.rows).toHaveLength(2);
    // Empty trailing row is not a problem for the payload.
    const payload = service.buildPayload();
    expect(payload).toEqual({
      seed: { instanceLine: 10 },
      targets: [
        { connectorLine: 7, connectorName: 'bore1' },
        { instanceLine: 5, connectorName: 'c2' },
      ],
      rows: [
        [{ connectorLine: 8, connectorName: 'bore2' }, { instanceLine: 5, connectorName: 'c3' }],
        [{ connectorLine: 9, connectorName: 'bore3' }, { instanceLine: 5, connectorName: 'c4' }],
      ],
    });
  });

  it('refuses picks on the seed itself and the seed\'s own target', () => {
    const { service, pick, q, qa } = mount();
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    pick('c-crank-c2', 'inst-0'); // armed cell is the bore column: a connector still lands there
    expect(q('[data-role="message"]')!.textContent).toBe('Piston Assembly already uses Crank Shaft · c2. Pick a different connector for this copy.');
    pick('w-bore1', WORLD_BODY_ID);
    expect(q('[data-role="message"]')!.textContent).toBe('Piston Assembly already uses bore1 (assembly). Pick a different connector for this copy.');
    // Fill the bore cell, then try the piston's own connector on the crank column.
    pick('w-bore2', WORLD_BODY_ID);
    pick('c-piston-c2', 'asm-0/inst-2');
    expect(q('[data-role="message"]')!.textContent).toContain('is part of Piston Assembly');
    expect(qa('[data-replica-row]')).toHaveLength(1);
  });

  it('blocks Apply on a partially filled row and names the missing cell', () => {
    const { service, pick, q } = mount();
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    pick('w-bore2', WORLD_BODY_ID);
    pick('c-crank-c3', 'inst-0');
    pick('w-bore3', WORLD_BODY_ID);
    expect(q('[data-role="message"]')!.textContent).toBe('Copy 3 still needs a connector for its Revolute mate (Crank Shaft · c2).');
    expect(q<HTMLButtonElement>('[data-role="apply"]')!.disabled).toBe(true);
  });

  it('turning a target OFF keeps it shared: its cells clear and the payload shrinks', () => {
    const { service, pick, q, qa } = mount();
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    pick('w-bore2', WORLD_BODY_ID);
    pick('c-crank-c3', 'inst-0');
    const bore = qa('[data-target-toggle]')[0] as HTMLInputElement;
    bore.checked = false;
    bore.dispatchEvent(new Event('change'));
    expect(qa('[data-replica-cell]').length).toBe(2); // one ON column × two rows
    expect(service.buildPayload()).toEqual({
      seed: { instanceLine: 10 },
      targets: [{ instanceLine: 5, connectorName: 'c2' }],
      rows: [[{ instanceLine: 5, connectorName: 'c3' }]],
    });
    expect(q('[data-role="preview"]')!.textContent).toBe(
      'replicate(Piston Assembly, [Crank Shaft.connectors.c2], [[Crank Shaft.connectors.c3]]);',
    );
  });

  it('Apply posts create to /api/assembly-replicate, commits the preview and closes', async () => {
    const { service, pick, q, calls } = mount();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    pick('w-bore2', WORLD_BODY_ID);
    pick('c-crank-c3', 'inst-0');
    q<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.waitFor(() => expect(service.isActive).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/assembly-replicate');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      filePath: FILE,
      create: {
        seed: { instanceLine: 10 },
        targets: [{ connectorLine: 7, connectorName: 'bore1' }, { instanceLine: 5, connectorName: 'c2' }],
        rows: [[{ connectorLine: 8, connectorName: 'bore2' }, { instanceLine: 5, connectorName: 'c3' }]],
      },
    });
    expect(calls.committed).toBe(1);
    expect(calls.matePicking.at(-1)).toEqual([false, true]);
  });

  it('a refused apply keeps the dialog open with the reason', async () => {
    const { service, pick, q } = mount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, reason: 'no mate() references cyl1' }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    );
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    pick('w-bore2', WORLD_BODY_ID);
    pick('c-crank-c3', 'inst-0');
    q<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.waitFor(() => expect(q('[data-role="message"]')!.textContent).toContain('no mate() references cyl1'));
    expect(service.isActive).toBe(true);
  });

  it('edit mode seeds rows and ON flags from the payload record and posts edit', async () => {
    const assembly = engine();
    const record: SerializedAssemblyReplicate = {
      replicateId: 'rep-0',
      owner: '',
      seed: { occurrenceId: 'asm-0' },
      targets: [{ kind: 'connector', instanceId: 'inst-0', connectorId: 'c-crank-c2' }],
      rows: [[{ kind: 'connector', instanceId: 'inst-0', connectorId: 'c-crank-c3' }]],
      produced: [{ occurrenceId: 'asm-1' }],
      sourceLocation: { filePath: FILE, line: 33, column: 0 },
    };
    assembly.replicates = [record];
    const { service, q, qa } = mount(assembly);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    service.beginEdit(record);
    expect(q('[data-role="title"]')!.textContent).toBe('Edit replicate · Piston Assembly');
    const toggles = qa('[data-target-toggle]') as HTMLInputElement[];
    expect(toggles.map(t => t.checked)).toEqual([false, true]);
    expect(qa('[data-replica-row]')).toHaveLength(1);
    expect(q('[data-role="preview"]')!.textContent).toBe(
      'replicate(Piston Assembly, [Crank Shaft.connectors.c2], [[Crank Shaft.connectors.c3]]);',
    );
    q<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.waitFor(() => expect(service.isActive).toBe(false));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      filePath: FILE,
      edit: {
        sourceLine: 33,
        seed: { instanceLine: 10 },
        targets: [{ instanceLine: 5, connectorName: 'c2' }],
        rows: [[{ instanceLine: 5, connectorName: 'c3' }]],
      },
    });
  });

  it('removeReplica posts removeRow for the record\'s row', async () => {
    const { service } = mount();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const record: SerializedAssemblyReplicate = {
      replicateId: 'rep-0', owner: '', seed: { occurrenceId: 'asm-0' }, targets: [], rows: [[]], produced: [],
      sourceLocation: { filePath: FILE, line: 33, column: 0 },
    };
    await service.removeReplica(record, 1);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      filePath: FILE,
      removeRow: { sourceLine: 33, row: 1 },
    });
  });

  it('fills rows from the crank\'s unused sibling pins and the other bores', () => {
    const { service, q, qa, container } = mount();
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    const fill = q<HTMLButtonElement>('[data-role="fill-siblings"]')!;
    expect(fill.classList.contains('hidden')).toBe(false);
    fill.click();
    // Bores: bore2, bore3 (bore1 is mated). Pins: c3, c4, c5 (c1 mated to the
    // origin, c2 to the seed) → two rows, plus an empty armed row.
    expect(qa('[data-replica-row]')).toHaveLength(3);
    expect(container.querySelector('[data-replica-cell="0:0"]')!.textContent).toContain('bore2');
    expect(container.querySelector('[data-replica-cell="0:1"]')!.textContent).toContain('c3');
    expect(container.querySelector('[data-replica-cell="1:1"]')!.textContent).toContain('c4');
    expect(q('[data-role="hint"]')!.textContent).toBe(
      'Copy 4: click a connector on another part in the 3D view for its Slider mate. Or Apply now to add 2 copies.',
    );
  });

  it('seed picking: a click on a sub-assembly member opens on its top-level occurrence', () => {
    const { service, q, qa } = mount();
    service.armSeedPick();
    expect(service.isPicking).toBe(true);
    expect(q('[data-role="seed-prompt"]')!.classList.contains('hidden')).toBe(false);
    service.handleClick('shape', { type: 'face', index: 0 }, 'asm-0/inst-2');
    expect(q('[data-role="title"]')!.textContent).toBe('Replicate · Piston Assembly');
    expect(qa('[data-target-toggle]')).toHaveLength(2);
  });

  it('re-resolves picks after a render re-mints connector ids', () => {
    const assembly = engine();
    const { service, pick, q, calls } = mount(assembly);
    service.begin({ kind: 'occurrence', id: 'asm-0' });
    pick('w-bore2', WORLD_BODY_ID);
    pick('c-crank-c3', 'inst-0');
    // Render: bore2 gets a fresh scene id; the crank connector ids stay (part-scoped).
    assembly.connectors![1].connectorId = 'w-bore2-fresh';
    calls.provisional.length = 0;
    service.handleSceneRendered('assembly');
    expect(q('[data-role="preview"]')!.textContent).toContain('[[bore2, Crank Shaft.connectors.c3]]');
    const spec = calls.provisional.at(-1) as { rows: { mates: any[] }[] };
    expect(spec.rows[0].mates.find(m => m.type === 'slider').connectorA.connectorId).toBe('w-bore2-fresh');
    service.handleSceneRendered('part');
    expect(service.isActive).toBe(false);
  });
});

describe('replica addressing for the mate dialog', () => {
  it('a root replica anchors on its replicate() line with its row', () => {
    const assembly = engine();
    assembly.instances.push(instance('inst-3', 'p-crank', 'Crank Shaft (2)', 50, { replica: { of: 'inst-0', statement: 'rep-0', row: 1 } }));
    const { controller } = fakeController();
    const state = resolveConnectorPick(assembly, controller, 'c-crank-c2', 'inst-3');
    expect(state).toMatchObject({ kind: 'connector', instanceLine: 50, replicaRow: 1, connectorName: 'c2' });
    const chain = resolveSideChain(assembly, state as any);
    expect(chain).toEqual({ filePath: FILE, instanceLine: 50, replicaRow: 1 });
  });

  it('a member of a replica occurrence anchors on the replicate() line, its row, and the export chain', () => {
    const assembly = engine();
    assembly.occurrences!.push(occurrence('asm-1', 'Piston Assembly (2)', 33, { replica: { of: 'asm-0', statement: 'rep-0', row: 0 } }));
    assembly.instances.push(instance('asm-1/inst-2', 'p-piston', 'Piston', 5, { owner: 'asm-1', sourceLocation: { filePath: SUB_FILE, line: 5, column: 0 } }));
    const { controller } = fakeController();
    const state = resolveConnectorPick(assembly, controller, 'c-piston-c2', 'asm-1/inst-2');
    expect(state).toMatchObject({ kind: 'connector', owner: 'asm-1', ownerLabel: 'Piston Assembly (2)' });
    expect((state as any).replicaRow).toBeUndefined();
    const chain = resolveSideChain(assembly, state as any);
    expect(chain).toEqual({ filePath: FILE, instanceLine: 33, viaParts: [{ keys: ['piston1'] }], replicaRow: 0 });
  });

  it('numeric export keys index instead of dereferencing', () => {
    expect(renderPartsPath(['copies', '1'])).toBe('.parts.copies[1]');
    expect(renderPartsPath(['left', 'p1'])).toBe('.parts.left.p1');
    expect(renderPartsPath([])).toBe('.parts');
  });
});
