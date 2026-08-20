import type { SceneObjectRender } from '../types';
import { setDistanceTangency } from '../api';
import { findActiveObject, findEnclosingPartRow, rollbackScopeIds, isRollbackViewTruncated } from '../helpers/scene-utils';
import type { EngineClient } from '../engine-client';
import { ICON_CIRCLE_CHECK, ICON_REFRESH, ICON_CHEVRON_RIGHT, ICON_DOTS_VERTICAL, ICON_CHECK, ICON_ALERT_DOT, ICON_PAUSE, ICON_PENCIL, ICON_ADJUSTMENTS, ICON_TRASH } from './icons';
import { resolveIconName, ICON_IMG_FALLBACK } from './object-icons';
import { ShapesPanel } from './shapes-panel';

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Objects the scene carries but the timeline never lists: a lazy select's
 * reference holder, a lazy vertex's anchor holder (`sel.center()` inside
 * `connector(…)`), and the internal inputs a statement builds for itself
 * (the plane behind `sketch('xy', …)`) — they have no statement of their own,
 * so a row would offer navigation and edits that belong to the statement they
 * serve. Rows keep their scene index either way, so rollback targets and the
 * edit dialogs' row lookups are unaffected.
 */
/**
 * Constraint statements of a solved sketch (sketch-rewrite P3). They render
 * grouped behind one "N constraints" toggle row under their sketch —
 * FreeCAD-style — instead of flooding the timeline.
 */
function isConstraintRow(obj: SceneObjectRender): boolean {
  return obj.uniqueType?.startsWith('constraint-') === true;
}

function isHiddenRow(obj: SceneObjectRender): boolean {
  return obj.uniqueType === 'lazy-select' || obj.uniqueType === 'lazy-vertex' || obj.internal === true;
}

export class TimelinePanel {
  /**
   * Pre-empts a timeline row's default click (rollback preview + go to
   * source). An armed pick dialog consumes clicks on rows it can use —
   * e.g. the extrude dialog takes a sketch row as its profile — by
   * returning true.
   */
  onFeatureIntercept?: (obj: SceneObjectRender) => boolean;

  /**
   * A part row was clicked. Part rows don't navigate: instead of the
   * rollback preview they toggle the timeline's ACTIVE part — the part whose
   * callback body receives newly created statements. The source jump stays.
   * Unset (a host without the tracker), part rows keep the default rollback.
   */
  onPartActivate?: (obj: SceneObjectRender) => void;

  /** Whether this part row is the active part (drives its highlight). */
  isPartRowActive?: (obj: SceneObjectRender) => boolean;

  /**
   * A row was double-clicked (the enter-breakpoint gesture). Fired after the
   * breakpoint is placed so an editable feature row can also open its edit
   * dialog against the paused scene. `index` is the row's position — the
   * edit session's rollback boundary and selection scope derive from it.
   */
  onFeatureEdit?: (obj: SceneObjectRender, index: number) => void;

  /**
   * Whether double-clicking this row opens an edit dialog (vs. only placing
   * a breakpoint). Edit dialogs suspend the active sketch UI themselves and
   * restore it on exit, so their rows keep the double-click gesture even
   * while the scene-derived sketch mode blocks timeline navigation.
   */
  isFeatureEditable?: (obj: SceneObjectRender) => boolean;

  /**
   * Whether this row's edit dialog places its own pause (the 2D offset). The
   * double-click then skips the generic after-the-statement breakpoint: the
   * dialog pauses the build BEFORE the statement instead — once its parse has
   * captured the statement's text and line from the unshifted buffer.
   */
  managesOwnBreakpoint?: (obj: SceneObjectRender) => boolean;

  private panel: HTMLDivElement;
  private timelineBody: HTMLDivElement;
  private contentWrapper: HTMLDivElement;
  private shapesPanel: ShapesPanel;
  private loaded = false;
  private userHidden = false;
  private sceneObjects: SceneObjectRender[] = [];
  private rollbackStop = -1;
  /**
   * Set while the displayed render is a part-scoped rollback (the server
   * derived it from the clicked row): only that part's rows past the stop
   * are the hidden tail — rows of every other part stay fully rendered, so
   * they must not read as "past".
   */
  private rollbackScopePartId: string | null = null;
  /**
   * The scene ends with an unconsumed sketch (scene-derived sketch mode).
   * While it does, the timeline doesn't navigate: a rollback or breakpoint
   * would tear the sketch view down mid-edit. Row clicks still jump to
   * source and armed dialogs still consume rows; rename/remove stay.
   */
  private sketchActive = false;
  private collapsedIds = new Set<string>();
  /** Sketch ids whose grouped constraint rows are shown (hidden by default). */
  private expandedConstraintIds = new Set<string>();
  /**
   * Row highlight for a 3D viewer pick: the id of the feature the picked
   * face/edge attributed to. Cleared on every update() — ids are re-minted
   * per render and the viewer selection dies with the old scene anyway.
   */
  private pickedFeatureId: string | null = null;
  /** True only for the render setPickedFeature triggers — one-shot flash. */
  private pickedFlash = false;
  private timelineExpanded = true;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private showBuildTimings = false;
  private historyTotalLabel!: HTMLSpanElement;
  private hoverPopover: HTMLDivElement | null = null;

