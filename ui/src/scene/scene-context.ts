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
const VIEW_SIZE = 120;

/** Factor applied to the bounding sphere radius when fitting to add breathing room. */
export const FIT_PADDING = 1.1;

/**
 * Owns the core Three.js objects: scene, dual cameras, renderer,
 * camera-controls, gizmo, and lighting. Provides a hybrid animation
 * loop (camera-controls driven + on-demand rendering) and handles
 * window resizing.
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
  private renderRequested = false;
  private resizeObserver: ResizeObserver;
  private clock = new Clock();
  private animFrameId = 0;
  private gizmoWasActive = false;

  constructor(private container: HTMLElement) {
    Object3D.DEFAULT_UP = Z_UP.clone();

    // Renderer
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new Scene();
    this.scene.background = themeColors.backgroundColor.clone();

    // Dual cameras
    const aspect = width / height;
    this.orthoCamera = new OrthographicCamera(
      -aspect * VIEW_SIZE / 2,
      aspect * VIEW_SIZE / 2,
      VIEW_SIZE / 2,
      -VIEW_SIZE / 2,
      -10000,
      10000,
    );
    this.orthoCamera.position.set(50, -50, 40);
    this.orthoCamera.up.copy(Z_UP);
    this.orthoCamera.lookAt(0, 0, 0);

    this.perspCamera = new PerspectiveCamera(50, aspect, 0.5, 10000);
    this.perspCamera.position.set(50, -50, 40);
    this.perspCamera.up.copy(Z_UP);
    this.perspCamera.lookAt(0, 0, 0);

    // Lighting
    this.dirLight = new DirectionalLight(0xffffff, 1);
    this.scene.add(this.dirLight);
    this.scene.add(new AmbientLight(0xddeeff, 2.5));

    // Camera-controls (starts with ortho)
    this._cc = new CameraControls(this.orthoCamera, this.renderer.domElement);
    this._cc.dollyToCursor = true;
    this._cc.smoothTime = 0.1;
    this._cc.draggingSmoothTime = 0.05;
    this.configureTouchForMode('orthographic');
    this._cc.updateCameraUp();

    // Adapter for gizmo compatibility
    this._adapter = new CameraControlsAdapter(this._cc);

    // Viewport gizmo
    this.gizmo = new ViewportGizmo(this.camera, this.renderer, {
      size: 80,
      type: 'sphere',
    });
    this._cc.setLookAt(50, -50, 40, 0, 0, 0, false);
    this._cc.getTarget(this._adapter.target);
    this.gizmo.target = this._adapter.target;
    this.gizmo.attachControls(this._adapter as any);

    // Gizmo change events trigger a render request
    this.gizmo.addEventListener('change', () => this.requestRender());

    // ResizeObserver for container size changes
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    // Update scene background when the theme changes
    onThemeChange(() => {
      this.scene.background = themeColors.backgroundColor.clone();
      this.requestRender();
    });

    // Start animation loop
    this.tick();
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

  /** The adapter for ViewportGizmo compatibility. */
  get controls(): CameraControlsAdapter {
    return this._adapter;
  }

  /** Schedule a render on the next animation frame tick. */
  requestRender(): void {
    this.renderRequested = true;
  }

  /** Fit the camera to a bounding box while preserving the current viewing angle. */
  fitToBox(box: Box3, enableTransition: boolean): void {
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    if (radius === 0) return;

    const sphere = new Sphere(center, radius * FIT_PADDING);
    this._cc.fitToSphere(sphere, enableTransition);
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
    this._cc = new CameraControls(newCam, this.renderer.domElement);
    this._cc.dollyToCursor = true;
    this._cc.smoothTime = 0.1;
    this._cc.draggingSmoothTime = 0.05;
    this._cc.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
    this._cc.updateCameraUp();
    this.configureTouchForMode(mode);

    // Create new adapter
    this._adapter = new CameraControlsAdapter(this._cc);
    this._cc.getTarget(this._adapter.target);

    // Rebind gizmo
    (this.gizmo as any).camera = newCam;
    this.gizmo.target = this._adapter.target;
    this.gizmo.attachControls(this._adapter as any);
    this.gizmo.update();

    this.requestRender();
  }

  /** Immediately render one frame. */
  render(): void {
    this.updateLightPositions();
    this.renderer.render(this.scene, this.camera);
    this.gizmo.render();
  }

  dispose(): void {
    cancelAnimationFrame(this.animFrameId);
    this.resizeObserver.disconnect();
    this._cc.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

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

    if (hasUpdated || this.renderRequested || !this._cc.enabled) {
      this.render();
      this.renderRequested = false;
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

    // Update ortho camera
    this.orthoCamera.left = -aspect * VIEW_SIZE / 2;
    this.orthoCamera.right = aspect * VIEW_SIZE / 2;
    this.orthoCamera.top = VIEW_SIZE / 2;
    this.orthoCamera.bottom = -VIEW_SIZE / 2;
    this.orthoCamera.updateProjectionMatrix();

    // Update perspective camera
    this.perspCamera.aspect = aspect;
    this.perspCamera.updateProjectionMatrix();

    this.gizmo.update();
    this.requestRender();
  }

  private updateLightPositions(): void {
    const dir = new Vector3();
    this.camera.getWorldDirection(dir);
    this.dirLight.position.copy(dir.multiplyScalar(-10));
    this.dirLight.target.position.set(0, 0, 0);
    this.dirLight.target.updateMatrixWorld();
  }
}
