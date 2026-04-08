import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  CircleGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData } from '../types';
import { SnapController } from '../snapping/snap-controller';
import { SnapType } from '../snapping/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURVE_SAMPLES = 64;
const GUIDE_COLOR = { r: 0.69, g: 0.69, b: 0.69 }; // #b0b0b0
const GUIDE_COLOR_HEX = 0xb0b0b0;
const CONTROL_POLYGON_OPACITY = 0.35;
const CONTROL_POINT_COLOR = 0xb0b0b0;
const CONTROL_POINT_HOVER_COLOR = 0xf3724f;
const CONTROL_POINT_DRAG_COLOR = 0xff6600;
const START_POINT_COLOR = 0x22cc66;

// Dash-dot pattern (matches MetaEdgeMesh)
const DASH_LENGTH = 4.0;
const GAP_LENGTH = 1.5;
const DOT_LENGTH = 0.6;
const PATTERN_LENGTH = DASH_LENGTH + GAP_LENGTH + DOT_LENGTH + GAP_LENGTH;

const dashDotVertexShader = /* glsl */ `
  attribute float lineDistance;
  varying float vLineDistance;
  void main() {
    vLineDistance = lineDistance;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const dashDotFragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float dashLength;
  uniform float gapLength;
  uniform float dotLength;
  uniform float patternLength;
  varying float vLineDistance;
  void main() {
    float t = mod(vLineDistance, patternLength);
    if (t < dashLength) {
      // dash
    } else if (t < dashLength + gapLength) {
      discard;
    } else if (t < dashLength + gapLength + dotLength) {
      // dot
    } else {
      discard;
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;
const SNAP_INDICATOR_VERTEX_COLOR = 0xffc578;
const SNAP_INDICATOR_GRID_COLOR = 0x888888;
const CP_RADIUS = 2.5;
const CP_SEGMENTS = 16;
const SCALE_FACTOR = 0.003;
const MAX_SCALE = 1.5;
const CP_HIT_THRESHOLD_PX = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeViewScale(camera: Camera, position: Vector3, factor: number): number {
  if (camera instanceof OrthographicCamera) {
    const viewHeight = (camera.top - camera.bottom) / camera.zoom;
    return viewHeight * factor;
  } else if (camera instanceof PerspectiveCamera) {
    const dist = camera.position.distanceTo(position);
    const vFov = camera.fov * Math.PI / 180;
    const viewHeight = 2 * dist * Math.tan(vFov / 2);
    return viewHeight * factor;
  }
  return 1;
}

/** Convert a pixel threshold to sketch-plane units. */
function pixelToSketchThreshold(ctx: SceneContext): number {
  const camera = ctx.camera;
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  const canvasHeight = rect.height || 1;

  let worldHeight: number;
  const cam = camera as any;
  if (cam.isOrthographicCamera) {
    worldHeight = (cam.top - cam.bottom) / (cam.zoom || 1);
  } else {
    const target = new Vector3();
    ctx.cameraControls.getTarget(target);
    const d = camera.position.distanceTo(target);
    const fovRad = (cam.fov * Math.PI) / 180;
    worldHeight = 2 * d * Math.tan(fovRad / 2);
  }

  return (worldHeight / canvasHeight) * CP_HIT_THRESHOLD_PX;
}

/** Evaluate a bezier curve at parameter t using De Casteljau's algorithm. */
function deCasteljau(poles: [number, number][], t: number): [number, number] {
  let pts = poles.slice();
  while (pts.length > 1) {
    const next: [number, number][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push([
        (1 - t) * pts[i][0] + t * pts[i + 1][0],
        (1 - t) * pts[i][1] + t * pts[i + 1][1],
      ]);
    }
    pts = next;
  }
  return pts[0];
}

function localToWorld(point2d: [number, number], plane: PlaneData): Vector3 {
  const o = plane.origin;
  const x = plane.xDirection;
  const y = plane.yDirection;
  return new Vector3(
    o.x + x.x * point2d[0] + y.x * point2d[1],
    o.y + x.y * point2d[0] + y.y * point2d[1],
    o.z + x.z * point2d[0] + y.z * point2d[1],
  );
}

function dist2D(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// BezierDrawMode
// ---------------------------------------------------------------------------

export class BezierDrawMode {
  private canvas: HTMLCanvasElement;
  private ctx: SceneContext;
  private plane: PlaneData;
  snapController: SnapController;
  private onPick: (point2d: [number, number]) => void;
  private onSetPoints: ((points: [number, number][]) => void) | null;

  /** Existing poles from the scene (start + already-placed points). */
  private existingPoles: [number, number][] = [];
  /** Current mouse position on the sketch plane (2D). */
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';

  private downX = 0;
  private downY = 0;

  // ── Drag state ──
  /** Index into existingPoles of the pole being dragged, or -1 if not dragging. */
  private dragIndex = -1;
  /** Working copy of poles during drag (existingPoles with dragIndex overridden). */
  private dragPoles: [number, number][] | null = null;

  // Three.js preview objects
  private previewGroup: Group;
  private curveLineObj: Line | null = null;
  private polygonLineObj: LineSegments | null = null;
  private cpDots: Group[] = [];
  private snapIndicator: Group | null = null;

  private ctrlHeld = false;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    existingPoles: [number, number][],
    onPick: (point2d: [number, number]) => void,
    onSetPoints: ((points: [number, number][]) => void) | null = null,
  ) {
    this.canvas = ctx.renderer.domElement;
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.existingPoles = existingPoles;
    this.onPick = onPick;
    this.onSetPoints = onSetPoints;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 3;

    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
  }

  activate(): void {
    this.ctx.scene.add(this.previewGroup);
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    this.rebuildPreview();
  }

  deactivate(): void {
    this.endDrag();
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.ctx.scene.remove(this.previewGroup);
    this.disposePreview();
    this.ctx.requestRender();
  }

  updateExistingPoles(poles: [number, number][]): void {
    this.existingPoles = poles;
    if (this.dragIndex < 0) {
      this.rebuildPreview();
    }
  }

  // ── Drag helpers ────────────────────────────────────────────────────────

  /** Find the index of the nearest control point arg (skipping index 0 = start). */
  private hitTestControlPoint(point2d: [number, number]): number {
    const threshold = pixelToSketchThreshold(this.ctx);
    let bestIndex = -1;
    let bestDist = Infinity;
    // Skip index 0 (start point — not a user argument)
    for (let i = 1; i < this.existingPoles.length; i++) {
      const d = dist2D(point2d, this.existingPoles[i]);
      if (d < threshold && d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private startDrag(index: number): void {
    this.dragIndex = index;
    this.dragPoles = this.existingPoles.map(p => [p[0], p[1]] as [number, number]);
    this.ctx.cameraControls.enabled = false;
    this.canvas.style.cursor = 'grabbing';
  }

  private endDrag(): void {
    if (this.dragIndex < 0) {
      return;
    }
    this.dragIndex = -1;
    this.dragPoles = null;
    this.ctx.cameraControls.enabled = true;
    this.canvas.style.cursor = '';
  }

  private get isDragging(): boolean {
    return this.dragIndex >= 0;
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;

    // Ctrl+click near a control point → start drag
    if ((e.ctrlKey || e.metaKey) && this.onSetPoints) {
      const raw = this.projectToSketch(e.clientX, e.clientY);
      if (raw) {
        const hitIndex = this.hitTestControlPoint(raw);
        if (hitIndex >= 0) {
          e.preventDefault();
          e.stopPropagation();
          this.startDrag(hitIndex);
          return;
        }
      }
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (this.isDragging) {
      // Commit the drag
      if (this.dragPoles && this.onSetPoints) {
        const args = this.dragPoles.slice(1).map(
          p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100] as [number, number],
        );
        this.onSetPoints(args);
      }
      this.endDrag();
      return;
    }

    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return; // drag, not click
    }

    const raw = this.projectToSketch(e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    const rounded: [number, number] = [
      Math.round(result.point2d[0] * 100) / 100,
      Math.round(result.point2d[1] * 100) / 100,
    ];
    this.onPick(rounded);
  }

  private handleMouseMove(e: MouseEvent): void {
    const raw = this.projectToSketch(e.clientX, e.clientY);

    if (this.isDragging) {
      if (!raw || !this.dragPoles) {
        return;
      }
      const result = this.snapController.snap(raw);
      this.dragPoles[this.dragIndex] = result.point2d;
      this.lastSnapType = result.snapType;
      this.mousePoint = null;
      this.rebuildPreview();
      return;
    }

    if (!raw) {
      this.mousePoint = null;
      this.lastSnapType = 'none';
      this.canvas.style.cursor = '';
      this.rebuildPreview();
      return;
    }

    // Ctrl held: suppress next-point preview, show grab cursor near control points
    if (this.ctrlHeld) {
      if (this.hitTestControlPoint(raw) >= 0) {
        this.canvas.style.cursor = 'grab';
      } else {
        this.canvas.style.cursor = '';
      }
      if (this.mousePoint !== null) {
        this.mousePoint = null;
        this.lastSnapType = 'none';
        this.rebuildPreview();
      }
      return;
    }

    this.canvas.style.cursor = '';
    const result = this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;
    this.rebuildPreview();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if ((e.key === 'Control' || e.key === 'Meta') && !this.ctrlHeld) {
      this.ctrlHeld = true;
      if (!this.isDragging) {
        this.mousePoint = null;
        this.lastSnapType = 'none';
        this.rebuildPreview();
      }
    }

    if (e.key === 'Escape') {
      if (this.isDragging) {
        // Cancel drag — revert to original poles
        this.endDrag();
        this.rebuildPreview();
        return;
      }
      // Only undo if there are placed points (poles beyond the start point)
      if (this.existingPoles.length > 1 && this.onSetPoints) {
        e.preventDefault();
        const argsWithoutLast = this.existingPoles.slice(1, -1);
        this.onSetPoints(argsWithoutLast);
      }
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Control' || e.key === 'Meta') {
      this.ctrlHeld = false;
      this.canvas.style.cursor = '';
    }
  }

  // ── Preview rendering ───────────────────────────────────────────────────

  private disposePreview(): void {
    for (const child of [...this.previewGroup.children]) {
      this.previewGroup.remove(child);
      if ((child as any).geometry) {
        (child as any).geometry.dispose();
      }
      if ((child as any).material) {
        (child as any).material.dispose();
      }
    }
    this.curveLineObj = null;
    this.polygonLineObj = null;
    this.cpDots = [];
    this.snapIndicator = null;
  }

  private rebuildPreview(): void {
    this.disposePreview();

    // During drag, use the working copy; otherwise use existing + mouse preview
    let allPoles: [number, number][];
    if (this.isDragging && this.dragPoles) {
      allPoles = [...this.dragPoles];
    } else {
      allPoles = [...this.existingPoles];
      if (this.mousePoint) {
        allPoles.push(this.mousePoint);
      }
    }

    if (allPoles.length < 1) {
      this.ctx.requestRender();
      return;
    }

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    // ── Control polygon (thin lines connecting poles) ──
    if (allPoles.length >= 2) {
      const polyVerts = new Float32Array(allPoles.length * 3);
      const polyIndices: number[] = [];
      for (let i = 0; i < allPoles.length; i++) {
        const w = localToWorld(allPoles[i], this.plane);
        polyVerts[i * 3] = w.x;
        polyVerts[i * 3 + 1] = w.y;
        polyVerts[i * 3 + 2] = w.z;
        if (i > 0) {
          polyIndices.push(i - 1, i);
        }
      }
      const polyGeo = new BufferGeometry();
      polyGeo.setAttribute('position', new BufferAttribute(polyVerts, 3));
      polyGeo.setIndex(polyIndices);
      const polyMat = new LineBasicMaterial({
        color: GUIDE_COLOR_HEX,
        transparent: true,
        opacity: CONTROL_POLYGON_OPACITY,
        depthTest: false,
      });
      this.polygonLineObj = new LineSegments(polyGeo, polyMat);
      this.polygonLineObj.renderOrder = 3;
      this.previewGroup.add(this.polygonLineObj);
    }

    // ── Preview bezier curve ──
    if (allPoles.length >= 2) {
      const numSamples = CURVE_SAMPLES;
      const curveVerts = new Float32Array((numSamples + 1) * 3);
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const pt = deCasteljau(allPoles, t);
        const w = localToWorld(pt, this.plane);
        curveVerts[i * 3] = w.x;
        curveVerts[i * 3 + 1] = w.y;
        curveVerts[i * 3 + 2] = w.z;
      }
      const curveGeo = new BufferGeometry();
      curveGeo.setAttribute('position', new BufferAttribute(curveVerts, 3));

      const curveMat = new ShaderMaterial({
        uniforms: {
          color: { value: { ...GUIDE_COLOR } },
          dashLength: { value: DASH_LENGTH },
          gapLength: { value: GAP_LENGTH },
          dotLength: { value: DOT_LENGTH },
          patternLength: { value: PATTERN_LENGTH },
        },
        vertexShader: dashDotVertexShader,
        fragmentShader: dashDotFragmentShader,
        side: DoubleSide,
        transparent: true,
        depthTest: false,
      });

      this.curveLineObj = new Line(curveGeo, curveMat);
      this.curveLineObj.computeLineDistances();
      this.curveLineObj.renderOrder = 3;
      this.previewGroup.add(this.curveLineObj);
    }

    // ── Control point handles ──
    const cpGeo = new CircleGeometry(CP_RADIUS, CP_SEGMENTS);
    for (let i = 0; i < allPoles.length; i++) {
      const isStart = i === 0;
      const isHover = !this.isDragging && this.mousePoint && i === allPoles.length - 1;
      const isDragTarget = this.isDragging && i === this.dragIndex;

      let color = CONTROL_POINT_COLOR;
      if (isStart) {
        color = START_POINT_COLOR;
      }
      if (isHover) {
        color = CONTROL_POINT_HOVER_COLOR;
      }
      if (isDragTarget) {
        color = CONTROL_POINT_DRAG_COLOR;
      }

      const cpMat = new MeshBasicMaterial({
        color,
        side: DoubleSide,
        depthTest: false,
      });
      const dot = new Mesh(cpGeo, cpMat);
      dot.renderOrder = 4;

      const dotGroup = new Group();
      dotGroup.renderOrder = 4;
      const pos = localToWorld(allPoles[i], this.plane);
      dotGroup.position.copy(pos);
      dotGroup.lookAt(pos.clone().add(planeNormal));
      dotGroup.scale.setScalar(Math.min(computeViewScale(camera, pos, SCALE_FACTOR), MAX_SCALE));

      dot.onBeforeRender = (_r, _s, cam) => {
        dotGroup.scale.setScalar(Math.min(computeViewScale(cam, pos, SCALE_FACTOR), MAX_SCALE));
        dotGroup.updateMatrixWorld(true);
      };

      dotGroup.add(dot);
      this.previewGroup.add(dotGroup);
      this.cpDots.push(dotGroup);
    }

    // ── Snap indicator ──
    const snapPoint = this.isDragging
      ? (this.dragPoles ? this.dragPoles[this.dragIndex] : null)
      : this.mousePoint;
    if (snapPoint && this.lastSnapType !== 'none') {
      const indicatorColor = this.lastSnapType === 'vertex'
        ? SNAP_INDICATOR_VERTEX_COLOR
        : SNAP_INDICATOR_GRID_COLOR;
      const indicatorGeo = new CircleGeometry(CP_RADIUS * 1.6, CP_SEGMENTS);
      const indicatorMat = new MeshBasicMaterial({
        color: indicatorColor,
        side: DoubleSide,
        depthTest: false,
        transparent: true,
        opacity: 0.6,
      });
      const indicatorMesh = new Mesh(indicatorGeo, indicatorMat);
      indicatorMesh.renderOrder = 5;

      this.snapIndicator = new Group();
      this.snapIndicator.renderOrder = 5;
      const pos = localToWorld(snapPoint, this.plane);
      this.snapIndicator.position.copy(pos);
      this.snapIndicator.lookAt(pos.clone().add(planeNormal));
      this.snapIndicator.scale.setScalar(Math.min(computeViewScale(camera, pos, SCALE_FACTOR), MAX_SCALE));

      indicatorMesh.onBeforeRender = (_r, _s, cam) => {
        this.snapIndicator!.scale.setScalar(Math.min(computeViewScale(cam, pos, SCALE_FACTOR), MAX_SCALE));
        this.snapIndicator!.updateMatrixWorld(true);
      };

      this.snapIndicator.add(indicatorMesh);
      this.previewGroup.add(this.snapIndicator);
    }

    this.ctx.requestRender();
  }

  // ── Projection ──────────────────────────────────────────────────────────

  private projectToSketch(clientX: number, clientY: number): [number, number] | null {
    const renderer = this.ctx.renderer;
    const camera = this.ctx.camera;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);

    const rayOrigin = raycaster.ray.origin;
    const rayDir = raycaster.ray.direction;

    const planeOrigin = new Vector3(this.plane.origin.x, this.plane.origin.y, this.plane.origin.z);
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    const denom = rayDir.dot(planeNormal);
    if (Math.abs(denom) < 1e-6) {
      return null;
    }

    const t = planeOrigin.clone().sub(rayOrigin).dot(planeNormal) / denom;
    if (t < 0) {
      return null;
    }

    const worldPoint = rayOrigin.clone().add(rayDir.clone().multiplyScalar(t));

    const rel = worldPoint.clone().sub(planeOrigin);
    const xDir = new Vector3(this.plane.xDirection.x, this.plane.xDirection.y, this.plane.xDirection.z);
    const yDir = new Vector3(this.plane.yDirection.x, this.plane.yDirection.y, this.plane.yDirection.z);

    return [rel.dot(xDir), rel.dot(yDir)];
  }
}
