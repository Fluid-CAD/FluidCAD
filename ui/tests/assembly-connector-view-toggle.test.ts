// @vitest-environment jsdom
// The settings panel's "Connectors" view toggle (viewerSettings.showConnectors)
// used to reach only the compiled part mesh: the assembly's own connectors
// (`connector('name', [x, y, z])` at assembly level) have their own gizmo
// group on the AssemblyController and kept showing with the toggle off.
import { afterEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, Vector2, type Group, type WebGLRenderer } from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import { viewerSettings } from '../src/scene/viewer-settings';
import type { SerializedAssembly } from '../src/types';

const frame = {
  origin: { x: 0, y: 0, z: 0 }, xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
};

function makeAssembly(): SerializedAssembly {
  return {
    instances: [],
    mates: [],
    occurrences: [],
    connectors: [
      { connectorId: 'w1', name: 'origin', owner: '', ...frame },
      { connectorId: 'w2', name: 'lid', owner: '', ...frame },
    ],
  };
}

function makeRig() {
  const canvas = document.createElement('canvas');
  const renderer = { domElement: canvas } as unknown as WebGLRenderer;
  const camera = new PerspectiveCamera(50, 4 / 3, 0.1, 1000);
  let renders = 0;
  const controller = new AssemblyController(
    renderer,
    camera,
    () => { renders += 1; },
    (ndcX, ndcY) => {
      const raycaster = new Raycaster();
      raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
      return raycaster;
    },
  );
  controller.update([], makeAssembly());
  const gizmo = (name: string): Group =>
    controller.getContainer().getObjectByName(`assemblyConnector:${name}`) as Group;
  return { controller, gizmo, renders: () => renders };
}

afterEach(() => {
  viewerSettings.update({ showConnectors: true });
});

describe('assembly connectors follow the "Connectors" view toggle', () => {
  it('hides every assembly connector gizmo when the toggle is off, and shows them again when on', () => {
    const { gizmo, renders } = makeRig();
    expect(gizmo('origin').visible).toBe(true);
    expect(gizmo('lid').visible).toBe(true);

    const before = renders();
    viewerSettings.update({ showConnectors: false });
    expect(gizmo('origin').visible).toBe(false);
    expect(gizmo('lid').visible).toBe(false);
    expect(renders()).toBeGreaterThan(before);

    viewerSettings.update({ showConnectors: true });
    expect(gizmo('origin').visible).toBe(true);
    expect(gizmo('lid').visible).toBe(true);
  });

  it('a render that re-mints the gizmos while the toggle is off keeps them hidden', () => {
    const { controller, gizmo } = makeRig();
    viewerSettings.update({ showConnectors: false });
    controller.update([], makeAssembly());
    expect(gizmo('origin').visible).toBe(false);
  });

  it('turning the toggle back on does not resurrect a connector hidden from the rail', () => {
    const { controller, gizmo } = makeRig();
    controller.setWorldConnectorHidden('lid', true);
    viewerSettings.update({ showConnectors: false });
    viewerSettings.update({ showConnectors: true });
    expect(gizmo('origin').visible).toBe(true);
    expect(gizmo('lid').visible).toBe(false);
  });

  it('an armed mate-dialog pick still reveals the full connector set with the toggle off', () => {
    const { controller, gizmo } = makeRig();
    viewerSettings.update({ showConnectors: false });
    controller.setMatePicking(true);
    expect(gizmo('origin').visible).toBe(true);
    controller.setMatePicking(false);
    expect(gizmo('origin').visible).toBe(false);
  });
});
