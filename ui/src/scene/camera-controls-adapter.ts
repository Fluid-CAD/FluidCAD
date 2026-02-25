import { EventDispatcher, Vector3 } from 'three';
import CameraControls from 'camera-controls';

/**
 * Adapter that wraps a CameraControls instance to provide the duck-typed
 * interface expected by ViewportGizmo.attachControls():
 *   - .target (Vector3, read/write)
 *   - .enabled (boolean)
 *   - .update() (no-args method)
 *   - addEventListener('change', fn) / removeEventListener('change', fn)
 */
export class CameraControlsAdapter extends EventDispatcher<{ change: {} }> {
  readonly target = new Vector3();

  constructor(readonly cc: CameraControls) {
    super();

    // Forward camera-controls 'update' events as 'change' events for the gizmo
    cc.addEventListener('update', () => {
      cc.getTarget(this.target);
      this.dispatchEvent({ type: 'change' });
    });
  }

  get enabled(): boolean {
    return this.cc.enabled;
  }

  set enabled(value: boolean) {
    this.cc.enabled = value;
  }

  /**
   * Called by the gizmo after it directly mutates the camera.
   * Syncs those mutations back into camera-controls.
   */
  update(): void {
    const camera = this.cc.camera;
    const pos = camera.position;
    const t = this.target;
    this.cc.setLookAt(pos.x, pos.y, pos.z, t.x, t.y, t.z, false);
  }
}
