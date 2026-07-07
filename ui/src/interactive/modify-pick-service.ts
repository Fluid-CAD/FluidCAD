import { applyFeature } from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, SubSelection } from '../types';
import { SelectedEntity, Viewer } from '../viewer';
import { Navbar } from '../ui/navbar';

const ICON_FILLET =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20v-8a8 8 0 0 1 8-8h8"/><path d="M4 20h3M20 4v3" opacity="0.4"/></svg>';
const ICON_CHAMFER =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20v-9l7-7h9"/><path d="M4 20h3M20 4v3" opacity="0.4"/></svg>';

export type ModifyFeatureKind = 'fillet' | 'chamfer';

const FEATURES: Record<ModifyFeatureKind, { label: string; valueLabel: string; icon: string; defaultValue: number }> = {
  fillet: { label: 'Fillet', valueLabel: 'Radius', icon: ICON_FILLET, defaultValue: 1 },
  chamfer: { label: 'Chamfer', valueLabel: 'Distance', icon: ICON_CHAMFER, defaultValue: 1 },
};

function sameEntity(a: SelectedEntity, b: SelectedEntity): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

/**
 * Select→apply-feature pick mode: the `modify` toolbar group (Fillet /
 * Chamfer) arms an edge-only pick mode; picked edges accumulate as a
 * highlighted selection; Apply asks the server to synthesize the selector
 * expression and write the feature call into the source file. The re-render is
 * the preview and editor undo is the rollback.
 */
export class ModifyPickService {
  private feature: ModifyFeatureKind | null = null;
  private entities: SelectedEntity[] = [];

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

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: { onEnter?: () => void } = {},
  ) {
    const group = navbar.addGroup('modify', { visible: false });
    for (const kind of ['fillet', 'chamfer'] as ModifyFeatureKind[]) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm gap-1.5 text-base-content/70 hover:text-base-content';
      btn.title = `${FEATURES[kind].label} edges`;
      btn.innerHTML = `<span class="[&>svg]:size-4">${FEATURES[kind].icon}</span><span class="text-sm font-normal">${FEATURES[kind].label}</span>`;
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

    this.applyBtn.addEventListener('click', () => this.apply());
    this.activeBar.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.exit());
    this.valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
      e.stopPropagation();
    });

    document.addEventListener('keydown', (e) => {
      if (!this.feature) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.exit();
      } else if (e.key === 'Enter' && document.activeElement !== this.valueInput) {
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

    this.navbar.setGroupVisible('modify', visible);
    if (this.feature && !visible) {
      this.exit();
      return;
    }
    if (this.feature) {
      // Shape ids may have changed; the viewer already cleared highlights.
      this.entities = [];
      this.refresh();
    }
  }

  enter(feature: ModifyFeatureKind): void {
    const wasActive = this.feature !== null;
    this.feature = feature;
    if (!wasActive) {
      this.entities = [];
    }
    this.hooks.onEnter?.();
    this.viewer.pickFilter = 'edge';
    this.viewer.clearHover();

    this.titleIcon.innerHTML = FEATURES[feature].icon;
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
    this.viewer.pickFilter = 'all';
    this.viewer.clearHighlight();
    this.activeBar.classList.add('hidden');
    this.setMessage(null);
    this.syncButtons();
  }

  /**
   * Routes viewer clicks while the mode is armed. Plain clicks accumulate
   * (fillet is inherently multi-edge); clicking a selected edge deselects it;
   * clicking empty space keeps the selection (misclicks shouldn't wipe it).
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.feature || !shapeId || !sub || sub.type !== 'edge') {
      return;
    }
    this.setMessage(null);
    const entity: SelectedEntity = { shapeId, sub };
    const existing = this.entities.findIndex(e => sameEntity(e, entity));
    if (existing >= 0) {
      this.entities = this.entities.filter((_, i) => i !== existing);
    } else {
      this.entities = [...this.entities, entity];
    }
    if (this.entities.length > 0) {
      this.viewer.highlightEntities(this.entities);
    } else {
      this.viewer.clearHighlight();
    }
    this.refresh();
  }

  private async apply(): Promise<void> {
    if (!this.feature || this.applying) {
      return;
    }
    if (this.entities.length === 0) {
      this.setMessage('Pick at least one edge first.');
      return;
    }
    const value = parseFloat(this.valueInput.value);
    if (!Number.isFinite(value) || value <= 0) {
      this.setMessage(`Enter a positive ${FEATURES[this.feature].valueLabel.toLowerCase()}.`);
      return;
    }

    this.applying = true;
    this.applyBtn.disabled = true;
    try {
      const result = await applyFeature(this.feature, value, this.entities);
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
    const n = this.entities.length;
    this.countText.textContent = `${n} edge${n === 1 ? '' : 's'}`;
    this.syncButtons();
  }

  private syncButtons(): void {
    for (const [kind, btn] of this.buttons) {
      btn.classList.toggle('btn-active', this.feature === kind);
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
