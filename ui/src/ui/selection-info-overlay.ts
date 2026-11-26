import type { FaceProperties, EdgeProperties } from '../api';
import type { EngineClient } from '../engine-client';
import { formatArea, formatLength } from '../units/units';
import { sceneUnit } from '../units/scene-unit';
import { bottomRightRow, BOTTOM_RIGHT_ORDER } from './bottom-right-row';

const SURFACE_LABELS: Record<FaceProperties['surfaceType'], string> = {
  plane: 'Plane',
  circle: 'Circle',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  torus: 'Torus',
  cone: 'Cone',
  revolved: 'Revolved surface',
  extruded: 'Extruded surface',
  freeform: 'Free-form surface',
};

const CURVE_LABELS: Record<EdgeProperties['curveType'], string> = {
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
  ellipse: 'Ellipse',
  spline: 'Spline',
  other: 'Curve',
};

/**
 * An edge's kind as the panel names it: a full ellipse, a closed spline or
 * curve reads "(closed)" after its kind. A circle always is, and a line or
 * an arc never.
 */
function curveLabel(props: EdgeProperties): string {
  const label = CURVE_LABELS[props.curveType] ?? 'Curve';
  const closable = props.curveType === 'ellipse' || props.curveType === 'spline' || props.curveType === 'other';
  return closable && props.closed ? `${label} (closed)` : label;
}

export class SelectionInfoOverlay {
  private el: HTMLDivElement;
  private abortController: AbortController | null = null;

  constructor(container: HTMLElement, private client: EngineClient) {
    this.el = document.createElement('div');
    // Leftmost member of the shared bottom-right row, beside the chips.
    this.el.className = `w-[200px] panel-bg border border-base-content/10 rounded-lg p-3 shadow-[0_4px_24px_rgba(0,0,0,0.5)] text-base-content text-xs pointer-events-none select-none hidden ${BOTTOM_RIGHT_ORDER.selectionInfo}`;
    bottomRightRow(container).appendChild(this.el);
  }

  async showForFace(shapeId: string, faceIndex: number): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.el.innerHTML = '<div class="text-base-content/50 text-[11px] text-center py-1">Loading\u2026</div>';
    this.el.classList.remove('hidden');

    const signal = this.abortController.signal;
    const props = await this.client.getFaceProperties(shapeId, faceIndex, signal);
    if (!props) {
      if (!signal.aborted) {
        this.el.classList.add('hidden');
      }
      return;
    }
    this.renderFace(props);
  }

  async showForEdge(shapeId: string, edgeIndex: number): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.el.innerHTML = '<div class="text-base-content/50 text-[11px] text-center py-1">Loading\u2026</div>';
    this.el.classList.remove('hidden');

    const signal = this.abortController.signal;
    const props = await this.client.getEdgeProperties(shapeId, edgeIndex, signal);
    if (!props) {
      if (!signal.aborted) {
        this.el.classList.add('hidden');
      }
      return;
    }
    this.renderEdge(props);
  }

  hide(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.el.classList.add('hidden');
  }

  private renderFace(props: FaceProperties): void {
    const shape = SelectionInfoOverlay.faceShapeRows(props);
    // A face of a surface reads as the surface it belongs to: the material a
    // surface has is its area, so the whole surface's leads.
    if (props.owner?.kind === 'surface') {
      const rows = [{ label: 'Area', value: formatArea(props.owner.area, sceneUnit.current) }];
      const kind = SURFACE_LABELS[props.surfaceType];
      if (kind) {
        rows.push({ label: 'Face', value: kind });
      }
      this.renderPanel('Surface', [...rows, ...shape]);
      return;
    }
    const rows = shape.length > 0 || props.areaMm2 == null
      ? shape
      : [{ label: 'Area', value: formatArea(props.areaMm2, sceneUnit.current) }];
    this.renderPanel(SURFACE_LABELS[props.surfaceType] ?? 'Surface', rows);
  }

  private renderEdge(props: EdgeProperties): void {
    const shape = SelectionInfoOverlay.edgeShapeRows(props);
    // An edge of a curve reads as the curve it belongs to, by its length.
    if (props.owner?.kind === 'curve') {
      const rows = [{ label: 'Length', value: formatLength(props.owner.length, sceneUnit.current) }];
      if (props.curveType !== 'other' || props.closed) {
        rows.push({ label: 'Edge', value: curveLabel(props) });
      }
      this.renderPanel('Curve', [...rows, ...shape]);
      return;
    }
    // A full circle and an ellipse read by their radii; every other edge by
    // its length as well.
    const length = props.curveType !== 'circle' && props.curveType !== 'ellipse' && props.length != null
      ? [{ label: 'Length', value: formatLength(props.length, sceneUnit.current) }]
      : [];
    this.renderPanel(curveLabel(props), [...shape, ...length]);
  }

  /** What sets a face's shape: its radius, radii or half-angle; none for a plane or a freeform face. */
  private static faceShapeRows(props: FaceProperties): { label: string; value: string }[] {
    const rows: { label: string; value: string }[] = [];
    if ((props.surfaceType === 'circle' || props.surfaceType === 'cylinder' || props.surfaceType === 'sphere') && props.radius != null) {
      rows.push({ label: 'Radius', value: formatLength(props.radius, sceneUnit.current) });
    } else if (props.surfaceType === 'torus') {
      if (props.majorRadius != null) {
        rows.push({ label: 'Major R', value: formatLength(props.majorRadius, sceneUnit.current) });
      }
      if (props.minorRadius != null) {
        rows.push({ label: 'Minor R', value: formatLength(props.minorRadius, sceneUnit.current) });
      }
    } else if (props.surfaceType === 'cone' && props.halfAngleDeg != null) {
      rows.push({ label: 'Half-angle', value: `${props.halfAngleDeg.toFixed(2)}\u00B0` });
    }
    return rows;
  }

  /** What sets an edge's shape: an arc's or a circle's radius, an ellipse's radii; none for a line or a freeform edge. */
  private static edgeShapeRows(props: EdgeProperties): { label: string; value: string }[] {
    const rows: { label: string; value: string }[] = [];
    if ((props.curveType === 'circle' || props.curveType === 'arc') && props.radius != null) {
      rows.push({ label: 'Radius', value: formatLength(props.radius, sceneUnit.current) });
    } else if (props.curveType === 'ellipse') {
      if (props.majorRadius != null) {
        rows.push({ label: 'Major R', value: formatLength(props.majorRadius, sceneUnit.current) });
      }
      if (props.minorRadius != null) {
        rows.push({ label: 'Minor R', value: formatLength(props.minorRadius, sceneUnit.current) });
      }
    }
    return rows;
  }

  private renderPanel(badge: string, rows: { label: string; value: string }[]): void {
    const rowsHtml = rows
      .map(r => `<div class="flex justify-between items-baseline py-0.5"><span class="text-base-content/50 text-[11px]">${r.label}</span><span class="text-base-content/90 text-xs font-medium">${r.value}</span></div>`)
      .join('');

    const hint = '<div class="text-[10px] text-base-content/40 mt-1.5 pt-1.5 border-t border-base-content/10">Ctrl+click another face/edge to measure</div>';
    this.el.innerHTML = `<div class="badge badge-primary badge-outline badge-sm mb-2">${badge}</div>${rowsHtml}${hint}`;
    this.el.classList.remove('hidden');
  }
}
