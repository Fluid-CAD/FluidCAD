// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import './dom-reset';
import { PerspectiveCamera, Quaternion, Raycaster, Scene, Vector2, Vector3 } from 'three';
import { AssemblyGizmoDriver } from '../src/interactive/gizmo/assembly-gizmo-driver';
import type { AssemblyGizmoBindings } from '../src/interactive/gizmo/assembly-gizmo-driver';
import { FeaturePanel } from '../src/interactive/create-feature/feature-panel';

// With the transform triad attached, Escape belongs to the triad: it is
// dismissed and an open feature dialog stays put; the next Escape closes the
// dialog. The driver claims the key in the capture phase, ahead of the
// dialogs' document listener.

class TestPanel extends FeaturePanel {
  exits = 0;

  constructor() {
    super(document.body, { id: 'test-gizmo-panel', title: 'Test', icon: '', bodyHtml: '' });
    this.onExit = () => {
      this.exits++;
      this.hide();
    };
  }

  show(): void {
    this.shell.show();
  }
}

function makeDriver(): AssemblyGizmoDriver {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  document.body.appendChild(container);
  const camera = new PerspectiveCamera(50, 4 / 3, 0.1, 1000);
  const controller = {
    isInstanceLocked: () => false,
    getInstancePose: () => ({ position: new Vector3(), quaternion: new Quaternion() }),
    getInstanceFreedom: () => ({ translates: true, rotates: [true, true, true] }),
  };
  const viewer = {
    sceneContext: {
      scene: new Scene(),
      renderer: { domElement: canvas },
      camera,
      createPickingRaycaster: (x: number, y: number) => {
        const raycaster = new Raycaster();
        raycaster.setFromCamera(new Vector2(x, y), camera);
        return raycaster;
      },
      requestRender: () => {},
    },
    setClickInterceptor: () => {},
    setHoverSuppressor: () => {},
    getAssemblyController: () => controller,
  };
  const bindings = {
    viewer,
    container,
    findInstance: () => undefined,
    instanceHasMate: () => false,
    applyInstancePose: async () => ({ success: true }),
    getPoseExpressions: async () => null,
    fetchScopeVariables: async () => [],
    flashError: () => {},
  } as unknown as AssemblyGizmoBindings;
  return new AssemblyGizmoDriver(bindings);
}

const escape = () => document.body.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
);

const panels: TestPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.hide();
  }
});

describe('assembly gizmo Escape', () => {
  it('dismisses the attached triad before an open dialog closes', () => {
    const driver = makeDriver();
    const panel = new TestPanel();
    panels.push(panel);
    panel.show();
    driver.handleSelection('i1');
    expect(driver.isAttached).toBe(true);

    escape();
    expect(driver.isAttached).toBe(false);
    expect(panel.exits).toBe(0);

    escape();
    expect(panel.exits).toBe(1);
  });

  it('leaves Escape to the dialog while no triad is attached', () => {
    makeDriver();
    const panel = new TestPanel();
    panels.push(panel);
    panel.show();
    escape();
    expect(panel.exits).toBe(1);
  });
});