  constructor(
    container: HTMLElement,
    private client: EngineClient,
    onHighlightShape: (shapeId: string) => void,
    onExportShapes: (shapeIds: string[]) => void,
    onToggleShapeVisibility: (shapeId: string, visible: boolean) => void,
    isShapeHidden: (shapeId: string) => boolean,
    onSetShapeTransparency: (shapeId: string, opacity: number) => void,
    getShapeTransparency: (shapeId: string) => number,
    onResetAllTransparency: () => void,
  ) {
    this.panel = document.createElement('div');
    // Docked below the host chrome (--fluidcad-chrome-top) with breathing room.
    this.panel.className = 'absolute left-6 top-[calc(var(--fluidcad-chrome-top,104px)+12px)] bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
    container.appendChild(this.panel);
    this.applyPanelWidth();

    this.contentWrapper = document.createElement('div');
    this.contentWrapper.className = 'flex-1 min-h-0 flex flex-col gap-1 overflow-y-auto';
    this.panel.appendChild(this.contentWrapper);

    // Timeline accordion section
    const timelineHeader = document.createElement('div');
    timelineHeader.className = SECTION_HEADER;
    timelineHeader.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${ICON_CHEVRON_RIGHT}</span>
      <span class="text-sm font-medium text-base-content/70">History</span>
      <span data-ref="history-total" class="text-xs text-base-content/40 tabular-nums hidden"></span>
      <button data-ref="history-dots" class="ml-auto btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0">${ICON_DOTS_VERTICAL}</button>
    `;
    this.contentWrapper.appendChild(timelineHeader);
    this.historyTotalLabel = timelineHeader.querySelector<HTMLSpanElement>('[data-ref="history-total"]')!;
    const historyDotsBtn = timelineHeader.querySelector<HTMLButtonElement>('[data-ref="history-dots"]')!;
    historyDotsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showHistoryDropdown(historyDotsBtn);
    });

    this.timelineBody = document.createElement('div');
    this.timelineBody.className = 'py-1 overflow-y-auto min-h-0';
    this.contentWrapper.appendChild(this.timelineBody);

    timelineHeader.addEventListener('click', () => {
      this.timelineExpanded = !this.timelineExpanded;
      this.timelineBody.classList.toggle('hidden', !this.timelineExpanded);
      const chevron = timelineHeader.querySelector('[data-ref="chevron"]')!;
      chevron.classList.toggle('rotate-90', this.timelineExpanded);
    });

    // Shapes accordion section (delegated to ShapesPanel)
    this.shapesPanel = new ShapesPanel(
      this.panel,
      onHighlightShape,
      onExportShapes,
      onToggleShapeVisibility,
      isShapeHidden,
      onSetShapeTransparency,
      getShapeTransparency,
      onResetAllTransparency,
    );
    this.contentWrapper.appendChild(this.shapesPanel.header);
    this.contentWrapper.appendChild(this.shapesPanel.body);

  }

  update(sceneObjects: SceneObjectRender[], rollbackStop: number, rollbackScopePartId: string | null = null): void {
    this.pickedFeatureId = null;
    this.sceneObjects = sceneObjects;
    this.rollbackStop = rollbackStop;
    this.rollbackScopePartId = rollbackScopePartId;
    this.loaded = true;
    this.syncVisibility();
    this.renderTimeline(true);
    this.shapesPanel.update(sceneObjects);
    this.updateHistoryTotal();
  }

  /**
   * Highlight the row of the feature a 3D pick attributed to (null clears).
   * The row is revealed IDE-style: a collapsed enclosing group expands and
   * the row — or the nearest rendered ancestor standing in for it — flashes
   * and scrolls into view. The History accordion and the panel's own
   * visibility stay untouched; the highlight paints whenever they reopen.
   */
  setPickedFeature(id: string | null): void {
    if (id === this.pickedFeatureId) {
      if (id !== null) {
        this.scrollPickedIntoView();
      }
      return;
    }
    this.pickedFeatureId = id;
    if (id === null) {
      this.renderTimeline();
      return;
    }
    const rowId = this.resolvePickedRowId();
    if (rowId !== null) {
      const row = this.sceneObjects.find((o) => o.id === rowId);
      if (row?.parentId != null) {
        this.collapsedIds.delete(row.parentId);
        if (isConstraintRow(row)) {
          this.expandedConstraintIds.add(row.parentId);
        }
      }
    }
    this.pickedFlash = true;
    this.renderTimeline();
    this.pickedFlash = false;
    this.scrollPickedIntoView();
  }

  /**
   * The rendered row standing in for pickedFeatureId: the feature's own row,
   * or the nearest ancestor that has one — grandchildren (only two depths
   * render), descendants of hide-children containers, and hidden rows have
   * no row of their own.
   */
  private resolvePickedRowId(): string | null {
    if (this.pickedFeatureId === null) {
      return null;
    }
    const byId = (id: string) => this.sceneObjects.find((o) => o.id === id);
    const visited = new Set<string>();
    let obj = byId(this.pickedFeatureId);
    while (obj && obj.id != null && !visited.has(obj.id)) {
      visited.add(obj.id);
      if (this.hasRenderedRow(obj)) {
        return obj.id;
      }
      obj = obj.parentId != null ? byId(obj.parentId) : undefined;
    }
    return null;
  }

  /** Whether renderTimeline emits a row for this object (collapse aside). */
  private hasRenderedRow(obj: SceneObjectRender): boolean {
    if (isHiddenRow(obj)) {
      return false;
    }
    if (obj.parentId == null) {
      return true;
    }
    const parent = this.sceneObjects.find((o) => o.id === obj.parentId);
    return parent != null && parent.parentId == null && !isHiddenRow(parent) && parent.hideChildren !== true;
  }

  private scrollPickedIntoView(): void {
    const el = this.timelineBody.querySelector<HTMLElement>('[data-picked="true"]');
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  setShowBuildTimings(value: boolean): void {
    if (this.showBuildTimings === value) {
      return;
    }
    this.showBuildTimings = value;
    this.applyPanelWidth();
    this.updateHistoryTotal();
    if (this.loaded) {
      this.renderTimeline();
    }
  }

  /** Toggle panel visibility (driven by the top-bar hamburger). */
  togglePanel(): void {
    this.userHidden = !this.userHidden;
    this.syncVisibility();
  }

  get isPanelVisible(): boolean {
    return this.loaded && !this.userHidden;
  }

  private syncVisibility(): void {
    this.panel.classList.toggle('hidden', !(this.loaded && !this.userHidden));
  }

  // ---------------------------------------------------------------------------
  // Timeline rendering
  // ---------------------------------------------------------------------------

  private renderTimeline(scrollToCurrent = false): void {
    const items = this.sceneObjects;
    const rollbackStop = this.rollbackStop;

    // Mirrors the viewer's sketch-mode derivation: a non-truncated render
    // whose active scope ends in a sketch — including a part-scoped stop on
    // the active part's tip sketch, which hides nothing and DOES enter
    // sketch editing. Derived here rather than in update() so a part-row
    // click — which repoints the active part and re-renders without a new
    // scene — reads the new scope's state.
    this.sketchActive = !isRollbackViewTruncated(items, rollbackStop, this.rollbackScopePartId)
      && findActiveObject(items)?.type === 'sketch';

    const parentIds = new Set<string>();
    const childErrorByParent = new Map<string, boolean>();
    for (const obj of items) {
      if (isHiddenRow(obj)) {
        continue;
      }
      if (obj.parentId) {
        parentIds.add(obj.parentId);
        if (obj.hasError) {
          childErrorByParent.set(obj.parentId, true);
        }
      }
    }

    const scopedIds = rollbackScopeIds(items, this.rollbackScopePartId);
    const pickedRowId = this.resolvePickedRowId();

    let html = '';

    for (let i = 0; i < items.length; i++) {
      const obj = items[i];
      if (obj.parentId) {
        continue;
      }
      if (isHiddenRow(obj)) {
        continue;
      }

      // A hide-children container (e.g. a repeat) shows as a single leaf row.
      // Its rollback target is its last descendant, so clicking it previews
      // the scene after the whole feature has executed.
      const hidesChildren = obj.hideChildren === true;
      const hasChildren = !hidesChildren && obj.id != null && parentIds.has(obj.id);
      const isCollapsed = obj.id != null && this.collapsedIds.has(obj.id);
      const childHasError = obj.id != null && childErrorByParent.get(obj.id) === true;
      const effectiveError = obj.hasError === true || childHasError;
      const rollbackIndex = hidesChildren ? this.lastDescendantIndex(items, i) : i;

      html += this.renderTimelineItem(obj, i, rollbackStop, false, hasChildren, isCollapsed, effectiveError, rollbackIndex, scopedIds, pickedRowId !== null && obj.id === pickedRowId);

      if (hasChildren && !isCollapsed) {
        const constraintRows: number[] = [];
        for (let j = 0; j < items.length; j++) {
          if (isHiddenRow(items[j])) {
            continue;
          }
          if (items[j].parentId === obj.id) {
            if (isConstraintRow(items[j])) {
              constraintRows.push(j);
              continue;
            }
            const childRollbackIndex = items[j].hideChildren === true ? this.lastDescendantIndex(items, j) : j;
            html += this.renderTimelineItem(items[j], j, rollbackStop, true, false, false, items[j].hasError === true, childRollbackIndex, scopedIds, pickedRowId !== null && items[j].id === pickedRowId);
          }
        }
        if (constraintRows.length > 0 && obj.id != null) {
          const shown = this.expandedConstraintIds.has(obj.id);
          const anyError = constraintRows.some((j) => items[j].hasError === true);
          html += this.renderConstraintSummaryRow(obj.id, constraintRows.length, shown, anyError);
          if (shown) {
            for (const j of constraintRows) {
              html += this.renderTimelineItem(items[j], j, rollbackStop, true, false, false, items[j].hasError === true, j, scopedIds, pickedRowId !== null && items[j].id === pickedRowId);
            }
          }
        }
      }
    }

    this.timelineBody.innerHTML = html;

    this.timelineBody.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        const index = parseInt(el.dataset.index!, 10);
        const rollbackIndex = parseInt(el.dataset.rollbackIndex ?? el.dataset.index!, 10);
        const obj = this.sceneObjects[index];
        if (obj && this.onFeatureIntercept?.(obj)) {
          return;
        }
        if (obj && obj.type === 'part' && this.onPartActivate) {
          // Part rows toggle the active part instead of rolling back; the
          // re-render repaints the highlight from the tracker's new state.
          this.onPartActivate(obj);
          this.goToSource(obj);
          this.renderTimeline();
          return;
        }
        if (this.sketchActive) {
          // No timeline navigation while sketching — the source jump stays.
          this.goToSource(obj);
          return;
        }
        this.rollbackTo(rollbackIndex);
        this.goToSource(obj);
      });
      el.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        const index = parseInt(el.dataset.index!, 10);
        const obj = this.sceneObjects[index];
        if (obj && obj.type === 'part') {
          // Parts have no edit dialog and their single click already toggles
          // activation — a double-click must not place a breakpoint. The
          // context menu's "Breakpoint here" stays the explicit path.
          return;
        }
        if (this.sketchActive && !(obj && this.isFeatureEditable?.(obj))) {
          // The enter-breakpoint gesture is navigation — blocked while
          // sketching, except for rows that open an edit dialog: the dialog
          // suspends the sketch UI itself and restores it on exit.
          return;
        }
        this.enterBreakpointAt(index);
      });
      el.addEventListener('contextmenu', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        e.preventDefault();
        const index = parseInt(el.dataset.index!, 10);
        this.showRowContextMenu(e, index);
      });
    });

    this.timelineBody.querySelectorAll<HTMLElement>('[data-toggle]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.toggle!;
        if (this.collapsedIds.has(id)) {
          this.collapsedIds.delete(id);
        } else {
          this.collapsedIds.add(id);
        }
        this.renderTimeline();
      });
    });

    this.timelineBody.querySelectorAll<HTMLElement>('[data-constraints-toggle]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.constraintsToggle!;
        if (this.expandedConstraintIds.has(id)) {
          this.expandedConstraintIds.delete(id);
        } else {
          this.expandedConstraintIds.add(id);
        }
        this.renderTimeline();
      });
    });

    if (this.showBuildTimings) {
      this.timelineBody.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
        const index = parseInt(el.dataset.index!, 10);
        const obj = this.sceneObjects[index];
        if (!obj || !obj.profileCategories || obj.profileCategories.length === 0) {
          return;
        }
        el.addEventListener('mouseenter', () => {
          this.showProfilePopover(el, obj.profileCategories!, obj.buildDurationMs);
        });
        el.addEventListener('mouseleave', () => {
          this.closeProfilePopover();
        });
      });
    }

    if (scrollToCurrent) {
      const currentEl = this.timelineBody.querySelector<HTMLElement>('[data-current="true"]');
      if (currentEl) {
        currentEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /**
   * The enter-breakpoint gesture, shared by row double-click and the context
   * menu's "Edit feature": place the breakpoint after the row (unless the
   * feature's edit manages its own pause), jump to the source line, and open
   * the feature's edit dialog when it has one.
   */
  private enterBreakpointAt(index: number): void {
    if (!this.client.editor) {
      return;
    }
    const obj = this.sceneObjects[index];
    if (obj) {
      this.activateEnclosingPart(obj);
    }
    if (!(obj && this.managesOwnBreakpoint?.(obj))) {
      this.addBreakpointAfter(index);
    }
    this.goToSource(obj);
    if (obj) {
      this.onFeatureEdit?.(obj, index);
    }
  }

  /**
   * The pause gestures work "here": pausing a build inside a part makes that
   * part the user's working scope, so an inactive enclosing part is activated
   * first — the same path as clicking its row. Without this the breakpoint
   * render derives sketch-mode entry (and every scope-sensitive service) from
   * the previously active part — whose build the pause never touches, since
   * the leftover-definitions pass still materializes it fully — and a paused
   * tip sketch never opens for editing. Skipped while sketching: the only
   * gestures allowed then either stay inside the active part or open an edit
   * dialog that suspends the active sketch and restores it on exit, which a
   * scope switch would close for good instead.
   */
  private activateEnclosingPart(obj: SceneObjectRender): void {
    if (this.sketchActive || !this.onPartActivate) {
      return;
    }
    const part = findEnclosingPartRow(obj, this.sceneObjects);
    if (!part || this.isPartRowActive?.(part) === true) {
      return;
    }
    this.onPartActivate(part);
    this.renderTimeline();
  }

  /**
   * Index of the last descendant of the container at `index` in the flat
   * scene list — the rollback target that shows the scene with the whole
   * feature (e.g. a repeat and all its generated clones) applied.
   */
  private lastDescendantIndex(items: SceneObjectRender[], index: number): number {
    const rootId = items[index].id;
    if (rootId == null) {
      return index;
    }
    const descendantIds = new Set<string>([rootId]);
    let last = index;
    for (let j = index + 1; j < items.length; j++) {
      const parentId = items[j].parentId;
      if (parentId != null && descendantIds.has(parentId)) {
        if (items[j].id != null) {
          descendantIds.add(items[j].id!);
        }
        last = j;
      }
    }
    return last;
  }

  /**
   * The "N constraints" toggle row of a solved sketch. Carries no data-index
   * on purpose: it is not a statement — no rollback, rename or context menu —
   * only the show/hide toggle for the grouped constraint rows below it.
   */
  private renderConstraintSummaryRow(sketchId: string, count: number, shown: boolean, anyError: boolean): string {
    const rotation = shown ? 'rotate-90' : '';
    const textClass = anyError ? 'text-error' : 'text-base-content/60';
    const errorDot = anyError
      ? `<span class="text-error shrink-0 [&>svg]:w-2.5 [&>svg]:h-2.5">${ICON_ALERT_DOT}</span>`
      : '';
    return `
      <div class="flex items-center gap-1 px-3 py-1.5 pl-7 cursor-pointer hover:bg-base-content/[0.06] text-sm ${textClass}" data-constraints-toggle="${sketchId}">
        <span class="flex items-center justify-center w-5 h-5 opacity-50 hover:opacity-100 transition-transform ${rotation}">
          ${ICON_CHEVRON_RIGHT}
        </span>
        ${errorDot}
        <img src="/icons/constraint-horizontal.png" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />
        <span class="truncate">${count} constraint${count === 1 ? '' : 's'}</span>
      </div>
    `;
  }

  private renderTimelineItem(obj: SceneObjectRender, index: number, rollbackStop: number, isChild: boolean, hasChildren: boolean, isCollapsed: boolean, effectiveError: boolean, rollbackIndex: number, scopedIds: Set<string> | null, isPicked: boolean): string {
    // Rows outside a part-scoped rollback's part are fully rendered — they
    // never read as past or current, whatever their flat index.
    const inRollbackScope = scopedIds === null || (obj.id != null && scopedIds.has(obj.id));
    // A row that stands in for hidden descendants (rollbackIndex > index) is
    // current whenever the rollback stop lands anywhere inside its range.
    const isCurrent = inRollbackScope && rollbackStop >= index && rollbackStop <= rollbackIndex;
    const isPast = inRollbackScope && index > rollbackStop;
    const isInvisible = obj.visible === false;
    const isActivePart = !isChild && obj.type === 'part' && this.isPartRowActive?.(obj) === true;
    const name = obj.name || 'Unknown';
    const iconSrc = obj.type === 'part' ? '/icons/box.png' : `/icons/${resolveIconName(obj.uniqueType, obj.type)}.png`;

    let itemClass = 'flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm';

    if (isChild) {
      itemClass += ' pl-7';
    }

    // Part rows opt out of the "current" navigation highlight: with part
    // clicks toggling activation instead of rolling back, a current-tinted
    // part next to the active one would read as two active parts. Only the
    // active part row is tinted (and carries the dot).
    const highlightCurrent = isCurrent && obj.type !== 'part';
    // A viewer pick outranks the navigation tints: the picked row answers
    // "which feature made this face?", so it must read distinctly even when
    // it is also the current or active-part row. Light gray (base-content
    // wash, like the hover state) rather than primary, so it never reads as
    // navigation. Tailwind resolves competing bg- classes by stylesheet
    // order, not class order — a branch, not an append.
    if (isPicked) {
      itemClass += ' bg-base-content/10 ring-1 ring-inset ring-base-content/30';
      if (this.pickedFlash) {
        itemClass += ' animate-[timeline-pick-flash_0.9s_ease-out] motion-reduce:animate-none';
      }
    } else if (highlightCurrent) {
      itemClass += ' border-l-2 border-primary bg-primary/10';
    } else if (isActivePart) {
      itemClass += ' bg-primary/10';
    }
    if (effectiveError) {
      itemClass += ' text-error';
    } else if (highlightCurrent || isActivePart) {
      itemClass += ' text-primary';
    } else if (isPast || isInvisible) {
      itemClass += ' text-base-content/60';
    } else {
      itemClass += ' text-base-content/80';
    }

    const imgClass = isInvisible ? 'w-4 h-4 object-contain grayscale opacity-60' : 'w-4 h-4 object-contain';
    const errorDot = effectiveError
      ? `<span class="text-error shrink-0 [&>svg]:w-2.5 [&>svg]:h-2.5">${ICON_ALERT_DOT}</span>`
      : '';

    let chevron = '';
    if (hasChildren) {
      const rotation = isCollapsed ? '' : 'rotate-90';
      chevron = `<span data-toggle="${obj.id}" class="flex items-center justify-center w-5 h-5 opacity-50 hover:opacity-100 transition-transform ${rotation}">
        ${ICON_CHEVRON_RIGHT}
      </span>`;
    } else {
      chevron = '<span class="w-4"></span>';
    }

    const showDuration = this.showBuildTimings && !obj.fromCache && obj.buildDurationMs != null;
    const durationSpan = showDuration
      ? `<span class="ml-auto shrink-0 text-xs text-base-content/40 tabular-nums">${formatDuration(obj.buildDurationMs!)}</span>`
      : '';

    const statusIconClass = showDuration
      ? 'shrink-0 text-base-content/40 [&>svg]:w-4 [&>svg]:h-4'
      : 'ml-auto shrink-0 text-base-content/40 [&>svg]:w-4 [&>svg]:h-4';
    const statusIcon = obj.fromCache
      ? `<span class="${statusIconClass}">${ICON_CIRCLE_CHECK}</span>`
      : `<span class="${statusIconClass}">${ICON_REFRESH}</span>`;

    const activeDot = isActivePart
      ? '<span class="ml-0.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" title="Active part — new features land inside its body"></span>'
      : '';

    return `
      <div class="${itemClass}" data-index="${index}" data-rollback-index="${rollbackIndex}" data-container="${obj.isContainer ?? false}" data-current="${isCurrent}" data-active-part="${isActivePart}" data-picked="${isPicked}">
        ${chevron}
        ${errorDot}
        <img src="${iconSrc}" ${ICON_IMG_FALLBACK} class="${imgClass}" alt="" />
        <span class="truncate">${name}</span>
        ${activeDot}
        ${durationSpan}
        ${statusIcon}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Build timings
  // ---------------------------------------------------------------------------

  private hasBuildTimings(): boolean {
    return this.sceneObjects.some(
      (o) => !o.parentId && !o.fromCache && o.buildDurationMs != null,
    );
  }

  private updateHistoryTotal(): void {
    if (!this.showBuildTimings) {
      this.historyTotalLabel.classList.add('hidden');
      return;
    }
    let total = 0;
    let hasAny = false;
    for (const obj of this.sceneObjects) {
      if (obj.parentId) {
        continue;
      }
      if (obj.fromCache || obj.buildDurationMs == null) {
        continue;
      }
      total += obj.buildDurationMs;
      hasAny = true;
    }
    if (!hasAny) {
      this.historyTotalLabel.classList.add('hidden');
      return;
    }
    this.historyTotalLabel.textContent = `· ${formatDuration(total)}`;
    this.historyTotalLabel.classList.remove('hidden');
  }

  dispose(): void {
    if (this.activeDropdown) {
      this.activeDropdown.remove();
      this.activeDropdown = null;
    }
    if (this.dropdownCleanup) {
      this.dropdownCleanup();
      this.dropdownCleanup = null;
    }
    if (this.hoverPopover) {
      this.hoverPopover.remove();
      this.hoverPopover = null;
    }
    this.panel.remove();
  }

  private applyPanelWidth(): void {
    this.panel.classList.toggle('w-[220px]', !this.showBuildTimings);
    this.panel.classList.toggle('w-[270px]', this.showBuildTimings);
  }

  // ---------------------------------------------------------------------------
  // History dropdown
  // ---------------------------------------------------------------------------

  private showHistoryDropdown(anchor: HTMLElement): void {
    this.closeDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - panelRect.top + 2}px`;
    dropdown.style.right = `${panelRect.right - rect.right}px`;

    const checkIcon = this.showBuildTimings
      ? `<span class="flex items-center justify-center w-4 h-4 shrink-0 text-primary [&>svg]:size-3">${ICON_CHECK}</span>`
      : `<span class="w-4 h-4 shrink-0"></span>`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[180px]">
        <li><button data-action="recompute" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_REFRESH}</span>
          <span>Recompute scene</span>
        </button></li>
        <li><button data-action="toggle-timings" class="flex items-center gap-2">
          ${checkIcon}
          <span>Show execution time</span>
        </button></li>
      </ul>
    `;

    this.panel.appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="toggle-timings"]')!.addEventListener('click', () => {
      const next = !this.showBuildTimings;
      this.showBuildTimings = next;
      this.applyPanelWidth();
      this.updateHistoryTotal();
      this.client.savePreference('showBuildTimings', next);
      this.closeDropdown();
      this.renderTimeline();
      // Build timings are only recorded for objects that actually rebuild, so
      // enabling the toggle on a fully-cached scene would show nothing. Force a
      // fresh recompute so the times populate immediately.
      if (next && !this.hasBuildTimings()) {
        this.recomputeScene();
      }
    });

    dropdown.querySelector('[data-action="recompute"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.recomputeScene();
    });

    const onClickOutside = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
    this.dropdownCleanup = () => document.removeEventListener('click', onClickOutside);
  }

  // ---------------------------------------------------------------------------
  // Row context menu
  // ---------------------------------------------------------------------------

  /**
   * Right-click menu on a timeline row: "Rename" swaps the menu for an
   * inline input editing the feature's chained `.name('…')`, "Edit feature"
   * runs the double-click gesture (breakpoint after the row plus the
   * feature's edit dialog), "Breakpoint here" places the breakpoint after
   * the row without opening a dialog and "Remove" deletes the feature's
   * statement from the code. Rows without a source location get no menu —
   * none of the actions can target them.
   */
  private showRowContextMenu(e: MouseEvent, index: number): void {
    this.closeDropdown();
    // Every menu action edits or navigates source — nothing to offer
    // without an editor-backed host.
    if (!this.client.editor) {
      return;
    }
    const obj = this.sceneObjects[index];
    if (!obj || !obj.sourceLocation) {
      return;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const panelRect = this.panel.getBoundingClientRect();
    dropdown.style.left = `${e.clientX - panelRect.left}px`;
    dropdown.style.top = `${e.clientY - panelRect.top}px`;

    // The edit action mirrors double-click: only rows with an edit dialog
    // offer it, and those work even while sketching — the dialog suspends
    // the sketch UI itself and restores it on exit.
    const editItem = this.isFeatureEditable?.(obj) !== true ? '' : `
        <li><button data-action="edit" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_ADJUSTMENTS}</span>
          <span>Edit feature</span>
        </button></li>`;
    // The breakpoint action is timeline navigation — absent while sketching,
    // except on the active sketch's own children: a breakpoint there replays
    // the sketch up to that shape without leaving sketch mode.
    const activeSketchChild = this.sketchActive && obj.parentId != null
      && findActiveObject(this.sceneObjects)?.id === obj.parentId;
    const breakpointItem = this.sketchActive && !activeSketchChild ? '' : `
        <li><button data-action="rollback" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_PAUSE}</span>
          <span>Breakpoint here</span>
        </button></li>`;
    const tangencyAction = this.distanceTangencyAction(obj);
    const tangencyItem = !tangencyAction ? '' : `
        <li><button data-action="tangency" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_REFRESH}</span>
          <span>${tangencyAction.label}</span>
        </button></li>`;
    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        <li><button data-action="rename" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_PENCIL}</span>
          <span>Rename</span>
        </button></li>${editItem}${tangencyItem}${breakpointItem}
        <li><button data-action="remove" class="flex items-center gap-2 text-error">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_TRASH}</span>
          <span>Remove</span>
        </button></li>
      </ul>
    `;

    this.panel.appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="rename"]')!.addEventListener('click', (e) => {
      // Swapping to the input detaches the clicked button; without this the
      // bubbling click reaches the click-outside handler with a target no
      // longer inside the dropdown and instantly closes the menu.
      e.stopPropagation();
      this.showRenameInput(dropdown, obj);
    });

    dropdown.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
      this.closeDropdown();
      this.enterBreakpointAt(index);
    });

    dropdown.querySelector('[data-action="rollback"]')?.addEventListener('click', () => {
      this.closeDropdown();
      // Same scope rule as the edit gesture: the pause makes this row's part
      // the working scope, so a paused tip sketch actually enters sketch mode.
      this.activateEnclosingPart(obj);
      this.addBreakpointAfter(index);
      this.goToSource(obj);
    });

    dropdown.querySelector('[data-action="tangency"]')?.addEventListener('click', () => {
      this.closeDropdown();
      void setDistanceTangency({
        line: obj.sourceLocation!.line,
        filePath: obj.sourceLocation!.filePath,
        tangency: tangencyAction!.tangency,
      });
    });

    dropdown.querySelector('[data-action="remove"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.client.editor?.removeFeature(obj.sourceLocation!);
    });

    const onClickOutside = (ev: MouseEvent) => {
      if (!dropdown.contains(ev.target as Node)) {
        this.closeDropdown();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', onClickOutside);
      document.addEventListener('contextmenu', onClickOutside);
    }, 0);
    this.dropdownCleanup = () => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('contextmenu', onClickOutside);
    };
  }

  /**
   * The tangency rewrite a distance-constraint row offers ("Use min/max
   * tangent" — flip which side of the circle/arc the dimension measures
   * to), or null when the row isn't a distance against a circle/arc.
   */
  private distanceTangencyAction(
    obj: SceneObjectRender,
  ): { label: string; tangency: 'min' | 'max' } | null {
    if (obj.uniqueType !== 'constraint-distance' || !obj.sourceLocation) {
      return null;
    }
    const spec = obj.object?.spec;
    if (!spec || spec.axis !== undefined) {
      return null;
    }
    // Tangency needs a circle/arc ENTITY reference (a ref without a point
    // role, resolving to a sibling solved-circle/arc row).
    const hasRound = [spec.a, spec.b].some((ref: { entity: number; point?: string } | undefined) =>
      ref && ref.point === undefined && this.sceneObjects.some(o =>
        o.parentId === obj.parentId
        && (o.uniqueType === 'solved-circle' || o.uniqueType === 'solved-arc')
        && o.object?.entityId === ref.entity));
    if (!hasRound) {
      return null;
    }
    return spec.tangency === 'max'
      ? { label: 'Use min tangent', tangency: 'min' }
      : { label: 'Use max tangent', tangency: 'max' };
  }

  /**
   * Swap the row context menu's content for an inline rename input. The
   * input edits the feature's chained `.name('…')`: Enter commits (an empty
   * value clears the chain, reverting to the default name), Escape or the
   * menu's click-outside handler dismisses without committing.
   */
  private showRenameInput(dropdown: HTMLDivElement, obj: SceneObjectRender): void {
    const type = obj.type ?? '';
    const defaultName = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Feature';
    const currentName = obj.hasCustomName ? (obj.name ?? '') : '';

    dropdown.innerHTML = `
      <div class="p-1.5 w-[180px]">
        <input data-ref="rename-input" type="text" spellcheck="false"
          class="input input-xs input-bordered w-full bg-transparent"
          placeholder="${this.escapeHtml(defaultName)}" />
      </div>
    `;

    const input = dropdown.querySelector<HTMLInputElement>('[data-ref="rename-input"]')!;
    input.value = currentName;
    input.focus();
    input.select();

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const next = input.value.trim();
        if (next !== currentName) {
          this.client.editor?.renameFeature(obj.sourceLocation!, next || null);
        }
        this.closeDropdown();
      } else if (e.key === 'Escape') {
        this.closeDropdown();
      }
    });
  }

  private closeDropdown(): void {
    if (this.activeDropdown) {
      this.activeDropdown.remove();
      this.activeDropdown = null;
    }
    if (this.dropdownCleanup) {
      this.dropdownCleanup();
      this.dropdownCleanup = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Profile popover
  // ---------------------------------------------------------------------------

  private showProfilePopover(
    anchor: HTMLElement,
    categories: { category: string; durationMs: number }[],
    totalBuildMs?: number,
  ): void {
    this.closeProfilePopover();

    const popover = document.createElement('div');
    popover.className = 'absolute z-[201] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-3 min-w-[200px] max-w-[280px]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    popover.style.left = `${rect.right - panelRect.left + 8}px`;
    popover.style.top = `${Math.max(0, rect.top - panelRect.top - 4)}px`;

    const profiledTotal = categories.reduce((sum, c) => sum + c.durationMs, 0);
    const displayRows: { category: string; durationMs: number; isOther?: boolean }[] = categories.map(c => ({ ...c }));
    if (totalBuildMs !== undefined && totalBuildMs - profiledTotal > 0.5) {
      displayRows.push({
        category: 'Other',
        durationMs: Math.round((totalBuildMs - profiledTotal) * 10) / 10,
        isOther: true,
      });
    }
    const maxDuration = Math.max(...displayRows.map(c => c.durationMs), 0.1);

    let rowsHtml = '';
    for (const cat of displayRows) {
      const pct = maxDuration > 0 ? (cat.durationMs / maxDuration) * 100 : 0;
      const barColor = cat.isOther
        ? 'bg-base-content/25'
        : pct > 60 ? 'bg-warning/60' : 'bg-primary/40';
      rowsHtml += `
        <div class="mb-1.5">
          <div class="flex justify-between text-xs mb-0.5">
            <span class="text-base-content/80 truncate mr-2">${this.escapeHtml(cat.category)}</span>
            <span class="text-base-content/50 tabular-nums shrink-0">${formatDuration(cat.durationMs)}</span>
          </div>
          <div class="h-1 rounded-full bg-base-content/10 overflow-hidden">
            <div class="h-full rounded-full ${barColor}" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }

    const footerHtml = totalBuildMs !== undefined
      ? `<div class="flex justify-between text-xs text-base-content/40 mt-1 pt-1 border-t border-base-content/10">
           <span>Total</span>
           <span class="tabular-nums">${formatDuration(totalBuildMs)}</span>
         </div>`
      : '';

    popover.innerHTML = `
      <div class="text-xs font-medium text-base-content/60 mb-2">Build Time Breakdown</div>
      ${rowsHtml}
      ${footerHtml}
    `;

    this.panel.appendChild(popover);
    this.hoverPopover = popover;
  }

  private closeProfilePopover(): void {
    if (this.hoverPopover) {
      this.hoverPopover.remove();
      this.hoverPopover = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private recomputeScene(): void {
    this.client.recompute();
  }

  private rollbackTo(index: number): void {
    // One-click preview: scope the rollback to the clicked row's enclosing
    // part — the rest of the scene keeps its full render. Rows outside any
    // part (and hosts that predate the scope) fall back to the global
    // prefix server-side.
    this.client.rollback(index, 'part');
  }

  private addBreakpointAfter(index: number): void {
    const obj = this.sceneObjects[index];
    if (!obj || !obj.sourceLocation) {
      return;
    }
    this.client.editor?.addBreakpoint(obj.sourceLocation);
  }

  private goToSource(obj: SceneObjectRender | undefined): void {
    if (!obj || !obj.sourceLocation) {
      return;
    }
    this.client.editor?.gotoSource(obj.sourceLocation);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

}
