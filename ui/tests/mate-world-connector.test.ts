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

const highlighted: (string | null)[] = [];

function makeViewer(): Viewer {
  const controller = {
    getConnectorName: (id: string) => (id === 'conn-crank' ? 'shaft' : null),
    findConnectorId: (_instanceId: string, name: string) => (name === 'shaft' ? 'conn-crank' : null),
    setMatePicking: () => {},
    setMatePickedConnectors: () => {},
    setProvisionalMate: () => {},
    commitProvisionalMate: () => {},
    setHighlightedConnector: (id: string | null) => { highlighted.push(id); },
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
  highlighted.length = 0;
});

function makeContainer(): HTMLElement {
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(container);
  return container;
}

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

  it('an ambiguous click opens a popover; hovering highlights, clicking picks', () => {
    const assembly = makeAssembly();
    const container = makeContainer();
    const svc = new AssemblyMateService(container, makeViewer(), { getAssembly: () => assembly });
    svc.enter('fastened');
    svc.handleClick('conn-crank', { type: 'connector', index: 0 } as any, 'inst-0', {
      clientX: 100, clientY: 100,
      connectorCandidates: [
        { instanceId: 'inst-0', connectorId: 'conn-crank' },
        { instanceId: WORLD_BODY_ID, connectorId: 'w1' },
      ],
    });
    const menu = container.querySelector<HTMLElement>('[data-role="connector-pick-menu"]')!;
    expect(menu).not.toBeNull();
    const rows = menu.querySelectorAll<HTMLButtonElement>('[data-index]');
    expect([...rows].map(r => r.textContent)).toEqual(['Crank Shaft · shaft', 'Assembly · origin']);
    // Nothing is picked until a row is chosen.
    expect(container.querySelector('[data-role="body"]')!.textContent).not.toContain('Assembly · origin');
    rows[1].dispatchEvent(new MouseEvent('mouseenter'));
    expect(highlighted).toEqual(['w1']);
    rows[1].click();
    expect(container.querySelector('[data-role="connector-pick-menu"]')).toBeNull();
    expect(container.querySelector('[data-role="body"]')!.textContent).toContain('Assembly · origin');
    expect(panelText('message')).toBe('');
  });

  it('a lone candidate never opens the popover, and Escape dismisses an open one', () => {
    const assembly = makeAssembly();
    const container = makeContainer();
    const svc = new AssemblyMateService(container, makeViewer(), { getAssembly: () => assembly });
    svc.enter('fastened');
    svc.handleClick('w1', { type: 'connector', index: 0 } as any, WORLD_BODY_ID, {
      clientX: 100, clientY: 100, connectorCandidates: [{ instanceId: WORLD_BODY_ID, connectorId: 'w1' }],
    });
    expect(container.querySelector('[data-role="connector-pick-menu"]')).toBeNull();
    expect(container.querySelector('[data-role="body"]')!.textContent).toContain('Assembly · origin');

    svc.handleClick('conn-crank', { type: 'connector', index: 0 } as any, 'inst-0', {
      clientX: 100, clientY: 100,
      connectorCandidates: [
        { instanceId: 'inst-0', connectorId: 'conn-crank' },
        { instanceId: WORLD_BODY_ID, connectorId: 'w1' },
      ],
    });
    expect(container.querySelector('[data-role="connector-pick-menu"]')).not.toBeNull();
    // Dismiss listeners register after the opening click settles.
    return new Promise<void>((resolve) => setTimeout(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(container.querySelector('[data-role="connector-pick-menu"]')).toBeNull();
      expect(highlighted.at(-1)).toBeNull();
      resolve();
    }, 0));
  });

  it('a rail row picks the assembly connector into the armed slot; tangent refuses', () => {
    const assembly = makeAssembly();
    const container = makeContainer();
    const svc = new AssemblyMateService(container, makeViewer(), { getAssembly: () => assembly });
    svc.pickWorldConnector('w1'); // not armed: ignored
    expect(container.querySelector('[data-role="body"]')!.textContent).not.toContain('Assembly · origin');
    svc.enter('revolute');
    svc.pickWorldConnector('w1');
    expect(container.querySelector('[data-role="body"]')!.textContent).toContain('Assembly · origin');
    svc.exit();
    svc.enter('tangent');
    svc.pickWorldConnector('w1');
    expect(panelText('message')).toMatch(/Tangent mates take exposed faces\/edges/);
  });
});
