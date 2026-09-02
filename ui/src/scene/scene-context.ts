import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Clock,
  DirectionalLight,
  MathUtils,
  Matrix4,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  Spherical,
  SRGBColorSpace,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import CameraControls from 'camera-controls';
import { ViewportGizmo } from 'three-viewport-gizmo';
import { CameraControlsAdapter } from './camera-controls-adapter';
import { themeColors, onThemeChange } from './theme-colors';
import { LineResolutionRegistry } from '../meshes/shape-meshes/line-resolution';
import { runFrameHooks } from '../meshes/frame-hooks';
import { setScreenScaleSource } from '../meshes/screen-scale';
import { worldFromMm } from '../units/scene-scale';

// Install camera-controls with only the Three.js submodules it needs
CameraControls.install({
  THREE: {
    Vector2,
    Vector3,
    Vector4,
    Quaternion,
    Matrix4,
    Spherical,
    Box3,
    Sphere,
    Raycaster,
    MathUtils: { DEG2RAD: MathUtils.DEG2RAD, clamp: MathUtils.clamp },
  },
});

const Z_UP = new Vector3(0, 0, 1);
/** Default orthographic view height and eye position, in mm — evaluated
 * through `worldFromMm` so an inch or metre document opens on the same
 * picture. */
const VIEW_SIZE_MM = 120;
const DEFAULT_EYE_MM = new Vector3(50, -50, 40);

function viewSize(): number {
  return worldFromMm(VIEW_SIZE_MM);
}

function defaultEye(): Vector3 {
  return DEFAULT_EYE_MM.clone().multiplyScalar(worldFromMm(1));
}

/** Factor applied to the bounding sphere radius when fitting to add breathing room. */
export const FIT_PADDING = 1.1;
/** Far-plane reach as a multiple of the eye distance / ortho window. */
const CLIP_REACH = 500;

/**
 * Consecutive no-work frames before the animation loop stops scheduling
 * itself. Generous enough to bridge sub-second gaps between an interaction's
 * phases (gizmo animation hand-off, drag-start → first move); an always-on
 * loop costs measurable CPU at idle, so it must not stay smaller than forever.
 */
const IDLE_STOP_FRAMES = 30;

/**
 * Owns the core Three.js objects: scene, dual cameras, renderer,
 * camera-controls, gizmo, and lighting. Provides a hybrid animation
 * loop (camera-controls driven + on-demand rendering) and handles
 * window resizing.
 *
 * The loop is on-demand: it sleeps after {@link IDLE_STOP_FRAMES} frames with
 * nothing to do and is woken by requestRender(), camera-controls input/
 * transition events, or a gizmo interaction. Instant camera moves
 * (setLookAt(..., false), updateCameraUp()) dispatch no event — callers must
 * pair them with requestRender(), which they already do for the render itself.
 */
export class SceneContext {
  readonly scene: Scene;
  readonly renderer: WebGLRenderer;
  readonly gizmo: ViewportGizmo;

  private orthoCamera: OrthographicCamera;
  private perspCamera: PerspectiveCamera;
  private activeCamera: 'orthographic' | 'perspective' = 'orthographic';

  private _cc!: CameraControls;
  private _adapter!: CameraControlsAdapter;

  private dirLight: DirectionalLight;
  private rotationLocked = false;
  private renderRequested = false;
  private resizeObserver: ResizeObserver;
  private clock = new Clock();
  private animFrameId = 0;
  private gizmoWasActive = false;
  private viewShiftY = 0;
  private running = false;
  private idleFrames = 0;
  private disposed = false;
  /** Radius of the last fitted sphere — near/far are re-derived from it
   * when the camera is swapped, so a switch keeps the fit's depth range. */
  private lastFitRadius = 0;
  private cameraChangeListeners = new Set<() => void>();

