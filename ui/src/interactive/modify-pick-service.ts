import { applyFeature, expandBucket, expandTangents, explainSelection, ApplyFeatureChain, ApplyFeatureResponse } from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, SubSelection } from '../types';
import { SelectedEntity, Viewer } from '../viewer';
import { Navbar } from '../ui/navbar';
import { ICON_IMG_FALLBACK } from '../ui/object-icons';

export type ModifyFeatureKind = 'fillet' | 'chamfer';

const FEATURES: Record<ModifyFeatureKind, { label: string; valueLabel: string; defaultValue: number }> = {
  fillet: { label: 'Fillet', valueLabel: 'Radius', defaultValue: 1 },
  chamfer: { label: 'Chamfer', valueLabel: 'Distance', defaultValue: 1 },
};

/** Same artwork the timeline shows for the feature (`/icons/<type>.png`). */
function featureIconImg(kind: ModifyFeatureKind): string {
  return `<img src="/icons/${kind}.png" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />`;
}

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

const PREVIEW_DEBOUNCE_MS = 250;
const TOOLTIP_DEBOUNCE_MS = 200;

function sameEntity(a: SelectedEntity, b: SelectedEntity): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

function entityKey(e: SelectedEntity): string {
  return `${e.shapeId}:${e.sub.type}:${e.sub.index}`;
}

/**
 * Select→apply-feature pick mode: the `modify` toolbar group (Fillet /
 * Chamfer) arms a pick mode over edges and faces (a face selection means "all
 * edges of that face" — the features explode faces at build time); picks
 * accumulate as a highlighted selection; right-click offers "Select with
 * tangents" (the chain becomes a `.withTangents()` selector); the expression
 * row shows the synthesized code before Apply and is editable, with verified
 * alternatives in a dropdown; hovering shows the teach-mode attribution
 * tooltip. Apply asks the server to write the feature call into the source
 * file — the re-render is the preview and editor undo is the rollback.
 */
export class ModifyPickService {
  private feature: ModifyFeatureKind | null = null;
  private entities: SelectedEntity[] = [];
  private chains: { seed: SelectedEntity; members: SelectedEntity[] }[] = [];

  private buttons = new Map<ModifyFeatureKind, HTMLButtonElement>();
  private activeBar: HTMLDivElement;
  private titleIcon: HTMLElement;
  private titleText: HTMLElement;
  private valueLabel: HTMLElement;
  private valueInput: HTMLInputElement;
  private countText: HTMLElement;
  private applyBtn: HTMLButtonElement;
  private message: HTMLDivElement;
  private applying = false;

  private exprRow: HTMLDivElement;
  private exprPrefix: HTMLElement;
  private exprInput: HTMLInputElement;
  private altBtn: HTMLButtonElement;
  private altMenu: HTMLDivElement;
  private synthesizedArgs: string | null = null;
  private alternatives: string[] = [];
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  private tooltip: HTMLDivElement;
  private tooltipTimer: number | null = null;
  private tooltipAbort: AbortController | null = null;
  private tooltipCache = new Map<string, string>();

  private contextMenu: HTMLDivElement;

