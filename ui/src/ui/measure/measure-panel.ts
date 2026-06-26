import type { MeasureDistanceValue, MeasureEntityInfo, MeasureEntityRef, MeasureResult } from '../../api';
import { ICON_CLOSE } from '../icons';
import { ANGLE_UNITS, LENGTH_UNITS, formatAngle, formatArea, formatLength } from './format';
import type { AngleUnit, LengthUnit } from './format';
import type { MeasureAxis, MeasureViz } from './measure-overlay';

export type MeasurePanelData = {
  entities: { ref: MeasureEntityRef; label: string }[];
  result: MeasureResult | null;
  lengthUnit: LengthUnit;
  angleUnit: AngleUnit;
};

export type MeasurePanelCallbacks = {
  onClose: () => void;
  onRemoveEntity: (ref: MeasureEntityRef) => void;
  onLengthUnitChange: (unit: LengthUnit) => void;
  onAngleUnitChange: (unit: AngleUnit) => void;
  onHoverViz: (viz: MeasureViz | null) => void;
};

const GEOM_LABELS: Record<string, string> = {
  plane: 'Plane face',
  cylinder: 'Cylindrical face',
  cone: 'Conical face',
  sphere: 'Spherical face',
  torus: 'Toroidal face',
  surface: 'Face',
  line: 'Line edge',
  circle: 'Circle edge',
  arc: 'Arc edge',
  ellipse: 'Ellipse edge',
  curve: 'Edge',
};

const DIST_KEYS: { key: 'parallelDist' | 'centerDist' | 'axisDist' | 'minDist' | 'maxDist'; label: string }[] = [
  { key: 'parallelDist', label: 'Parallel dist' },
  { key: 'centerDist', label: 'Center dist' },
  { key: 'axisDist', label: 'Axis dist' },
  { key: 'minDist', label: 'Min dist' },
  { key: 'maxDist', label: 'Max dist' },
];

const AXES: { axis: MeasureAxis; cls: string }[] = [
  { axis: 'x', cls: 'text-error' },
  { axis: 'y', cls: 'text-success' },
  { axis: 'z', cls: 'text-info' },
];