  constructor(private container: HTMLElement) {
    Object3D.DEFAULT_UP = Z_UP.clone();

    // Renderer
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    LineResolutionRegistry.setResolution(width, height);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new Scene();
    this.scene.background = themeColors.backgroundColor.clone();

    // Dual cameras — frustum, eye and clip planes come from the document
    // unit; see applyUnitDefaults.
    const aspect = width / height;
    this.orthoCamera = new OrthographicCamera(-aspect, aspect, 1, -1, -1, 1);
    this.orthoCamera.up.copy(Z_UP);
    this.perspCamera = new PerspectiveCamera(50, aspect, 0.5, 10000);
    this.perspCamera.up.copy(Z_UP);
    this.applyOrthoFrustum(aspect);
    this.applyClipPlanes(defaultEye().length(), viewSize() / 2);
    for (const cam of [this.orthoCamera, this.perspCamera]) {
      cam.position.copy(defaultEye());
      cam.lookAt(0, 0, 0);
    }

    // Let screen-space markers size themselves on creation against the live
    // renderer + active camera (the getter always returns the current one).
    setScreenScaleSource(this.renderer, () => this.camera);

    // Lighting
    this.dirLight = new DirectionalLight(0xffffff, 1);
    this.scene.add(this.dirLight);
    this.scene.add(new AmbientLight(0xddeeff, 2.5));

    // Camera-controls (starts with ortho)
    this._cc = this.createCameraControls(this.orthoCamera);
    this.configureTouchForMode('orthographic');
    this._cc.updateCameraUp();

    // Adapter for gizmo compatibility
    this._adapter = new CameraControlsAdapter(this._cc);

    // Viewport gizmo. Mount it in the same container the renderer fills (the
    // toolbar-inset #fluidcad-scene) so it renders at the top-right of the
    // visible viewport; on document.body it would anchor to the window top and
    // fall above the inset canvas, clipping the gizmo away.
    this.gizmo = new ViewportGizmo(this.camera, this.renderer, {
      container,
      size: 80,
      type: 'sphere',
    });
    const eye = defaultEye();
    this._cc.setLookAt(eye.x, eye.y, eye.z, 0, 0, 0, false);
    this._cc.getTarget(this._adapter.target);
    this.gizmo.target = this._adapter.target;
    this.gizmo.attachControls(this._adapter as any);

    // Gizmo change events trigger a render request. 'start' must wake the
    // loop too: the click-to-snap animation is stepped inside gizmo.render(),
    // so it only advances while frames are being rendered.
    this.gizmo.addEventListener('change', () => this.requestRender());
    this.gizmo.addEventListener('start', () => this.requestRender());

    // ResizeObserver for container size changes
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    // Update scene background when the theme changes
    onThemeChange(() => {
      this.scene.background = themeColors.backgroundColor.clone();
      this.requestRender();
    });

    // First frame
    this.requestRender();
  }

  /** The currently active camera. */
  get camera(): OrthographicCamera | PerspectiveCamera {
    return this.activeCamera === 'orthographic' ? this.orthoCamera : this.perspCamera;
  }