  constructor(
    private container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: { onEnter?: () => SelectedEntity[] | void } = {},
  ) {
    const group = navbar.addGroup('modify', { visible: false });
    for (const kind of ['fillet', 'chamfer'] as ModifyFeatureKind[]) {
      const btn = document.createElement('button');
      btn.className = BTN_BASE;
      btn.title = `${FEATURES[kind].label} edges`;
      btn.innerHTML = featureIconImg(kind);
      btn.addEventListener('click', () => {
        if (this.feature === kind) {
          this.exit();
        } else {
          this.enter(kind);
        }
      });
      group.appendChild(btn);
      this.buttons.set(kind, btn);
    }

    this.activeBar = document.createElement('div');
    this.activeBar.id = 'fluidcad-modify-pick-active';
    this.activeBar.className = 'absolute top-[116px] right-[76px] z-[999] pointer-events-auto hidden';
    this.activeBar.innerHTML = `
      <div class="flex flex-col items-end gap-1.5">
        <div class="flex items-center gap-2 bg-info text-info-content rounded-lg px-3 py-2 text-xs leading-none select-none shadow-md">
          <span class="[&>svg]:size-4" data-role="icon"></span>
          <span data-role="title">Fillet</span>
          <div class="h-3.5 w-px bg-info-content/25"></div>
          <label class="flex items-center gap-1">
            <span class="text-info-content/70" data-role="value-label">Radius</span>
            <input data-role="value" type="number" min="0.05" step="0.5"
              class="w-14 bg-info-content/15 rounded px-1.5 py-1 text-info-content text-xs outline-none focus:bg-info-content/25" />
          </label>
          <div class="h-3.5 w-px bg-info-content/25"></div>
          <span data-role="count" class="text-info-content/80 whitespace-nowrap">0 edges</span>
          <button data-role="apply"
            class="bg-info-content text-info rounded px-2.5 py-1 font-medium cursor-pointer transition-opacity disabled:opacity-40 disabled:cursor-default">Apply</button>
          <button data-role="exit" class="text-info-content/70 hover:text-info-content transition-colors cursor-pointer">Exit</button>
        </div>
        <div data-role="expr-row"
          class="hidden relative items-center gap-1 bg-base-100 border border-base-300 rounded-lg pl-2.5 pr-1 py-1.5 text-xs shadow-md">
          <span data-role="expr-prefix" class="font-mono text-base-content/50 select-none whitespace-nowrap"></span>
          <input data-role="expr" type="text" spellcheck="false" autocomplete="off"
            class="font-mono w-[320px] bg-transparent text-base-content outline-none" />
          <span class="font-mono text-base-content/50 select-none">)</span>
          <button data-role="alts" title="Alternative selectors"
            class="hidden text-base-content/50 hover:text-base-content px-1 cursor-pointer transition-colors">▾</button>
          <div data-role="alts-menu"
            class="hidden absolute top-full right-0 mt-1 z-[1000] min-w-full bg-base-100 border border-base-300 rounded-lg shadow-lg py-1"></div>
        </div>
        <div data-role="message" class="hidden max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md"></div>
      </div>
    `;
    container.appendChild(this.activeBar);

    this.titleIcon = this.activeBar.querySelector('[data-role="icon"]')!;
    this.titleText = this.activeBar.querySelector('[data-role="title"]')!;
    this.valueLabel = this.activeBar.querySelector('[data-role="value-label"]')!;
    this.valueInput = this.activeBar.querySelector('[data-role="value"]')!;
    this.countText = this.activeBar.querySelector('[data-role="count"]')!;
    this.applyBtn = this.activeBar.querySelector('[data-role="apply"]')!;
    this.message = this.activeBar.querySelector('[data-role="message"]')!;
    this.exprRow = this.activeBar.querySelector('[data-role="expr-row"]')!;
    this.exprPrefix = this.activeBar.querySelector('[data-role="expr-prefix"]')!;
    this.exprInput = this.activeBar.querySelector('[data-role="expr"]')!;
    this.altBtn = this.activeBar.querySelector('[data-role="alts"]')!;
    this.altMenu = this.activeBar.querySelector('[data-role="alts-menu"]')!;

    this.applyBtn.addEventListener('click', () => this.apply());
    this.activeBar.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.exit());
    this.valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
      e.stopPropagation();
    });
    this.valueInput.addEventListener('input', () => this.syncExprPrefix());
    this.exprInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
      e.stopPropagation();
    });
    this.altBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.altMenu.classList.toggle('hidden');
    });

    // Teach-mode tooltip: follows the hovered edge/face while the mode is armed.
    this.tooltip = document.createElement('div');
    this.tooltip.id = 'fluidcad-modify-pick-tooltip';
    this.tooltip.className = 'hidden absolute z-[1001] pointer-events-none max-w-[420px] '
      + 'bg-base-100/95 border border-base-300 rounded px-2 py-1 font-mono text-[11px] text-base-content shadow-md';
    container.appendChild(this.tooltip);

    // Right-click menu ("Select with tangents").
    this.contextMenu = document.createElement('div');
    this.contextMenu.id = 'fluidcad-modify-pick-menu';
    this.contextMenu.className = 'hidden absolute z-[1002] bg-base-100 border border-base-300 rounded-lg shadow-lg py-1 text-xs';
    container.appendChild(this.contextMenu);

    document.addEventListener('click', (e) => {
      if (!this.contextMenu.classList.contains('hidden') && !this.contextMenu.contains(e.target as Node)) {
        this.hideContextMenu();
      }
      if (!this.altMenu.classList.contains('hidden')
        && !this.altMenu.contains(e.target as Node) && e.target !== this.altBtn) {
        this.altMenu.classList.add('hidden');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!this.feature) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!this.contextMenu.classList.contains('hidden')) {
          this.hideContextMenu();
          return;
        }
        if (!this.altMenu.classList.contains('hidden')) {
          this.altMenu.classList.add('hidden');
          return;
        }
        this.exit();
      } else if (e.key === 'Enter'
        && document.activeElement !== this.valueInput
        && document.activeElement !== this.exprInput) {
        e.preventDefault();
        this.apply();
      }
    });
  }

  get isActive(): boolean {
    return this.feature !== null;
  }

  /**
   * Scene re-rendered: recompute toolbar visibility (solids present, not in
   * sketch mode) and drop the now-stale selection while keeping the mode armed.
   */
  update(sceneObjects: SceneObjectRender[]): void {
    const hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    const active = this.findActiveObject(sceneObjects);
    const sketchMode = active?.type === 'sketch';
    const visible = hasSolid && !sketchMode;

    this.tooltipCache.clear();
    this.hideTooltip();
    this.hideContextMenu();
    this.navbar.setGroupVisible('modify', visible);
    if (this.feature && !visible) {
      this.exit();
      return;
    }
    if (this.feature) {
      // Shape ids may have changed; the viewer already cleared highlights.
      this.entities = [];
      this.chains = [];
      this.refresh();
    }
  }

  enter(feature: ModifyFeatureKind): void {
    const wasActive = this.feature !== null;
    this.feature = feature;
    // The hook hands over whatever was highlighted before the mode armed
    // (and clears that owner's selection) — those picks become the tool's
    // initial input. Switching fillet↔chamfer keeps the in-mode selection.
    const seed = this.hooks.onEnter?.();
    if (!wasActive) {
      this.entities = Array.isArray(seed) ? [...seed] : [];
      this.chains = [];
    }
    this.viewer.clearHover();

    this.titleIcon.innerHTML = featureIconImg(feature);
    this.titleText.textContent = `${FEATURES[feature].label} mode`;
    this.valueLabel.textContent = FEATURES[feature].valueLabel;
    if (!this.valueInput.value) {
      this.valueInput.value = String(FEATURES[feature].defaultValue);
    }
    this.activeBar.classList.remove('hidden');
    this.setMessage(null);
    this.refresh();
    this.viewer.highlightEntities(this.entities);
  }

  exit(): void {
    if (!this.feature) {
      return;
    }
    this.feature = null;
    this.entities = [];
    this.chains = [];
    this.cancelPreview();
    this.hideExpression();
    this.hideTooltip();
    this.hideContextMenu();
    this.viewer.clearHighlight();
    this.activeBar.classList.add('hidden');
    this.setMessage(null);
    this.syncButtons();
  }

  /**
   * Routes viewer clicks while the mode is armed. Plain clicks accumulate
   * (fillet is inherently multi-pick); clicking a selected entity deselects
   * it (a chain member deselects its whole chain); clicking empty space keeps
   * the selection (misclicks shouldn't wipe it).
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.feature || !shapeId || !sub) {
      return;
    }
    this.hideContextMenu();
    this.setMessage(null);
    const entity: SelectedEntity = { shapeId, sub };
    const chain = this.chains.find(c => c.members.some(m => sameEntity(m, entity)));
    if (chain) {
      const memberKeys = new Set(chain.members.map(entityKey));
      this.entities = this.entities.filter(e => !memberKeys.has(entityKey(e)));
      this.chains = this.chains.filter(c => c !== chain);
    } else {
      const existing = this.entities.findIndex(e => sameEntity(e, entity));
      if (existing >= 0) {
        this.entities = this.entities.filter((_, i) => i !== existing);
      } else {
        this.entities = [...this.entities, entity];
      }
    }
    if (this.entities.length > 0) {
      this.viewer.highlightEntities(this.entities);
    } else {
      this.viewer.clearHighlight();
    }
    this.refresh();
  }

  /**
   * Double-click: expand the pick to its whole classified bucket ("the whole
   * top rim"). The gesture's own two single clicks have already toggled the
   * entity; the expansion merges every surviving bucket member as a plain
   * pick, so the seed ends up selected either way.
   */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    if (!this.feature || !shapeId || !sub) {
      return;
    }
    this.hideContextMenu();
    this.hideTooltip();

    const entity: SelectedEntity = { shapeId, sub };
    const result = await expandBucket(entity);
    if (!this.feature) {
      return;
    }
    if ('error' in result) {
      this.setMessage(result.error);
      return;
    }
    this.setMessage(null);
    const have = new Set(this.entities.map(entityKey));
    const added = result.members
      .map(m => ({ shapeId: m.shapeId, sub: m.sub }))
      .filter(m => !have.has(entityKey(m)));
    if (added.length > 0) {
      this.entities = [...this.entities, ...added];
      this.viewer.highlightEntities(this.entities);
      this.refresh();
    }
  }

  /** Teach-mode tooltip: hover → attribution expression, debounced + cached. */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.feature) {
      return;
    }
    if (this.tooltipTimer !== null) {
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = null;
    }
    if (!shapeId || !sub) {
      this.hideTooltip();
      return;
    }
    if (!this.contextMenu.classList.contains('hidden')) {
      return;
    }

    const entity: SelectedEntity = { shapeId, sub };
    const key = entityKey(entity);
    const cached = this.tooltipCache.get(key);
    if (cached !== undefined) {
      this.showTooltip(cached, clientX, clientY);
      return;
    }

    this.tooltipTimer = window.setTimeout(async () => {
      this.tooltipTimer = null;
      this.tooltipAbort?.abort();
      const abort = new AbortController();
      this.tooltipAbort = abort;
      try {
        const result = await explainSelection([entity], abort.signal);
        if (abort.signal.aborted || !this.feature) {
          return;
        }
        const pick = result?.picks?.[0];
        const text = pick?.expression
          ?? pick?.error
          ?? (pick && !pick.attributed
            ? 'no classified origin — a geometric select() will be synthesized'
            : null);
        if (text) {
          this.tooltipCache.set(key, text);
          this.showTooltip(text, clientX, clientY);
        }
      } catch {
        // Aborted or unreachable — no tooltip.
      }
    }, TOOLTIP_DEBOUNCE_MS);
  }

  /** Right-click on an edge/face: offer tangent-chain selection. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.feature) {
      return;
    }
    this.hideContextMenu();
    if (!shapeId || !sub) {
      return;
    }
    this.hideTooltip();

    const entity: SelectedEntity = { shapeId, sub };
    const item = document.createElement('button');
    item.className = 'block w-full text-left px-3 py-1.5 hover:bg-base-200 cursor-pointer whitespace-nowrap';
    item.textContent = 'Select with tangents';
    item.addEventListener('click', async () => {
      this.hideContextMenu();
      const result = await expandTangents(entity);
      if (!this.feature) {
        return;
      }
      if ('error' in result) {
        this.setMessage(result.error);
        return;
      }
      this.addChain(entity, result.members.map(m => ({ shapeId: m.shapeId, sub: m.sub })));
    });
    this.contextMenu.replaceChildren(item);

    const rect = this.container.getBoundingClientRect();
    this.contextMenu.style.left = `${clientX - rect.left}px`;
    this.contextMenu.style.top = `${clientY - rect.top}px`;
    this.contextMenu.classList.remove('hidden');
  }

  private addChain(seed: SelectedEntity, members: SelectedEntity[]): void {
    this.setMessage(null);
    // The chain owns its members: drop overlapping plain picks and chains.
    const memberKeys = new Set(members.map(entityKey));
    this.chains = this.chains.filter(c => !c.members.some(m => memberKeys.has(entityKey(m))));
    this.entities = [
      ...this.entities.filter(e => !memberKeys.has(entityKey(e))),
      ...members,
    ];
    this.chains.push({ seed, members });
    this.viewer.highlightEntities(this.entities);
    this.refresh();
  }

  private async apply(): Promise<void> {
    if (!this.feature || this.applying) {
      return;
    }
    if (this.entities.length === 0) {
      this.setMessage('Pick at least one edge or face first.');
      return;
    }
    const value = parseFloat(this.valueInput.value);
    if (!Number.isFinite(value) || value <= 0) {
      this.setMessage(`Enter a positive ${FEATURES[this.feature].valueLabel.toLowerCase()}.`);
      return;
    }

    const edited = this.exprInput.value.trim();
    const selectorOverride = this.synthesizedArgs !== null && edited !== '' && edited !== this.synthesizedArgs
      ? edited
      : undefined;

    this.applying = true;
    this.applyBtn.disabled = true;
    try {
      const result = await applyFeature(this.feature, value, this.entities, {
        chains: this.apiChains(),
        selectorOverride,
      });
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit();
      } else {
        this.setMessage(result.reason ?? 'Could not apply the feature.');
      }
    } finally {
      this.applying = false;
      this.applyBtn.disabled = false;
    }
  }

  private refresh(): void {
    const edges = this.entities.filter(e => e.sub.type === 'edge').length;
    const faces = this.entities.length - edges;
    const parts: string[] = [];
    if (edges > 0) {
      parts.push(`${edges} edge${edges === 1 ? '' : 's'}`);
    }
    if (faces > 0) {
      parts.push(`${faces} face${faces === 1 ? '' : 's'}`);
    }
    if (this.chains.length > 0) {
      parts.push(`${this.chains.length} chain${this.chains.length === 1 ? '' : 's'}`);
    }
    this.countText.textContent = parts.length > 0 ? parts.join(' + ') : '0 selected';
    this.syncButtons();
    this.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Expression transparency: debounced synthesis preview + alternatives
  // -------------------------------------------------------------------------

  private schedulePreview(): void {
    this.cancelPreview();
    if (!this.feature || this.entities.length === 0) {
      this.hideExpression();
      return;
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    if (!this.feature) {
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    // The argument list is independent of the numeric parameter; any valid
    // value satisfies the endpoint.
    const value = parseFloat(this.valueInput.value);
    const previewValue = Number.isFinite(value) && value > 0 ? value : 1;

    let result: ApplyFeatureResponse;
    try {
      result = await applyFeature(this.feature, previewValue, this.entities, {
        chains: this.apiChains(),
        preview: true,
        signal: abort.signal,
      });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.feature) {
      return;
    }

    if (result.success && typeof result.args === 'string') {
      this.synthesizedArgs = result.args;
      this.alternatives = result.alternatives ?? [];
      this.exprInput.value = result.args;
      this.syncExprPrefix();
      this.renderAlternatives();
      this.exprRow.classList.remove('hidden');
      this.exprRow.classList.add('flex');
      this.setMessage(null);
    } else {
      this.hideExpression();
      this.setMessage(result.reason ?? 'Could not synthesize a selector.');
    }
  }

  private renderAlternatives(): void {
    if (this.alternatives.length === 0) {
      this.altBtn.classList.add('hidden');
      this.altMenu.classList.add('hidden');
      return;
    }
    this.altBtn.classList.remove('hidden');
    this.altMenu.replaceChildren(...this.alternatives.map(args => {
      const item = document.createElement('button');
      item.className = 'block w-full text-left px-3 py-1.5 font-mono text-[11px] hover:bg-base-200 cursor-pointer whitespace-nowrap';
      item.textContent = args;
      item.addEventListener('click', () => {
        this.exprInput.value = args;
        this.altMenu.classList.add('hidden');
      });
      return item;
    }));
  }

  private syncExprPrefix(): void {
    if (!this.feature) {
      return;
    }
    const value = this.valueInput.value.trim() || String(FEATURES[this.feature].defaultValue);
    this.exprPrefix.textContent = `${this.feature}(${value}, `;
  }

  private hideExpression(): void {
    this.exprRow.classList.add('hidden');
    this.exprRow.classList.remove('flex');
    this.altMenu.classList.add('hidden');
    this.synthesizedArgs = null;
    this.alternatives = [];
    this.exprInput.value = '';
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.previewSeq++;
  }

  private apiChains(): ApplyFeatureChain[] {
    return this.chains.map(c => ({ seed: c.seed, members: c.members }));
  }

  // -------------------------------------------------------------------------
  // Tooltip / context-menu plumbing
  // -------------------------------------------------------------------------

  private showTooltip(text: string, clientX: number, clientY: number): void {
    const rect = this.container.getBoundingClientRect();
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${clientX - rect.left + 14}px`;
    this.tooltip.style.top = `${clientY - rect.top + 18}px`;
    this.tooltip.classList.remove('hidden');
  }

  private hideTooltip(): void {
    if (this.tooltipTimer !== null) {
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = null;
    }
    this.tooltipAbort?.abort();
    this.tooltipAbort = null;
    this.tooltip.classList.add('hidden');
  }

  private hideContextMenu(): void {
    this.contextMenu.classList.add('hidden');
  }

  private syncButtons(): void {
    for (const [kind, btn] of this.buttons) {
      btn.className = this.feature === kind ? BTN_ACTIVE : BTN_BASE;
    }
  }

  private setMessage(text: string | null): void {
    if (text) {
      this.message.textContent = text;
      this.message.classList.remove('hidden');
    } else {
      this.message.textContent = '';
      this.message.classList.add('hidden');
    }
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
}