function esc(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Expanded Onshape-style measure dialog: selected entity chips, unit
 * selectors, and every applicable measurement with hoverable X/Y/Z
 * decompositions.
 */
export class MeasurePanel {
  private el: HTMLDivElement;
  private data: MeasurePanelData = { entities: [], result: null, lengthUnit: 'mm', angleUnit: 'deg' };

  constructor(container: HTMLElement, private callbacks: MeasurePanelCallbacks) {
    this.el = document.createElement('div');
    this.el.className =
      'absolute bottom-[64px] right-[76px] z-[150] w-[290px] panel-bg border border-base-content/10 rounded-lg p-3 ' +
      'shadow-[0_4px_24px_rgba(0,0,0,0.5)] text-xs text-base-content select-none max-h-[70vh] overflow-y-auto hidden';
    container.appendChild(this.el);
  }

  get isVisible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  setVisible(visible: boolean): void {
    this.el.classList.toggle('hidden', !visible);
  }

  update(data: MeasurePanelData): void {
    this.data = data;
    this.render();
  }

  private render(): void {
    const { entities, result } = this.data;

    const chips = entities.length
      ? entities
          .map(
            (entity, i) =>
              `<div class="flex items-center justify-between gap-1 px-2 py-1 border-b border-base-content/10 last:border-0">
                <span class="truncate">${esc(entity.label)}</span>
                <button data-remove="${i}" title="Remove" class="btn btn-ghost btn-xs btn-square shrink-0 opacity-60 hover:opacity-100 [&>svg]:w-3 [&>svg]:h-3">${ICON_CLOSE}</button>
              </div>`,
          )
          .join('')
      : '<div class="px-2 py-2 text-base-content/50">Click faces or edges in the viewport to measure</div>';

    const lengthOptions = LENGTH_UNITS.map(
      (u) => `<option value="${u.value}" ${u.value === this.data.lengthUnit ? 'selected' : ''}>${u.label}</option>`,
    ).join('');
    const angleOptions = ANGLE_UNITS.map(
      (u) => `<option value="${u.value}" ${u.value === this.data.angleUnit ? 'selected' : ''}>${u.label}</option>`,
    ).join('');

    this.el.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-semibold">Measure</span>
        <button data-close title="Close" class="btn btn-ghost btn-xs btn-square opacity-60 hover:opacity-100 [&>svg]:w-4 [&>svg]:h-4">${ICON_CLOSE}</button>
      </div>
      <div class="border border-base-content/15 rounded-md mb-2 max-h-28 overflow-y-auto">${chips}</div>
      <div class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 mb-2">
        <span class="text-base-content/60">Length unit</span>
        <select data-length-unit class="select select-xs w-full bg-base-200 border-base-content/15">${lengthOptions}</select>
        <span class="text-base-content/60">Angle unit</span>
        <select data-angle-unit class="select select-xs w-full bg-base-200 border-base-content/15">${angleOptions}</select>
      </div>
      ${result ? `<div class="border-t border-base-content/10 pt-2">${this.renderRows(result)}</div>` : ''}
    `;

    this.bindEvents();
  }

  private renderRows(result: MeasureResult): string {
    const rows: string[] = [];
    const entityCount = this.data.entities.length;

    if (entityCount === 1 && result.entities.length === 1) {
      rows.push(this.renderEntityDetails(result.entities[0]));
    }

    const isPair = result.entities.length === 2;
    if (isPair) {
      if (result.primary === 'angle' && result.angleDeg !== undefined) {
        rows.push(this.row(esc(result.angleLabel ?? 'Angle'), formatAngle(result.angleDeg, this.data.angleUnit)));
      } else {
        const primaryDist = DIST_KEYS.find((d) => d.key === result.primary);
        if (primaryDist && result[primaryDist.key]) {
          rows.push(this.distanceRows(primaryDist.key, primaryDist.label, result[primaryDist.key]!));
        }
        if (result.angleDeg !== undefined) {
          rows.push(this.row(esc(result.angleLabel ?? 'Angle'), formatAngle(result.angleDeg, this.data.angleUnit)));
        }
      }
    }

    const faceCount = result.entities.filter((e) => e.ref.kind === 'face').length;
    const edgeCount = result.entities.filter((e) => e.ref.kind === 'edge').length;
    if (result.totalArea !== undefined) {
      rows.push(this.row(faceCount > 1 ? 'Total area' : 'Area', formatArea(result.totalArea, this.data.lengthUnit)));
    }
    if (result.totalLength !== undefined) {
      rows.push(this.row(edgeCount > 1 ? 'Total length' : 'Length', formatLength(result.totalLength, this.data.lengthUnit)));
    }

    if (isPair) {
      for (const { key, label } of DIST_KEYS) {
        if (key === result.primary) {
          continue;
        }
        const value = result[key];
        if (value) {
          rows.push(this.distanceRows(key, label, value));
        }
      }
    }

    return rows.join('');
  }

  private renderEntityDetails(info: MeasureEntityInfo): string {
    const rows: string[] = [this.row('Type', GEOM_LABELS[info.geomType] ?? info.geomType)];
    if (info.area !== undefined) {
      rows.push(this.row('Area', formatArea(info.area, this.data.lengthUnit)));
    }
    if (info.radius !== undefined) {
      rows.push(this.row('Radius', formatLength(info.radius, this.data.lengthUnit)));
      rows.push(this.row('Diameter', formatLength(info.radius * 2, this.data.lengthUnit)));
    }
    return rows.join('');
  }

  private row(label: string, value: string): string {
    return `<div class="flex justify-between items-baseline gap-2 px-1 py-0.5 rounded">
      <span class="text-base-content/60">${label}</span>
      <span class="font-medium tabular-nums">${value}</span>
    </div>`;
  }

  private distanceRows(key: string, label: string, dist: MeasureDistanceValue): string {
    const main = `<div data-viz="${key}" class="flex justify-between items-baseline gap-2 px-1 py-0.5 rounded hover:bg-base-content/10 cursor-default">
      <span class="text-base-content/60">${label}</span>
      <span class="font-medium tabular-nums">${formatLength(dist.value, this.data.lengthUnit)}</span>
    </div>`;

    const subs = AXES.map(({ axis, cls }) => {
      const component = dist.to[axis] - dist.from[axis];
      return `<div data-viz="${key}:${axis}" class="flex justify-between items-baseline gap-2 pl-5 pr-1 py-0.5 rounded hover:bg-base-content/10 cursor-default">
        <span class="${cls} font-semibold">${axis.toUpperCase()}</span>
        <span class="tabular-nums text-base-content/90">${formatLength(component, this.data.lengthUnit)}</span>
      </div>`;
    }).join('');

    return main + subs;
  }

  private bindEvents(): void {
    this.el.querySelector('[data-close]')?.addEventListener('click', () => this.callbacks.onClose());

    this.el.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.remove!, 10);
        const entity = this.data.entities[index];
        if (entity) {
          this.callbacks.onRemoveEntity(entity.ref);
        }
      });
    });

    this.el.querySelector<HTMLSelectElement>('[data-length-unit]')?.addEventListener('change', (e) => {
      this.callbacks.onLengthUnitChange((e.target as HTMLSelectElement).value as LengthUnit);
    });
    this.el.querySelector<HTMLSelectElement>('[data-angle-unit]')?.addEventListener('change', (e) => {
      this.callbacks.onAngleUnitChange((e.target as HTMLSelectElement).value as AngleUnit);
    });

    this.el.querySelectorAll<HTMLElement>('[data-viz]').forEach((rowEl) => {
      rowEl.addEventListener('mouseenter', () => {
        const viz = this.resolveViz(rowEl.dataset.viz!);
        if (viz) {
          this.callbacks.onHoverViz(viz);
        }
      });
      rowEl.addEventListener('mouseleave', () => this.callbacks.onHoverViz(null));
    });
  }

  private resolveViz(tag: string): MeasureViz | null {
    const [key, axis] = tag.split(':');
    const dist = (this.data.result as any)?.[key] as MeasureDistanceValue | undefined;
    if (!dist) {
      return null;
    }
    return { from: dist.from, to: dist.to, axis: axis as MeasureAxis | undefined };
  }
}
