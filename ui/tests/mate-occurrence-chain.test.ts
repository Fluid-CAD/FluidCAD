// @vitest-environment jsdom
// Occurrence-aware mate authoring: a connector picked INSIDE a sub-assembly
// anchors the statement on the occurrence's insert() in the open file and
// reaches the connector through `.parts` export chains — `keys` when the
// sub-assembly already exports the handle, `createFrom` when the server must
// add the export first. The old cross-file refusal only remains for picks no
// single file can reference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssemblyMateService } from '../src/interactive/assembly-mate/mate-service';
import type { Viewer } from '../src/viewer';
import type { SerializedAssembly } from '../src/types';

const MAIN = '/ws/main.assembly.js';
const PISTON = '/ws/piston.assembly.js';

const CONNECTOR_NAMES: Record<string, string> = {
  'conn-crank': 'c2',
  'conn-rodcap': 'c2',
  'conn-rodcap-2': 'c2',
};

function makeViewer(): Viewer {
  const controller = {
    getConnectorName: (id: string) => CONNECTOR_NAMES[id],
    findConnectorId: () => null,
    setMatePicking: () => {},
    setMatePickedConnectors: () => {},
    setProvisionalMate: () => {},
    commitProvisionalMate: () => {},
  };
  return {
    pickConnectors: false,
    getAssemblyController: () => controller,
  } as unknown as Viewer;
}

/** The user's piston/crank shape: crank at root, rod cap inside an occurrence. */
function makeAssembly(opts: {
  exports?: { path: string[]; instanceId?: string; occurrenceId?: string }[];
  secondOccurrence?: boolean;
} = {}): SerializedAssembly {
  const occurrence = (id: string, line: number) => ({
    occurrenceId: id,
    assemblyName: 'Piston Assembly',
    name: 'Piston Assembly',
    parentPath: '',
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    groundConnected: false,
    exports: opts.exports,
    sourceLocation: { filePath: MAIN, line, column: 0 },
  });
  const rodCap = (owner: string) => ({
    instanceId: `${owner}/inst-1`,
    partId: 'p-rodcap', partName: 'Connecting Rod Cap',
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false, owner, name: 'Connecting Rod Cap',
    sourceLocation: { filePath: PISTON, line: 9, column: 0 },
  });
  return {
    instances: [
      {
        instanceId: 'inst-0', partId: 'p-crank', partName: 'Crank Shaft',
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        grounded: false, owner: '', name: 'Crank Shaft',
        sourceLocation: { filePath: MAIN, line: 5, column: 0 },
      },
      rodCap('asm-0'),
      ...(opts.secondOccurrence ? [rodCap('asm-1')] : []),
    ],
    mates: [],
    occurrences: [occurrence('asm-0', 9), ...(opts.secondOccurrence ? [occurrence('asm-1', 10)] : [])],
  };
}

function makeService(assembly: SerializedAssembly): AssemblyMateService {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new AssemblyMateService(container, makeViewer(), {
    getAssembly: () => assembly,
  });
}

function panelText(role: 'preview' | 'message'): string {
  return document.querySelector(`[data-role="${role}"]`)?.textContent ?? '';
}

function pickConnector(svc: AssemblyMateService, connectorId: string, instanceId: string): void {
  svc.handleClick(connectorId, { type: 'connector', index: 0 } as any, instanceId);
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function applied(): Promise<{ url: string; body: any }> {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  return { url, body: JSON.parse(init.body) };
}

describe('occurrence-aware mate picks', () => {
  it('a nested + root pair applies with a keys viaParts chain into the open file', async () => {
    const svc = makeService(makeAssembly({
      exports: [{ path: ['rodCap1'], instanceId: 'asm-0/inst-1' }],
    }));
    svc.enter('revolute');
    pickConnector(svc, 'conn-rodcap', 'asm-0/inst-1');
    pickConnector(svc, 'conn-crank', 'inst-0');
    expect(panelText('message')).toBe('');
    expect(panelText('preview')).toBe(
      "mate('revolute', Piston Assembly.parts.rodCap1.connectors.c2, Crank Shaft.connectors.c2);",
    );
    await (svc as any).apply();
    const { body } = await applied();
    expect(body.filePath).toBe(MAIN);
    expect(body.create.connectorA).toEqual({
      instanceLine: 9,
      connectorName: 'c2',
      viaParts: [{ keys: ['rodCap1'] }],
    });
    expect(body.create.connectorB).toEqual({ instanceLine: 5, connectorName: 'c2' });
  });

  it('a not-yet-exported nested pick applies with createFrom for the server to export', async () => {
    const svc = makeService(makeAssembly({ exports: [] }));
    svc.enter('revolute');
    pickConnector(svc, 'conn-rodcap', 'asm-0/inst-1');
    pickConnector(svc, 'conn-crank', 'inst-0');
    expect(panelText('message')).toBe('');
    expect(panelText('preview')).toContain('.parts.….connectors.c2');
    await (svc as any).apply();
    const { body } = await applied();
    expect(body.create.connectorA.viaParts).toEqual([
      { createFrom: { filePath: PISTON, insertLine: 9 } },
    ]);
  });

  it('the same connector on two occurrences of one sub-assembly is two picks, not a self-mate', async () => {
    const svc = makeService(makeAssembly({
      exports: [{ path: ['rodCap1'], instanceId: 'asm-0/inst-1' }],
      secondOccurrence: true,
    }));
    svc.enter('fastened');
    pickConnector(svc, 'conn-rodcap', 'asm-0/inst-1');
    pickConnector(svc, 'conn-rodcap-2', 'asm-1/inst-1');
    expect(panelText('message')).toBe('');
    await (svc as any).apply();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('an engine without serialized exports gets the update message, not the cross-file one', () => {
    const svc = makeService(makeAssembly({ exports: undefined }));
    svc.enter('revolute');
    pickConnector(svc, 'conn-rodcap', 'asm-0/inst-1');
    pickConnector(svc, 'conn-crank', 'inst-0');
    expect(panelText('message')).toMatch(/predates sub-assembly exports/);
  });

  it('two root-scope picks still write plain same-file refs', async () => {
    const assembly = makeAssembly();
    assembly.instances[1] = {
      ...assembly.instances[1],
      instanceId: 'inst-1', owner: '', name: 'Connecting Rod Cap',
      sourceLocation: { filePath: MAIN, line: 7, column: 0 },
    };
    const svc = makeService(assembly);
    svc.enter('revolute');
    pickConnector(svc, 'conn-rodcap', 'inst-1');
    pickConnector(svc, 'conn-crank', 'inst-0');
    await (svc as any).apply();
    const { body } = await applied();
    expect(body.create.connectorA).toEqual({ instanceLine: 7, connectorName: 'c2' });
    expect(body.create.connectorB).toEqual({ instanceLine: 5, connectorName: 'c2' });
  });
});
