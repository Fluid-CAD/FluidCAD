import type { SelectedEntity, Viewer } from '../../viewer';
import type { SubSelection } from '../../types';
import type { MeasureEntityRef, MeasurePose, MeasureResult, UserPreferences } from '../../api';
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

/** How far an instance must move between solver frames before the measurement is redone. */
const POSE_CHANGE_TOL = 1e-9;
/** Solver frames arrive per pointer event; coalesce them before hitting the server. */
const POSE_REFRESH_DELAY_MS = 80;

function sameRef(a: MeasureEntityRef, b: MeasureEntityRef): boolean {
  return a.shapeId === b.shapeId && a.kind === b.kind && a.index === b.index
    && (a.instanceId ?? null) === (b.instanceId ?? null);
}

function samePose(a: MeasurePose | undefined, b: MeasurePose | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  return Math.abs(a.position.x - b.position.x) < POSE_CHANGE_TOL
    && Math.abs(a.position.y - b.position.y) < POSE_CHANGE_TOL
    && Math.abs(a.position.z - b.position.z) < POSE_CHANGE_TOL
    && Math.abs(a.quaternion.x - b.quaternion.x) < POSE_CHANGE_TOL
    && Math.abs(a.quaternion.y - b.quaternion.y) < POSE_CHANGE_TOL
    && Math.abs(a.quaternion.z - b.quaternion.z) < POSE_CHANGE_TOL
    && Math.abs(a.quaternion.w - b.quaternion.w) < POSE_CHANGE_TOL;
}

/**
 * What the assembly workbench lends the controller: the live world pose of
 * an instance (the browser-side solver owns it — the server only knows the
 * statement pose) and a display name for the selection rows.
 */
export type MeasureAssemblyHooks = {
  poseOf: (instanceId: string) => MeasurePose | null;
  instanceLabel: (instanceId: string) => string | null;
};

/**
 * Owns the measure selection (plain click selects, ctrl/shift-click adds) and
 * coordinates the status bar, the expanded panel, and the viewport overlay.
 *
 * In an assembly every entity is stamped with its instance and that
 * instance's live pose (see {@link MeasureAssemblyHooks}) — no separate
 * tool: a click on any part's face or edge measures, exactly as in a part
 * file.
 */
