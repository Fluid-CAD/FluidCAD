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
    this.el = document.createElement('div');
    this.el.className = 'absolute bottom-[22px] right-16 w-[200px] panel-bg border border-base-content/10 rounded-lg p-3 z-[150] shadow-[0_4px_24px_rgba(0,0,0,0.5)] text-base-content text-xs pointer-events-none select-none hidden';
    container.appendChild(this.el);
  }

  async showForFace(shapeId: string, faceIndex: number): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.el.innerHTML = '<div class="text-base-content/50 text-[11px] text-center py-1">Loading\u2026</div>';
    this.el.classList.remove('hidden');

    try {
      const res = await fetch(
        `/api/face-properties?shapeId=${encodeURIComponent(shapeId)}&faceIndex=${faceIndex}`,
        { signal: this.abortController.signal },
      );
      if (!res.ok) {
        this.el.classList.add('hidden');
        return;
      }
      const props: FaceProperties = await res.json();
      this.renderFace(props);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        this.el.classList.add('hidden');
      }
    }
  }

  async showForEdge(shapeId: string, edgeIndex: number): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.el.innerHTML = '<div class="text-base-content/50 text-[11px] text-center py-1">Loading\u2026</div>';
    this.el.classList.remove('hidden');

    try {
      const res = await fetch(
        `/api/edge-properties?shapeId=${encodeURIComponent(shapeId)}&edgeIndex=${edgeIndex}`,
        { signal: this.abortController.signal },
      );
      if (!res.ok) {
        this.el.classList.add('hidden');
        return;
      }
      const props: EdgeProperties = await res.json();
      this.renderEdge(props);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        this.el.classList.add('hidden');
      }
    }
  }

  hide(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.el.classList.add('hidden');
  }

  private renderFace(props: FaceProperties): void {
    const badge = SURFACE_LABELS[props.surfaceType] ?? 'Surface';
    const rows: { label: string; value: string }[] = [];

    if (props.surfaceType === 'plane' && props.areaMm2 != null) {
      rows.push({ label: 'Area', value: `${props.areaMm2.toFixed(4)} mm\u00B2` });
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
      rows.push({ label: 'Half-angle', value: `${props.halfAngleDeg.toFixed(2)}\u00B0` });
    } else if (props.areaMm2 != null) {
      rows.push({ label: 'Area', value: `${props.areaMm2.toFixed(4)} mm\u00B2` });
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
      .map(r => `<div class="flex justify-between items-baseline py-0.5"><span class="text-base-content/50 text-[11px]">${r.label}</span><span class="text-base-content/90 text-xs font-medium">${r.value}</span></div>`)
      .join('');

    this.el.innerHTML = `<div class="badge badge-primary badge-outline badge-sm mb-2">${badge}</div>${rowsHtml}`;
    this.el.classList.remove('hidden');
  }
}
