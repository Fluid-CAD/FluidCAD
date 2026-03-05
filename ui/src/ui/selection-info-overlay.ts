const STYLES = `
.fio-overlay {
  position: absolute;
  bottom: 22px;
  right: 64px;
  width: 200px;
  background: rgba(30, 30, 30, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px 14px;
  z-index: 150;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  color: #d4d4d4;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 12px;
  display: none;
  pointer-events: none;
  user-select: none;
}

.fio-overlay.visible {
  display: block;
}

.fio-badge {
  display: inline-block;
  background: rgba(74, 158, 255, 0.2);
  color: #4a9eff;
  border: 1px solid rgba(74, 158, 255, 0.35);
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
  margin-bottom: 8px;
  letter-spacing: 0.03em;
}

.fio-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 2px 0;
}

.fio-label {
  color: #888;
  font-size: 11px;
}

.fio-value {
  color: #e0e0e0;
  font-size: 12px;
  font-weight: 500;
}

.fio-loading {
  color: #888;
  font-size: 11px;
  text-align: center;
  padding: 4px 0;
}
`;

type FaceProperties = {
  surfaceType: 'plane' | 'circle' | 'cylinder' | 'sphere' | 'torus' | 'cone' | 'other';
  areaMm2?: number;
  radius?: number;
  majorRadius?: number;
  minorRadius?: number;
  halfAngleDeg?: number;
};

type EdgeProperties = {
  curveType: 'line' | 'circle' | 'arc' | 'ellipse' | 'other';
  length?: number;
  radius?: number;
  majorRadius?: number;
  minorRadius?: number;
};

const SURFACE_LABELS: Record<FaceProperties['surfaceType'], string> = {
  plane: 'Plane',
  circle: 'Circle',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  torus: 'Torus',
  cone: 'Cone',
  other: 'Surface',
};

const CURVE_LABELS: Record<EdgeProperties['curveType'], string> = {
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
  ellipse: 'Ellipse',
  other: 'Curve',
};

export class SelectionInfoOverlay {
  private el: HTMLDivElement;
  private abortController: AbortController | null = null;

  constructor(container: HTMLElement) {
    if (!document.getElementById('fio-styles')) {
      const style = document.createElement('style');
      style.id = 'fio-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    this.el = document.createElement('div');
    this.el.className = 'fio-overlay';
    container.appendChild(this.el);
  }

  async showForFace(shapeId: string, faceIndex: number): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.el.innerHTML = '<div class="fio-loading">Loading…</div>';
    this.el.classList.add('visible');

    try {
      const res = await fetch(
        `/api/face-properties?shapeId=${encodeURIComponent(shapeId)}&faceIndex=${faceIndex}`,
        { signal: this.abortController.signal },
      );
      if (!res.ok) {
        this.el.classList.remove('visible');
        return;
      }
      const props: FaceProperties = await res.json();
      this.renderFace(props);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        this.el.classList.remove('visible');
      }
    }
  }

  async showForEdge(shapeId: string, edgeIndex: number): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.el.innerHTML = '<div class="fio-loading">Loading…</div>';
    this.el.classList.add('visible');

    try {
      const res = await fetch(
        `/api/edge-properties?shapeId=${encodeURIComponent(shapeId)}&edgeIndex=${edgeIndex}`,
        { signal: this.abortController.signal },
      );
      if (!res.ok) {
        this.el.classList.remove('visible');
        return;
      }
      const props: EdgeProperties = await res.json();
      this.renderEdge(props);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        this.el.classList.remove('visible');
      }
    }
  }

  hide(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.el.classList.remove('visible');
  }

  private renderFace(props: FaceProperties): void {
    const badge = SURFACE_LABELS[props.surfaceType] ?? 'Surface';
    const rows: { label: string; value: string }[] = [];

    if (props.surfaceType === 'plane' && props.areaMm2 != null) {
      rows.push({ label: 'Area', value: `${props.areaMm2.toFixed(4)} mm²` });
    } else if (props.surfaceType === 'circle' && props.radius != null) {
      rows.push({ label: 'Radius', value: `${props.radius.toFixed(4)} mm` });
    } else if (props.surfaceType === 'cylinder' && props.radius != null) {
      rows.push({ label: 'Radius', value: `${props.radius.toFixed(4)} mm` });
    } else if (props.surfaceType === 'sphere' && props.radius != null) {
      rows.push({ label: 'Radius', value: `${props.radius.toFixed(4)} mm` });
    } else if (props.surfaceType === 'torus') {
      if (props.majorRadius != null) {
        rows.push({ label: 'Major R', value: `${props.majorRadius.toFixed(4)} mm` });
      }
      if (props.minorRadius != null) {
        rows.push({ label: 'Minor R', value: `${props.minorRadius.toFixed(4)} mm` });
      }
    } else if (props.surfaceType === 'cone' && props.halfAngleDeg != null) {
      rows.push({ label: 'Half-angle', value: `${props.halfAngleDeg.toFixed(2)}°` });
    } else if (props.areaMm2 != null) {
      rows.push({ label: 'Area', value: `${props.areaMm2.toFixed(4)} mm²` });
    }

    this.renderPanel(badge, rows);
  }

  private renderEdge(props: EdgeProperties): void {
    const badge = CURVE_LABELS[props.curveType] ?? 'Curve';
    const rows: { label: string; value: string }[] = [];

    if (props.curveType === 'line') {
      if (props.length != null) {
        rows.push({ label: 'Length', value: `${props.length.toFixed(4)} mm` });
      }
    } else if (props.curveType === 'circle') {
      if (props.radius != null) {
        rows.push({ label: 'Radius', value: `${props.radius.toFixed(4)} mm` });
      }
    } else if (props.curveType === 'arc') {
      if (props.radius != null) {
        rows.push({ label: 'Radius', value: `${props.radius.toFixed(4)} mm` });
      }
      if (props.length != null) {
        rows.push({ label: 'Length', value: `${props.length.toFixed(4)} mm` });
      }
    } else if (props.curveType === 'ellipse') {
      if (props.majorRadius != null) {
        rows.push({ label: 'Major R', value: `${props.majorRadius.toFixed(4)} mm` });
      }
      if (props.minorRadius != null) {
        rows.push({ label: 'Minor R', value: `${props.minorRadius.toFixed(4)} mm` });
      }
    } else {
      if (props.length != null) {
        rows.push({ label: 'Length', value: `${props.length.toFixed(4)} mm` });
      }
    }

    this.renderPanel(badge, rows);
  }

  private renderPanel(badge: string, rows: { label: string; value: string }[]): void {
    const rowsHtml = rows
      .map(r => `<div class="fio-row"><span class="fio-label">${r.label}</span><span class="fio-value">${r.value}</span></div>`)
      .join('');

    this.el.innerHTML = `<div class="fio-badge">${badge}</div>${rowsHtml}`;
    this.el.classList.add('visible');
  }
}
