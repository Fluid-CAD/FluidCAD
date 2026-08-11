import type { SceneObjectRender } from '../types';
import { isTopLevel } from '../helpers/scene-utils';
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
 * reference holder, and the internal inputs a statement builds for itself
 * (the plane behind `sketch('xy', …)`) — they have no statement of their own,
 * so a row would offer navigation and edits that belong to the statement they
 * serve. Rows keep their scene index either way, so rollback targets and the
 * edit dialogs' row lookups are unaffected.
 */
function isHiddenRow(obj: SceneObjectRender): boolean {
  return obj.uniqueType === 'lazy-select' || obj.internal === true;
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
   * The scene ends with an unconsumed sketch (scene-derived sketch mode).
   * While it does, the timeline doesn't navigate: a rollback or breakpoint
   * would tear the sketch view down mid-edit. Row clicks still jump to
   * source and armed dialogs still consume rows; rename/remove stay.
   */
  private sketchActive = false;
  private collapsedIds = new Set<string>();
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
    // Docked below the top bars (top bar + navbar ≈ 92px) with breathing room.
    this.panel.className = 'absolute left-6 top-[116px] bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
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

  update(sceneObjects: SceneObjectRender[], rollbackStop: number): void {
    this.sceneObjects = sceneObjects;
    this.rollbackStop = rollbackStop;
    // Mirrors the viewer's sketch-mode derivation: a full (non-rolled-back)
    // render whose last top-level object is a sketch.
    this.sketchActive = rollbackStop >= sceneObjects.length - 1
      && this.findActiveObject(sceneObjects)?.type === 'sketch';
    this.loaded = true;
    this.syncVisibility();
    this.renderTimeline(true);
    this.shapesPanel.update(sceneObjects);
    this.updateHistoryTotal();
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

      html += this.renderTimelineItem(obj, i, rollbackStop, false, hasChildren, isCollapsed, effectiveError, rollbackIndex);

      if (hasChildren && !isCollapsed) {
        for (let j = 0; j < items.length; j++) {
          if (isHiddenRow(items[j])) {
            continue;
          }
          if (items[j].parentId === obj.id) {
            const childRollbackIndex = items[j].hideChildren === true ? this.lastDescendantIndex(items, j) : j;
            html += this.renderTimelineItem(items[j], j, rollbackStop, true, false, false, items[j].hasError === true, childRollbackIndex);
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
    if (!(obj && this.managesOwnBreakpoint?.(obj))) {
      this.addBreakpointAfter(index);
    }
    this.goToSource(obj);
    if (obj) {
      this.onFeatureEdit?.(obj, index);
    }
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

  private renderTimelineItem(obj: SceneObjectRender, index: number, rollbackStop: number, isChild: boolean, hasChildren: boolean, isCollapsed: boolean, effectiveError: boolean, rollbackIndex: number): string {
    // A row that stands in for hidden descendants (rollbackIndex > index) is
    // current whenever the rollback stop lands anywhere inside its range.
    const isCurrent = rollbackStop >= index && rollbackStop <= rollbackIndex;
    const isPast = index > rollbackStop;
    const isInvisible = obj.visible === false;
    const name = obj.name || 'Unknown';
    const iconSrc = obj.type === 'part' ? '/icons/box.png' : `/icons/${resolveIconName(obj.uniqueType, obj.type)}.png`;

    let itemClass = 'flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm';

    if (isChild) {
      itemClass += ' pl-7';
    }

    if (isCurrent) {
      itemClass += ' border-l-2 border-primary bg-primary/10';
    }
    if (effectiveError) {
      itemClass += ' text-error';
    } else if (isCurrent) {
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

    return `
      <div class="${itemClass}" data-index="${index}" data-rollback-index="${rollbackIndex}" data-container="${obj.isContainer ?? false}" data-current="${isCurrent}">
        ${chevron}
        ${errorDot}
        <img src="${iconSrc}" ${ICON_IMG_FALLBACK} class="${imgClass}" alt="" />
        <span class="truncate">${name}</span>
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
      && this.findActiveObject(this.sceneObjects)?.id === obj.parentId;
    const breakpointItem = this.sketchActive && !activeSketchChild ? '' : `
        <li><button data-action="rollback" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_PAUSE}</span>
          <span>Breakpoint here</span>
        </button></li>`;
    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        <li><button data-action="rename" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_PENCIL}</span>
          <span>Rename</span>
        </button></li>${editItem}${breakpointItem}
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
      this.addBreakpointAfter(index);
      this.goToSource(obj);
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
    this.client.rollback(index);
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

  /** Last root-level (or Part-child) object — mirrors Viewer.findActiveObject. */
  private findActiveObject(objects: SceneObjectRender[]): SceneObjectRender | undefined {
    for (let i = objects.length - 1; i >= 0; i--) {
      if (isTopLevel(objects[i], objects)) {
        return objects[i];
      }
    }
    return undefined;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

}
