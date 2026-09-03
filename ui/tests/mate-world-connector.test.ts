// @vitest-environment jsdom
// Assembly connectors as mate sides: a pick on a world-body gizmo resolves
// against the payload's `connectors`, fills the slot as an "Assembly · name"
// chip, previews the binding, applies as a frame ref, and re-finds itself by
// name after a render re-mints the scene id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssemblyMateService } from '../src/interactive/assembly-mate/mate-service';
import { WORLD_BODY_ID } from '../src/solver';
import type { Viewer } from '../src/viewer';
import type { SerializedAssembly } from '../src/types';

const MAIN = '/ws/main.assembly.js';

function makeViewer(): Viewer {
  const controller = {
    getConnectorName: (id: string) => (id === 'conn-crank' ? 'shaft' : null),
    findConnectorId: (_instanceId: string, name: string) => (name === 'shaft' ? 'conn-crank' : null),
    setMatePicking: () => {},
    setMatePickedConnectors: () => {},
    setProvisionalMate: () => {},
    commitProvisionalMate: () => {},
  };
  return { pickConnectors: false, getAssemblyController: () => controller } as unknown as Viewer;
}

const frame = {
  origin: { x: 0, y: 0, z: 0 }, xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
};

function makeAssembly(connectorId = 'w1'): SerializedAssembly {
  return {
    instances: [{
      instanceId: 'inst-0', partId: 'p-crank', partName: 'Crank Shaft',
      position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
      grounded: false, owner: '', name: 'Crank Shaft',
      sourceLocation: { filePath: MAIN, line: 5, column: 0 },
    }],
    mates: [],
    occurrences: [],
    connectors: [{
      connectorId, name: 'origin', owner: '', ...frame,
      sourceLocation: { filePath: MAIN, line: 7, column: 0 },
    }],
  };
}

function panelText(role: 'preview' | 'message'): string {
  return document.querySelector(`[data-role="${role}"]`)?.textContent ?? '';
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

describe('assembly connector mate sides', () => {
  it('a world-gizmo pick fills the slot, previews the binding, and applies as a frame ref', async () => {
    let assembly = makeAssembly();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const svc = new AssemblyMateService(container, makeViewer(), { getAssembly: () => assembly });
    svc.enter('revolute');
    svc.handleClick('w1', { type: 'connector', index: 0 } as any, WORLD_BODY_ID);
    expect(panelText('message')).toBe('');
    expect(container.textContent).toContain('Assembly · origin');
    svc.handleClick('conn-crank', { type: 'connector', index: 0 } as any, 'inst-0');
    expect(panelText('preview')).toBe("mate('revolute', origin, Crank Shaft.connectors.shaft);");

    // A render re-mints the connector id; the slot re-finds it by name.
    assembly = makeAssembly('w9');
    svc.handleSceneRendered('assembly');
    expect(panelText('preview')).toBe("mate('revolute', origin, Crank Shaft.connectors.shaft);");

    await (svc as any).apply();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.filePath).toBe(MAIN);
    expect(body.create.frameA).toEqual({ connectorLine: 7, connectorName: 'origin' });
    expect(body.create.connectorB).toEqual({ instanceLine: 5, connectorName: 'shaft' });
  });

  it('refuses two assembly connectors and reports a payload without the connector', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const withTwo: SerializedAssembly = {
      ...makeAssembly(),
      connectors: [
        ...makeAssembly().connectors!,
        { connectorId: 'w2', name: 'other', owner: '', ...frame, sourceLocation: { filePath: MAIN, line: 8, column: 0 } },
      ],
    };
    const svc = new AssemblyMateService(container, makeViewer(), { getAssembly: () => withTwo });
    svc.enter('fastened');
    svc.handleClick('w1', { type: 'connector', index: 0 } as any, WORLD_BODY_ID);
    svc.handleClick('w2', { type: 'connector', index: 0 } as any, WORLD_BODY_ID);
    expect(panelText('message')).toMatch(/two assembly connectors/);

    // The payload the dialog reads must carry `connectors` — a copy that
    // drops the field made every world pick unresolvable.
    const stripped: SerializedAssembly = { ...makeAssembly(), connectors: undefined };
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const svc2 = new AssemblyMateService(container2, makeViewer(), { getAssembly: () => stripped });
    svc2.enter('fastened');
    svc2.handleClick('w1', { type: 'connector', index: 0 } as any, WORLD_BODY_ID);
    expect(container2.querySelector('[data-role="message"]')?.textContent).toMatch(/Could not resolve the assembly connector/);
  });
});