  /**
   * Build a Raycaster for screen-space picking against the active camera.
   *
   * Orthographic note: the ortho camera uses a negative `near` so the view frustum
   * extends behind the camera's position. `Raycaster.setFromCamera` puts the ray
   * origin at NDC z=0 — on the camera plane — and `Ray.intersectTriangle` filters
   * hits with t < 0, so any face sitting behind that plane (still inside the visible
   * frustum) is silently missed, and a face/edge further back may win instead. We
   * push the ray origin back along -direction by the full frustum depth so every
   * visible triangle lies at t > 0. Switching camera modes works around this only
   * because `switchCamera` moves the camera position far back to match the
   * perspective FOV and keeps it there on the return trip.
   */
  createPickingRaycaster(ndcX: number, ndcY: number): Raycaster {
    const cam = this.camera;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), cam);

    if ((cam as OrthographicCamera).isOrthographicCamera) {
      const ortho = cam as OrthographicCamera;
      const frustumDepth = Math.max(Math.abs(ortho.far - ortho.near), 1);
      raycaster.ray.origin.addScaledVector(raycaster.ray.direction, -frustumDepth);
    }

    return raycaster;
  }

  /** Direct access to the CameraControls instance. */
  get cameraControls(): CameraControls {
    return this._cc;
  }

  /**
   * Fires whenever the view changes — camera-controls updates (orbit, zoom,
   * transitions), a camera swap, a resize. Registered here rather than on
   * the adapter because {@link switchCamera} rebuilds both the controls and
   * the adapter, which would silently drop adapter listeners.
   */
  subscribeCameraChange(fn: () => void): () => void {
    this.cameraChangeListeners.add(fn);
    return () => {
      this.cameraChangeListeners.delete(fn);
    };
  }

  private notifyCameraChange(): void {
    // Zoom moves the eye (perspective) or widens the window (ortho); the
    // depth range must follow or the grid and model get clipped.
    this.setClipRange(this._cc.distance);
    for (const fn of this.cameraChangeListeners) {
      fn();
    }
  }

  /**
   * Re-seat the cameras on the unit-scaled defaults: the 120 mm-equivalent
   * ortho window, the (50, −50, 40) mm-equivalent eye, and clip planes for
   * that depth. Used at construction and again when the document unit
   * changes while nothing is on screen — a fit would have nothing to fit.
   */
  applyUnitDefaults(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.applyOrthoFrustum(width / height);
    this.orthoCamera.zoom = 1;
    const eye = defaultEye();
    this.applyClipPlanes(eye.length(), viewSize() / 2);
    this._cc.setLookAt(eye.x, eye.y, eye.z, 0, 0, 0, false);
    this._cc.getTarget(this._adapter.target);
    this.gizmo.update();
    this.requestRender();
    this.notifyCameraChange();
  }

  private applyOrthoFrustum(aspect: number): void {
    const size = viewSize();
    this.orthoCamera.left = -aspect * size / 2;
    this.orthoCamera.right = aspect * size / 2;
    this.orthoCamera.top = size / 2;
    this.orthoCamera.bottom = -size / 2;
    this.orthoCamera.updateProjectionMatrix();
  }

  /**
   * Clip planes for a view whose eye sits `dist` from a subject of
   * `radius`. Perspective: near as deep as depth precision allows
   * (dist/1000, floored at 0.01 mm-equivalent so a metre model's near
   * plane doesn't sit inside the model), far past the subject's back.
   * Orthographic: the same magnitude mirrored about the camera plane —
   * the picking raycaster reads this depth to start its ray in front of
   * everything visible (see createPickingRaycaster).
   */
  private applyClipPlanes(dist: number, radius: number): void {
    this.lastFitRadius = radius;
    this.setClipRange(dist);
  }

  /**
   * Depth range for the current eye distance. The far plane reaches well
   * past the subject (CLIP_REACH × the eye distance, or the orthographic
   * window when that is wider): with the fit-only `dist + 10r` a dolly out
   * clipped the grid to a hard-edged band and eventually the model itself.
   * Perspective depth precision near the subject depends on `near`, not on
   * how far `far` sits, so the long reach costs nothing there; ortho depth
   * is linear over ±far, still finer than 1/16000 of the eye distance.
   * Re-derived on every camera change, not only on fit.
   */
  private setClipRange(dist: number): void {
    const orthoWindow = (this.orthoCamera.top - this.orthoCamera.bottom) / this.orthoCamera.zoom;
    const far = Math.max(dist + 10 * this.lastFitRadius, CLIP_REACH * Math.max(dist, orthoWindow));
    this.perspCamera.near = Math.max(dist / 1000, worldFromMm(0.01));
    this.perspCamera.far = far;
    this.perspCamera.updateProjectionMatrix();
    this.orthoCamera.near = -far;
    this.orthoCamera.far = far;
    this.orthoCamera.updateProjectionMatrix();
  }

  /**
   * Lock the camera orientation: left-drag and one-finger touch pan instead
   * of rotating, and the gizmo goes inert (a gizmo click/drag is a rotation
   * too). Pan and zoom stay available. Survives camera switches — the
   * rebuild in {@link switchCamera} re-applies the lock.
   */
  setRotationLocked(locked: boolean): void {
    this.rotationLocked = locked;
    this.applyRotationLock();
  }

  private applyRotationLock(): void {
    this._cc.mouseButtons.left = this.rotationLocked
      ? CameraControls.ACTION.TRUCK
      : CameraControls.ACTION.ROTATE;
    this._cc.touches.one = this.rotationLocked
      ? CameraControls.ACTION.TOUCH_TRUCK
      : CameraControls.ACTION.TOUCH_ROTATE;
    this.gizmo.enabled = !this.rotationLocked;
  }

  /** The adapter for ViewportGizmo compatibility. */
  get controls(): CameraControlsAdapter {
    return this._adapter;
  }

  /** Schedule a render on the next animation frame tick. */
  requestRender(): void {
    this.renderRequested = true;
    this.wake();
  }

  /** Fit the camera to a bounding box while preserving the current viewing angle. */
  fitToBox(box: Box3, enableTransition: boolean): void {
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    if (radius === 0) return;

    const sphere = new Sphere(center, radius * FIT_PADDING);
    this._cc.fitToSphere(sphere, enableTransition);
    // Clip planes for the fitted view. Perspective fits move the eye to the
    // sphere-fitting distance (known up front, even mid-transition); an
    // orthographic fit only re-zooms, so its eye distance is what it is.
    const dist = this.activeCamera === 'perspective'
      ? this._cc.getDistanceToFitSphere(sphere.radius)
      : this._cc.distance;
    this.applyClipPlanes(dist, sphere.radius);
    // The instant form dispatches no transitionstart — wake so the next
    // update() applies and renders it.
    this.wake();
  }

  /**
   * Shift the rendered view up by `px` (0 clears). A pure projection-window
   * offset (setViewOffset) — camera state is untouched, so zoom, orbit,
   * fit-to-view and any setLookAt (sketch-close restore, gizmo snaps) compose
   * with it, and the shift stays a constant pixel height at every zoom level.
   * Applied to both cameras so camera switches keep it. The phone-layout
   * dialog sheet drives it (see DialogViewOffset).
   */
  setViewShift(px: number): void {
    if (px === this.viewShiftY) return;
    this.viewShiftY = px;
    this.applyViewShift();
    this.requestRender();
  }

  private applyViewShift(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    for (const cam of [this.orthoCamera, this.perspCamera]) {
      if (this.viewShiftY === 0) {
        cam.clearViewOffset();
      } else {
        cam.setViewOffset(width, height, 0, this.viewShiftY, width, height);
      }
    }
  }

  /** Switch between perspective and orthographic cameras. */
  switchCamera(mode: 'perspective' | 'orthographic'): void {
    if (mode === this.activeCamera) return;

    // Read current position and target from camera-controls
    const pos = new Vector3();
    const tgt = new Vector3();
    this._cc.getPosition(pos);
    this._cc.getTarget(tgt);
    const up = this.camera.up.clone();

    // When switching from orthographic to perspective, adjust the camera
    // distance so the visible area matches. Orthographic zoom is controlled
    // by the camera's zoom property, not distance, so the raw position
    // would produce a too-zoomed-in perspective view on the first switch.
    if (this.activeCamera === 'orthographic' && mode === 'perspective') {
      const orthoHeight = (this.orthoCamera.top - this.orthoCamera.bottom) / this.orthoCamera.zoom;
      const halfFovRad = MathUtils.DEG2RAD * this.perspCamera.fov * 0.5;
      const targetDist = (orthoHeight * 0.5) / Math.tan(halfFovRad);
      const dir = pos.clone().sub(tgt).normalize();
      pos.copy(tgt).add(dir.multiplyScalar(targetDist));
    }

    // Switch active camera
    this.activeCamera = mode;
    const newCam = this.camera;

    // Copy state to the new camera
    newCam.position.copy(pos);
    newCam.up.copy(up);
    newCam.lookAt(tgt);

    // Dispose old camera-controls and create a new one
    this._cc.dispose();
    this._cc = this.createCameraControls(newCam);
    this._cc.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
    this._cc.updateCameraUp();
    this.configureTouchForMode(mode);
    this.applyRotationLock();

    // Create new adapter
    this._adapter = new CameraControlsAdapter(this._cc);
    this._cc.getTarget(this._adapter.target);

    // Rebind gizmo
    (this.gizmo as any).camera = newCam;
    this.gizmo.target = this._adapter.target;
    this.gizmo.attachControls(this._adapter as any);
    this.gizmo.update();

    // The new eye distance needs its own depth range.
    this.applyClipPlanes(pos.distanceTo(tgt), this.lastFitRadius || viewSize() / 2);
    this.requestRender();
    this.notifyCameraChange();
  }

  /** Immediately render one frame. */
  render(): void {
    this.updateLightPositions();
    // Screen-space layout passes (solved-sketch annotation declutter) decide
    // what is visible this frame, so they must run before the draw — Three's
    // own onBeforeRender never fires for the objects they need to un-hide.
    runFrameHooks(this.renderer, this.camera);
    this.renderer.render(this.scene, this.camera);
    this.gizmo.render();
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.animFrameId);
    this.resizeObserver.disconnect();
    this._cc.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Build a configured CameraControls for `camera` and hook up the events
   * that must restart the sleeping animation loop: user input (controlstart /
   * control — the latter is the only one wheel dollies dispatch) and
   * programmatic transitions (transitionstart).
   */
  private createCameraControls(camera: OrthographicCamera | PerspectiveCamera): CameraControls {
    const cc = new CameraControls(camera, this.renderer.domElement);
    cc.dollyToCursor = true;
    cc.smoothTime = 0.1;
    cc.draggingSmoothTime = 0.05;
    cc.addEventListener('controlstart', this.wakeListener);
    cc.addEventListener('control', this.wakeListener);
    cc.addEventListener('transitionstart', this.wakeListener);
    // 'update' fires inside cc.update() — before this tick's render, so a
    // listener's uniform writes land in the same frame.
    cc.addEventListener('update', this.cameraChangeListener);
    return cc;
  }

  private wakeListener = (): void => this.wake();
  private cameraChangeListener = (): void => this.notifyCameraChange();

  /** Restart the animation loop if it went to sleep. */
  private wake(): void {
    if (this.running || this.disposed) {
      return;
    }
    this.running = true;
    // Discard the time spent asleep — a multi-second first delta would make
    // smoothDamp jump transitions to their end state.
    this.clock.getDelta();
    this.animFrameId = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    const delta = this.clock.getDelta();

    let hasUpdated = false;
    if (this._cc.enabled) {
      if (this.gizmoWasActive) {
        // Gizmo just finished — fully resync cc from the camera state
        // the gizmo left behind (including any up-vector change).
        this._cc.updateCameraUp();
        const pos = this.camera.position;
        const t = this._adapter.target;
        this._cc.setLookAt(pos.x, pos.y, pos.z, t.x, t.y, t.z, false);
        this.gizmoWasActive = false;
      }
      hasUpdated = this._cc.update(delta);
    } else {
      // Gizmo is animating — skip cc.update() to avoid overwriting
      // the gizmo's direct camera manipulations.
      this.gizmoWasActive = true;
    }

    // While cc is disabled (gizmo animation, sketch drags) every frame
    // renders: the gizmo's snap animation is stepped inside gizmo.render(),
    // so rendering is what advances it.
    if (hasUpdated || this.renderRequested || !this._cc.enabled) {
      this.render();
      this.renderRequested = false;
      this.idleFrames = 0;
    } else if (++this.idleFrames >= IDLE_STOP_FRAMES) {
      this.running = false;
      return;
    }

    this.animFrameId = requestAnimationFrame(this.tick);
  };

  private configureTouchForMode(mode: 'perspective' | 'orthographic'): void {
    if (mode === 'orthographic') {
      this._cc.touches.one = CameraControls.ACTION.TOUCH_ROTATE;
      this._cc.touches.two = CameraControls.ACTION.TOUCH_ZOOM_TRUCK;
    } else {
      this._cc.touches.one = CameraControls.ACTION.TOUCH_ROTATE;
      this._cc.touches.two = CameraControls.ACTION.TOUCH_DOLLY_TRUCK;
    }
  }

  private handleResize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight || window.innerHeight;
    if (width === 0 || height === 0) return;

    const aspect = width / height;

    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    LineResolutionRegistry.setResolution(width, height);

    // Update ortho camera
    this.applyOrthoFrustum(aspect);

    // Update perspective camera
    this.perspCamera.aspect = aspect;
    this.perspCamera.updateProjectionMatrix();

    // The view-shift offset stores the canvas size — refresh it
    if (this.viewShiftY !== 0) {
      this.applyViewShift();
    }

    this.gizmo.update();
    this.requestRender();
    // Pixels per world unit changed with the canvas height.
    this.notifyCameraChange();
  }

  private updateLightPositions(): void {
    const dir = new Vector3();
    this.camera.getWorldDirection(dir);
    this.dirLight.position.copy(dir.multiplyScalar(-10));
    this.dirLight.target.position.set(0, 0, 0);
    this.dirLight.target.updateMatrixWorld();
  }
}