export class MeasureController {
  private entities: SelectedEntity[] = [];
  private result: MeasureResult | null = null;
  private panelOpen = false;
  private abortController: AbortController | null = null;
  /** The refs of the request in flight or last answered — poses included, for change detection. */
  private lastRefs: MeasureEntityRef[] = [];
  private poseRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
    private assemblyHooks: MeasureAssemblyHooks | null = null,
  ) {
    // Right-click menu: multi-select groups + sibling buckets ("Select
    // other"). Groups merge into the measure selection, which seeds the
    // modify tools. Group members come back instance-less (they are the
    // seed's shape), so they inherit the seed's instance.
    this.menu = !menuFactory ? null : menuFactory({
      kinds: ['tangent', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (_kind, seed, members) => {
        this.setSelection(mergeUniqueEntities(this.entities, this.withInstanceOf(seed, members)));
      },
      onPreview: (members) => {
        const seed = this.menuSeed;
        const shown = members && seed ? mergeUniqueEntities(this.entities, this.withInstanceOf(seed, members)) : this.entities;
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
  handleClick(shapeId: string | null, sub: SubSelection, additive: boolean, instanceId: string | null = null): SelectedEntity[] {
    // Sketch-wire picks belong to the create dialogs, never to measurement.
    if (!shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane' || sub.type === 'connector') {
      if (additive && this.entities.length > 0) {
        return this.entities; // missed ctrl-click shouldn't wipe a selection in progress
      }
      this.setSelection([]);
      return this.entities;
    }

    const entity: SelectedEntity = instanceId ? { shapeId, sub, instanceId } : { shapeId, sub };
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
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number, instanceId: string | null = null): void {
    this.menu?.hide();
    if (!this.menu || !shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane' || sub.type === 'connector') {
      return;
    }
    // The hover tint would otherwise be stashed as an "original" color by the
    // preview highlight and stick around after the preview restores it.
    this.viewer.clearHover();
    this.menuSeed = instanceId ? { shapeId, sub, instanceId } : { shapeId, sub };
    void this.menu.open(this.menuSeed, clientX, clientY);
  }

  /** The entity the open context menu was seeded from (its instance is what group members inherit). */
  private menuSeed: SelectedEntity | null = null;

  private withInstanceOf(seed: SelectedEntity, members: SelectedEntity[]): SelectedEntity[] {
    if (!seed.instanceId) {
      return members;
    }
    return members.map((m) => ({ ...m, instanceId: seed.instanceId }));
  }

  /**
   * Instances moved without a re-render (a mate drive, the animate bar, a
   * gizmo nudge): re-stamp every selected entity's pose and, when one
   * moved, measure again — coalesced so per-pointer-event solver frames
   * don't flood the server.
   */
  onPosesChanged(): void {
    if (!this.assemblyHooks || this.entities.length === 0 || this.entities.length > MAX_MEASURE_ENTITIES) {
      return;
    }
    const refs = this.entities.map((e) => this.toRef(e));
    const moved = refs.some((ref, i) => {
      const last = this.lastRefs[i];
      return !last || !sameRef(ref, last) || !samePose(ref.pose, last.pose);
    });
    if (!moved) {
      return;
    }
    if (this.poseRefreshTimer !== null) {
      clearTimeout(this.poseRefreshTimer);
    }
    this.poseRefreshTimer = setTimeout(() => {
      this.poseRefreshTimer = null;
      this.fetchMeasurement({ keepResult: true });
    }, POSE_REFRESH_DELAY_MS);
  }

  /** An instance left the scene (hidden or gone): drop its entities. */
  dropInstance(instanceId: string): void {
    if (!this.entities.some((e) => e.instanceId === instanceId)) {
      return;
    }
    this.setSelection(this.entities.filter((e) => e.instanceId !== instanceId));
  }

  private toRef(entity: SelectedEntity): MeasureEntityRef {
    const ref: MeasureEntityRef = { shapeId: entity.shapeId, kind: entity.sub.type, index: entity.sub.index };
    if (entity.instanceId) {
      ref.instanceId = entity.instanceId;
      const pose = this.assemblyHooks?.poseOf(entity.instanceId);
      if (pose) {
        ref.pose = pose;
      }
    }
    return ref;
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
    if (this.poseRefreshTimer !== null) {
      clearTimeout(this.poseRefreshTimer);
      this.poseRefreshTimer = null;
    }
    this.entities = [];
    this.result = null;
    this.lastRefs = [];
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

  /**
   * `keepResult` leaves the previous readout and overlay on screen until the
   * new numbers land — a pose refresh mid-animation must not flicker.
   */
  private fetchMeasurement(options: { keepResult?: boolean } = {}): void {
    this.abortController?.abort();
    this.abortController = null;

    // Group selections can exceed what a measurement usefully combines —
    // beyond the cap the set is a selection (for the modify tools), not a
    // measurement input.
    if (this.entities.length === 0 || this.entities.length > MAX_MEASURE_ENTITIES) {
      this.result = null;
      this.lastRefs = [];
      this.updateUI();
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    const refs = this.entities.map((e) => this.toRef(e));
    this.lastRefs = refs;

    if (!options.keepResult) {
      this.result = null;
      this.updateUI();
    }

    this.client.measureEntities(refs, abort.signal).then((result) => {
      if (abort.signal.aborted || this.abortController !== abort) {
        return;
      }
      this.result = result;
      this.updateUI();
    });
  }

  private removeEntity(ref: MeasureEntityRef): void {
    const next = this.entities.filter((e) => !sameRef(this.toRef(e), ref));
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
        ref: this.toRef(entity),
        label: this.entityLabel(entity, i),
      })),
      result: this.result,
      baseUnit: sceneUnit.current,
      lengthUnit: viewerSettings.current.measureLengthUnit,
    });

    this.applyDefaultViz();
  }

  /** `Selection 2 [Face] · bracket` — the instance name tells a shared part's clones apart. */
  private entityLabel(entity: SelectedEntity, i: number): string {
    const base = `Selection ${i + 1} [${entity.sub.type === 'face' ? 'Face' : 'Edge'}]`;
    const name = entity.instanceId ? this.assemblyHooks?.instanceLabel(entity.instanceId) : null;
    return name ? `${base} · ${name}` : base;
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
