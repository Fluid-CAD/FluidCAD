import type { SelectedEntity, Viewer } from '../../viewer';
import type { SubSelection } from '../../types';
import type { MeasureEntityRef, MeasureResult, UserPreferences } from '../../api';
import { measureEntities, savePreference } from '../../api';
import { MeasureOverlay } from './measure-overlay';
import { MeasurePanel } from './measure-panel';
import { MeasureStatusBar } from './measure-status-bar';
import { formatAngle, formatArea, formatLength } from './format';
import type { AngleUnit, LengthUnit } from './format';

const MAX_ENTITIES = 8;

const DISTANCE_KEYS = ['parallelDist', 'centerDist', 'axisDist', 'minDist', 'maxDist'] as const;

function sameEntity(a: SelectedEntity, b: SelectedEntity): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

function toRef(entity: SelectedEntity): MeasureEntityRef {
  return { shapeId: entity.shapeId, kind: entity.sub.type, index: entity.sub.index };
}

/**
 * Owns the measure selection (plain click selects, ctrl/shift-click adds) and
 * coordinates the status bar, the expanded panel, and the viewport overlay.
 */
export class MeasureController {
  private entities: SelectedEntity[] = [];
  private result: MeasureResult | null = null;
  private panelOpen = false;
  private lengthUnit: LengthUnit = 'mm';
  private angleUnit: AngleUnit = 'deg';
  private abortController: AbortController | null = null;

  private statusBar: MeasureStatusBar;
  private panel: MeasurePanel;
  private overlay: MeasureOverlay;

  constructor(container: HTMLElement, private viewer: Viewer) {
    this.statusBar = new MeasureStatusBar(container, () => this.togglePanel());
    this.panel = new MeasurePanel(container, {
      onClose: () => this.togglePanel(false),
      onRemoveEntity: (ref) => this.removeEntity(ref),
      onLengthUnitChange: (unit) => {
        this.lengthUnit = unit;
        savePreference('measureLengthUnit', unit);
        this.updateUI();
      },
      onAngleUnitChange: (unit) => {
        this.angleUnit = unit;
        savePreference('measureAngleUnit', unit);
        this.updateUI();
      },
      onHoverViz: (viz) => {
        if (viz) {
          this.overlay.show(viz);
        } else {
          this.applyDefaultViz();
        }
      },
    });
    this.overlay = new MeasureOverlay(viewer.sceneContext);
  }

  applyPreferences(prefs: UserPreferences): void {
    if (prefs.measureLengthUnit) {
      this.lengthUnit = prefs.measureLengthUnit;
    }
    if (prefs.measureAngleUnit) {
      this.angleUnit = prefs.measureAngleUnit;
    }
    this.updateUI();
  }

  get selection(): SelectedEntity[] {
    return this.entities;
  }

  /**
   * Routes a viewer click into the measure selection. Plain clicks replace the
   * selection; ctrl/shift-clicks (or any click while the panel is open) toggle
   * the entity in the set. Returns the resulting selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection, additive: boolean): SelectedEntity[] {
    if (!shapeId || !sub) {
      if (additive && this.entities.length > 0) {
        return this.entities; // missed ctrl-click shouldn't wipe a selection in progress
      }
      this.setSelection([]);
      return this.entities;
    }

    const entity: SelectedEntity = { shapeId, sub };
    const existingIndex = this.entities.findIndex((e) => sameEntity(e, entity));

    let next: SelectedEntity[];
    if (additive || this.panelOpen) {
      next = existingIndex >= 0 ? this.entities.filter((_, i) => i !== existingIndex) : [...this.entities, entity];
      if (next.length > MAX_ENTITIES) {
        next = next.slice(next.length - MAX_ENTITIES);
      }
    } else {
      next = [entity];
    }

    this.setSelection(next);
    return this.entities;
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  /** Scene re-rendered: shape ids may have changed and the viewer already cleared its highlights. */
  onSceneRendered(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.entities = [];
    this.result = null;
    this.updateUI();
  }

  private setSelection(next: SelectedEntity[]): void {
    this.entities = next;
    if (next.length > 0) {
      this.viewer.highlightEntities(next);
    } else {
      this.viewer.clearHighlight();
    }
    this.fetchMeasurement();
  }

  private fetchMeasurement(): void {
    this.abortController?.abort();
    this.abortController = null;

    if (this.entities.length === 0) {
      this.result = null;
      this.updateUI();
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    const refs = this.entities.map(toRef);

    this.result = null;
    this.updateUI();

    measureEntities(refs, abort.signal).then((result) => {
      if (abort.signal.aborted || this.abortController !== abort) {
        return;
      }
      this.result = result;
      this.updateUI();
    });
  }

  private removeEntity(ref: MeasureEntityRef): void {
    const next = this.entities.filter(
      (e) => !(e.shapeId === ref.shapeId && e.sub.type === ref.kind && e.sub.index === ref.index),
    );
    this.setSelection(next);
  }

  private togglePanel(open = !this.panelOpen): void {
    this.panelOpen = open;
    this.panel.setVisible(open);
    this.statusBar.setExpanded(open);
  }

  private updateUI(): void {
    if (this.entities.length >= 2 && this.result) {
      this.statusBar.show(this.result.primaryLabel, this.primaryValueText(this.result));
      this.statusBar.setExpanded(this.panelOpen);
    } else if (this.entities.length >= 2) {
      this.statusBar.show('Measuring', '…');
    } else {
      this.statusBar.hide();
    }

    this.panel.update({
      entities: this.entities.map((entity, i) => ({
        ref: toRef(entity),
        label: `Selection ${i + 1} [${entity.sub.type === 'face' ? 'Face' : 'Edge'}]`,
      })),
      result: this.result,
      lengthUnit: this.lengthUnit,
      angleUnit: this.angleUnit,
    });

    this.applyDefaultViz();
  }

  private primaryValueText(result: MeasureResult): string {
    if (result.primary === 'angle') {
      return result.angleDeg !== undefined ? formatAngle(result.angleDeg, this.angleUnit) : '—';
    }
    if (result.primary === 'totalArea') {
      return result.totalArea !== undefined ? formatArea(result.totalArea, this.lengthUnit) : '—';
    }
    if (result.primary === 'totalLength') {
      return result.totalLength !== undefined ? formatLength(result.totalLength, this.lengthUnit) : '—';
    }
    const dist = result[result.primary];
    return dist ? formatLength(dist.value, this.lengthUnit) : '—';
  }

  /** Default viewport visualization: the primary distance line, when there is one. */
  private applyDefaultViz(): void {
    const result = this.result;
    if (!result || this.entities.length !== 2 || !(DISTANCE_KEYS as readonly string[]).includes(result.primary)) {
      this.overlay.clear();
      return;
    }
    const dist = result[result.primary as (typeof DISTANCE_KEYS)[number]];
    if (dist) {
      this.overlay.show({ from: dist.from, to: dist.to });
    } else {
      this.overlay.clear();
    }
  }

}
