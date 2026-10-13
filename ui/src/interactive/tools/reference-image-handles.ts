import {
  BufferGeometry,
  CircleGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import type { PlaneData } from '../../types';
import { localToWorld } from '../sketch-plane-utils';
import { themeColors } from '../../scene/theme-colors';
import { applyConstantPixelSize } from '../../meshes/screen-scale';
import { createPointMarker } from '../../meshes/point-marker';
import { createDashedPolyline } from './tool-preview-utils';
import { CORNERS, ReferenceImageFrame, type CornerId, type FrameHit, type Point2 } from './reference-image-frame';

/** Handle sizes on screen. */
export const HANDLE_PX = 9;
export const KNOB_PX = 12;
export const STEM_PX = 28;
export const CALIBRATION_DOT_PX = 8;
const RENDER_ORDER = 5;
/** Geometry unit the pixel-constant markers are authored at; only the order of magnitude matters. */
const MARKER_UNITS = 1;

/**
 * The on-screen frame of the picture while the Image tool is active: an
 * outline on its edges, a square at each corner (resize), a knob on a stem
 * above the top edge (rotate), and the calibration points and their line
 * while a distance is being taken. Rebuilt from the frame on every change;
 * squares, knob and dots keep their pixel size through zoom.
 */
export class ReferenceImageHandles {
  readonly group: Group;
  private hovered: FrameHit | null = null;
  private corners = new Map<CornerId, Mesh>();
  private knob: Mesh | null = null;
  private plane: PlaneData;

  constructor(plane: PlaneData) {
    this.plane = plane;
    this.group = new Group();
    this.group.userData.isMetaShape = true;
    this.group.renderOrder = RENDER_ORDER;
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  /** Redraw for `frame`; `stem` is the knob's distance above the top edge in sketch units. */
  rebuild(frame: ReferenceImageFrame | null, stem: number, calibration: Point2[] = []): void {
    this.clear();
    if (frame) {
      this.addOutline(frame);
      this.addCorners(frame);
      this.addKnob(frame, stem);
    }
    this.addCalibration(calibration);
    this.applyHover();
  }

  /** Tint the handle under the pointer. */
  setHover(hit: FrameHit | null): void {
    this.hovered = hit;
    this.applyHover();
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((node) => {
        const obj = node as { geometry?: { dispose(): void }; material?: { dispose(): void } };
        obj.geometry?.dispose();
        obj.material?.dispose();
      });
    }
    this.corners.clear();
    this.knob = null;
  }

  private world(p: Point2): Vector3 {
    return localToWorld(p, this.plane);
  }

  private normal(): Vector3 {
    return new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z).normalize();
  }

  private addOutline(frame: ReferenceImageFrame): void {
    const geometry = new BufferGeometry().setFromPoints(CORNERS.map((c) => this.world(frame.corner(c))));
    const material = new LineBasicMaterial({ color: themeColors.imageHandleColor, transparent: true, opacity: 0.9, depthTest: false });
    const loop = new LineLoop(geometry, material);
    loop.renderOrder = RENDER_ORDER;
    this.group.add(loop);
  }

  private addCorners(frame: ReferenceImageFrame): void {
    for (const id of CORNERS) {
      const square = this.square(frame.corner(id), HANDLE_PX, frame.spec.angle);
      this.corners.set(id, square.children[0] as Mesh);
      this.group.add(square);
    }
  }

  private addKnob(frame: ReferenceImageFrame, stem: number): void {
    const from = this.world(frame.topCenter());
    const to = this.world(frame.rotateKnob(stem));
    const stemLine = new Line(
      new BufferGeometry().setFromPoints([from, to]),
      new LineBasicMaterial({ color: themeColors.imageHandleColor, transparent: true, opacity: 0.9, depthTest: false }),
    );
    stemLine.renderOrder = RENDER_ORDER;
    this.group.add(stemLine);

    const wrapper = new Group();
    const knob = new Mesh(
      new CircleGeometry(MARKER_UNITS / 2, 24),
      new MeshBasicMaterial({ color: themeColors.imageHandleColor, depthTest: false, transparent: true, opacity: 1 }),
    );
    knob.renderOrder = RENDER_ORDER;
    const ring = new Mesh(
      new CircleGeometry(MARKER_UNITS * 0.34, 24),
      new MeshBasicMaterial({ color: themeColors.backgroundColor, depthTest: false }),
    );
    ring.renderOrder = RENDER_ORDER + 0.5;
    wrapper.add(knob, ring);
    wrapper.position.copy(to);
    wrapper.lookAt(to.clone().add(this.normal()));
    applyConstantPixelSize(knob, wrapper, wrapper.position, KNOB_PX, MARKER_UNITS);
    this.knob = knob;
    this.group.add(wrapper);
  }

  private addCalibration(points: Point2[]): void {
    if (points.length === 2) {
      const a = this.world(points[0]);
      const b = this.world(points[1]);
      this.group.add(createDashedPolyline(new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]), RENDER_ORDER, themeColors.imageHandleHoverColor.getHex()));
    }
    for (const p of points) {
      this.group.add(createPointMarker(this.world(p), themeColors.imageHandleHoverColor.getHex(), {
        radius: MARKER_UNITS, segments: 16, pixelRadius: CALIBRATION_DOT_PX, opacity: 1, renderOrder: RENDER_ORDER + 1, normal: this.normal(),
      }));
    }
  }

  /** A pixel-sized square marker, turned with the picture so it sits on its corner squarely. */
  private square(at: Point2, px: number, angleDeg: number): Group {
    const wrapper = new Group();
    const mesh = new Mesh(
      new PlaneGeometry(MARKER_UNITS, MARKER_UNITS),
      new MeshBasicMaterial({ color: themeColors.imageHandleColor, depthTest: false, transparent: true, opacity: 1 }),
    );
    mesh.renderOrder = RENDER_ORDER;
    const border = new LineLoop(
      new BufferGeometry().setFromPoints([
        new Vector3(-MARKER_UNITS / 2, -MARKER_UNITS / 2, 0), new Vector3(MARKER_UNITS / 2, -MARKER_UNITS / 2, 0),
        new Vector3(MARKER_UNITS / 2, MARKER_UNITS / 2, 0), new Vector3(-MARKER_UNITS / 2, MARKER_UNITS / 2, 0),
      ]),
      new LineBasicMaterial({ color: themeColors.backgroundColor, depthTest: false }),
    );
    border.renderOrder = RENDER_ORDER + 0.5;
    wrapper.add(mesh, border);
    const position = this.world(at);
    wrapper.position.copy(position);
    wrapper.lookAt(position.clone().add(this.normal()));
    wrapper.rotateZ((angleDeg * Math.PI) / 180);
    applyConstantPixelSize(mesh, wrapper, wrapper.position, px, MARKER_UNITS);
    return wrapper;
  }

  private applyHover(): void {
    const hot = themeColors.imageHandleHoverColor;
    for (const [id, mesh] of this.corners) {
      const over = this.hovered?.part === 'corner' && this.hovered.corner === id;
      (mesh.material as MeshBasicMaterial).color.copy(over ? hot : themeColors.imageHandleColor);
    }
    if (this.knob) {
      (this.knob.material as MeshBasicMaterial).color.copy(this.hovered?.part === 'rotate' ? hot : themeColors.imageHandleColor);
    }
  }
}
