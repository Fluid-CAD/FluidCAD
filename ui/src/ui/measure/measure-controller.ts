import type { SelectedEntity, Viewer } from '../../viewer';
import type { SubSelection } from '../../types';
import type { MeasureEntityRef, MeasureResult, UserPreferences } from '../../api';
import type { EngineClient } from '../../engine-client';
import { mergeUniqueEntities, sameEntity } from '../../helpers/entities';
import type { SelectionContextMenu, SelectionMenuHandlers } from '../../interactive/selection-menu';
import { MeasureOverlay } from './measure-overlay';
import { MeasurePanel } from './measure-panel';
import { MeasureStatusBar } from './measure-status-bar';
import { convertLength, formatAngle, formatArea, formatLength } from '../../units/units';
import type { LengthUnit } from '../../units/units';
import { sceneUnit } from '../../units/scene-unit';
import { viewerSettings } from '../../scene/viewer-settings';

/** Measurements are computed up to this count; larger selections just select. */
const MAX_MEASURE_ENTITIES = 8;

const DISTANCE_KEYS = ['parallelDist', 'centerDist', 'axisDist', 'minDist', 'maxDist'] as const;

/** An area in document unit², expressed in `unit`². */
function convertArea(area: number, unit: LengthUnit): number {
  const f = convertLength(1, sceneUnit.current, unit);
  return area * f * f;
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
  private abortController: AbortController | null = null;

  private statusBar: MeasureStatusBar;
  private panel: MeasurePanel;
  private overlay: MeasureOverlay;
  private menu: SelectionContextMenu | null;
  /** Notified whenever the selection set changes through this controller. */
  onSelectionChanged: ((selection: SelectedEntity[]) => void) | null = null;
  /** A refusal from the unit chip's dropup (the server said no) to surface. */
  set onNotice(fn: ((message: string) => void) | null) {
    this.statusBar.onNotice = fn;
  }

  constructor(
    container: HTMLElement,
    private client: EngineClient,
    private viewer: Viewer,
    // Injected so read-only hosts (no selection-groups backend) can omit the
    // menu without pulling interactive/selection-menu into their bundle.
    menuFactory?: (handlers: SelectionMenuHandlers) => SelectionContextMenu,
  ) {
    // Right-click menu: multi-select groups + sibling buckets ("Select
    // other"). Groups merge into the measure selection, which seeds the
    // modify tools.
    this.menu = !menuFactory ? null : menuFactory({
      kinds: ['tangent', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (_kind, _seed, members) => {
        this.setSelection(mergeUniqueEntities(this.entities, members));
      },
      onPreview: (members) => {
        const shown = members ? mergeUniqueEntities(this.entities, members) : this.entities;
        if (shown.length > 0) {
          this.viewer.highlightEntities(shown);
        } else {
          this.viewer.clearHighlight();
        }
      },
    });
    this.statusBar = new MeasureStatusBar(container, () => this.togglePanel(), client);
    this.panel = new MeasurePanel(container, {
      onClose: () => this.togglePanel(false),
      onRemoveEntity: (ref) => this.removeEntity(ref),
      onLengthUnitChange: (unit) => {
        viewerSettings.update({ measureLengthUnit: unit });
        // Older servers allow-list only mm/cm/m/in and silently drop the
        // rest, so a rejected choice just stays session-local.
        this.client.savePreference('measureLengthUnit', unit);
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
    // Display units live in viewerSettings (any component may subscribe);
    // the document unit is the conversion base for both readouts.
    viewerSettings.subscribe(() => this.updateUI());
    sceneUnit.subscribe(() => this.updateUI());
  }

  /** Display-unit preferences now flow through `applyPreferences` in viewer-settings. */
  applyPreferences(prefs: UserPreferences): void {
    viewerSettings.update({
      ...(prefs.measureLengthUnit ? { measureLengthUnit: prefs.measureLengthUnit } : {}),
    });
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
    // Sketch-wire picks belong to the create dialogs, never to measurement.
    if (!shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane' || sub.type === 'connector') {
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
    } else {
      next = [entity];
    }

    this.setSelection(next);
    return this.entities;
  }

  /** Right-click in neutral mode: the multi-select menu over that pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    this.menu?.hide();
    if (!this.menu || !shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane' || sub.type === 'connector') {
      return;
    }
    // The hover tint would otherwise be stashed as an "original" color by the
    // preview highlight and stick around after the preview restores it.
    this.viewer.clearHover();
    void this.menu.open({ shapeId, sub }, clientX, clientY);
  }

  clearSelection(): void {
    this.menu?.hide();
    this.setSelection([]);
  }

  /** Scene re-rendered: shape ids may have changed and the viewer already cleared its highlights. */
  onSceneRendered(): void {
    this.menu?.hide();
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
    this.onSelectionChanged?.(this.entities);
  }

  private fetchMeasurement(): void {
    this.abortController?.abort();
    this.abortController = null;

    // Group selections can exceed what a measurement usefully combines —
    // beyond the cap the set is a selection (for the modify tools), not a
    // measurement input.
    if (this.entities.length === 0 || this.entities.length > MAX_MEASURE_ENTITIES) {
      this.result = null;
      this.updateUI();
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    const refs = this.entities.map(toRef);

    this.result = null;
    this.updateUI();

    this.client.measureEntities(refs, abort.signal).then((result) => {
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
    if (this.entities.length > MAX_MEASURE_ENTITIES) {
      this.statusBar.show('Selection', `${this.entities.length} entities`);
      this.statusBar.setExpanded(this.panelOpen);
    } else if (this.entities.length >= 2 && this.result) {
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
      baseUnit: sceneUnit.current,
      lengthUnit: viewerSettings.current.measureLengthUnit,
    });

    this.applyDefaultViz();
  }

  private primaryValueText(result: MeasureResult): string {
    const { measureLengthUnit: unit } = viewerSettings.current;
    if (result.primary === 'angle') {
      return result.angleDeg !== undefined ? formatAngle(result.angleDeg) : '—';
    }
    if (result.primary === 'totalArea') {
      return result.totalArea !== undefined ? formatArea(convertArea(result.totalArea, unit), unit) : '—';
    }
    if (result.primary === 'totalLength') {
      return result.totalLength !== undefined ? formatLength(convertLength(result.totalLength, sceneUnit.current, unit), unit) : '—';
    }
    const dist = result[result.primary];
    return dist ? formatLength(convertLength(dist.value, sceneUnit.current, unit), unit) : '—';
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
