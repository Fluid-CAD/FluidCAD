import { ICON_SCALE } from './icons';
import type { EngineClient } from '../engine-client';
import type { Material, PartProperties, ShapeProperties } from '../api';
import type { SceneObjectRender, SourceLocation } from '../types';
import { ChoiceTabs } from '../interactive/create-feature/panel-controls';
import { SceneIndex } from '../helpers/scene-index';
import { findEnclosingPartRow, findMatchingRow } from '../helpers/scene-utils';
import { LENGTH_UNITS, convertLength, formatArea, formatLength, formatVolume, isLengthUnit } from '../units/units';
import type { LengthUnit } from '../units/units';
import { sceneUnit } from '../units/scene-unit';

export type ShapePropertiesMode = 'part' | 'solid';

/**
 * What the panel computes mass from: the material the enclosing part
 * declares (`part(...).material(id)`), the transient dropdown pick of a
 * solid outside any part, or nothing (a part without a material).
 */
type ResolvedMaterial = {
  /** The id in force, or null when nothing names one. */
  id: string | null;
  /** The merged-list entry for `id`; undefined for an unknown id (or none). */
  material: Material | undefined;
  /** Whether `id` is owned by a part statement (read-only) or the dropdown. */
  owner: 'part' | 'transient' | 'none';
};

/** The result rows, whichever mode computed them; lengths in `unit`. */
type PropertiesReadout = {
  volume: number;
  surfaceArea: number;
  centroid: { x: number; y: number; z: number };
  /** Grams, or null when no density is known (Mass reads "—"). */
  massG: number | null;
  unit: LengthUnit;
};

/**
 * Shape Properties: volume, surface area, mass and center of mass of one
 * solid (Solid mode, today's panel) or of a whole part's final solids (Part
 * mode, a server aggregate). Material is never typed: a solid inside a part
 * reads the part's `.material()` (read-only, with its density); a solid
 * outside any part picks from the merged materials list, transiently. Part
 * mode is read-only throughout — the material is set from the timeline
 * row's Set material… menu.
 */
export class ShapePropertiesModal {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private placeholderEl!: HTMLDivElement;
  private formEl!: HTMLDivElement;
  private selectEl!: HTMLSelectElement;
  private materialSelectBlock!: HTMLDivElement;
  private manageBtn!: HTMLButtonElement;
  private materialRow!: HTMLDivElement;
  private materialVal!: HTMLSpanElement;
  private densityVal!: HTMLSpanElement;
  private lengthUnitEl!: HTMLSelectElement;
  private massUnitEl!: HTMLSelectElement;
  private calcBtn!: HTMLButtonElement;
  private resultsEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;
  private volVal!: HTMLSpanElement;
  private areaVal!: HTMLSpanElement;
  private massVal!: HTMLSpanElement;
  private centroidVal!: HTMLSpanElement;
  private modeTabs!: ChoiceTabs<ShapePropertiesMode>;

  private materials: Material[] = [];
  private materialsById = new Map<string, Material>();
  private selectedShapeId: string | null = null;
  /**
   * Solid mode: the part the selected solid belongs to (undefined while it
   * belongs to none). Part mode: the selected part. Re-adopted by source
   * identity on every render, since scene ids are minted per build.
   */
  private partRow: SceneObjectRender | null = null;
  /** The dropdown's pick for a solid outside any part — never written to source. */
  private transientMaterialId: string | null = null;
  private rawProps: ShapeProperties | null = null;
  private partProps: PartProperties | null = null;
  private centroidHandler: ((centroid: { x: number; y: number; z: number } | null) => void) | null = null;
  private openHandler: (() => void) | null = null;
  private partSelectionHandler: ((part: SceneObjectRender | null) => void) | null = null;
  private manageMaterialsHandler: (() => void) | null = null;
  private sceneProvider: () => SceneObjectRender[] = () => [];
  private selectedPartProvider: () => SourceLocation | null = () => null;

  constructor(container: HTMLElement, private client: EngineClient) {
    this.btn = document.createElement('button');
    this.btn.className = 'btn btn-ghost btn-square btn-sm rounded-md absolute bottom-6 right-8 z-[100] panel-bg border border-base-content/10 text-base-content/60';
    this.btn.title = 'Shape Properties';
    this.btn.innerHTML = ICON_SCALE;
    container.appendChild(this.btn);

    this.panel = document.createElement('div');
    this.panel.className = 'absolute bottom-[68px] right-6 w-[300px] bg-base-100/95 backdrop-blur-xl border border-base-content/10 rounded-lg p-4 z-[200] shadow-[0_4px_24px_rgba(0,0,0,0.5)] text-base-content text-[13px] hidden';
    this.panel.innerHTML = this.buildHTML();
    container.appendChild(this.panel);

    this.bindRefs();
    this.bindEvents();
    void this.loadMaterials();
    // Results open in the document's own unit; the selector then converts
    // away from it. Follow the document when it changes (file switch).
    this.lengthUnitEl.value = sceneUnit.current;
    sceneUnit.subscribe((unit) => {
      this.lengthUnitEl.value = unit;
      this.renderResults();
    });
  }

  private buildHTML(): string {
    return `
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-semibold text-base-content/70 uppercase tracking-wider">Shape Properties</span>
        <button class="btn btn-ghost btn-xs btn-square" data-action="panel-close">×</button>
      </div>
      <div class="join w-full mb-3" data-ref="mode"></div>
      <div class="text-base-content/50 text-xs text-center py-2" data-ref="placeholder">Select a shape to view its properties</div>
      <div class="hidden" data-ref="form">
        <div class="flex gap-2 mb-2.5">
          <div class="flex-1">
            <label class="label text-[11px] uppercase tracking-wide">Length Unit</label>
            <select class="select select-sm select-bordered w-full" data-ref="length-unit">
              ${LENGTH_UNITS.map((u) => `<option value="${u.value}">${u.value}</option>`).join('')}
            </select>
          </div>
          <div class="flex-1">
            <label class="label text-[11px] uppercase tracking-wide">Mass Unit</label>
            <select class="select select-sm select-bordered w-full" data-ref="mass-unit">
              <option value="g">g</option>
              <option value="kg">kg</option>
              <option value="lbs">lbs</option>
            </select>
          </div>
        </div>
        <div class="mb-2.5" data-ref="material-select-block">
          <label class="label text-[11px] uppercase tracking-wide">Material</label>
          <select class="select select-sm select-bordered w-full" data-ref="material"></select>
          <button type="button" class="btn btn-link btn-xs px-0 h-auto min-h-0 mt-1 text-[11px] text-base-content/50 hidden" data-action="manage-materials">Manage materials…</button>
        </div>
        <div class="flex justify-between items-baseline py-0.5 hidden" data-ref="material-row">
          <span class="text-base-content/50 text-[11px]">Material</span>
          <span class="text-base-content/90 text-xs font-medium truncate ml-3" data-ref="material-value">—</span>
        </div>
        <div class="flex justify-between items-baseline py-0.5 mb-2">
          <span class="text-base-content/50 text-[11px]">Density</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="density-value">—</span>
        </div>
        <button class="btn btn-primary btn-sm w-full mt-0.5" data-action="calculate">Calculate</button>
        <div class="text-error text-[11px] mt-1.5 hidden" data-ref="error"></div>
      </div>
      <div class="mt-3 border-t border-base-content/[0.07] pt-2.5 hidden" data-ref="results">
        <div class="flex justify-between items-baseline py-0.5">
          <span class="text-base-content/50 text-[11px]">Volume</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="vol">—</span>
        </div>
        <div class="flex justify-between items-baseline py-0.5">
          <span class="text-base-content/50 text-[11px]">Surface Area</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="area">—</span>
        </div>
        <div class="flex justify-between items-baseline py-0.5">
          <span class="text-base-content/50 text-[11px]">Mass</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="mass">—</span>
        </div>
        <div class="flex justify-between items-baseline py-0.5 mt-1.5">
          <span class="text-base-content/50 text-[11px]">Center of Mass</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="centroid">—</span>
        </div>
      </div>
    `;
  }

  private bindRefs(): void {
    this.placeholderEl = this.panel.querySelector<HTMLDivElement>('[data-ref="placeholder"]')!;
    this.formEl = this.panel.querySelector<HTMLDivElement>('[data-ref="form"]')!;
    this.selectEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="material"]')!;
    this.materialSelectBlock = this.panel.querySelector<HTMLDivElement>('[data-ref="material-select-block"]')!;
    this.manageBtn = this.panel.querySelector<HTMLButtonElement>('[data-action="manage-materials"]')!;
    this.materialRow = this.panel.querySelector<HTMLDivElement>('[data-ref="material-row"]')!;
    this.materialVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="material-value"]')!;
    this.densityVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="density-value"]')!;
    this.lengthUnitEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="length-unit"]')!;
    this.massUnitEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="mass-unit"]')!;
    this.calcBtn = this.panel.querySelector<HTMLButtonElement>('[data-action="calculate"]')!;
    this.resultsEl = this.panel.querySelector<HTMLDivElement>('[data-ref="results"]')!;
    this.errorEl = this.panel.querySelector<HTMLDivElement>('[data-ref="error"]')!;
    this.volVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="vol"]')!;
    this.areaVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="area"]')!;
    this.massVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="mass"]')!;
    this.centroidVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="centroid"]')!;
    const modeHost = this.panel.querySelector<HTMLDivElement>('[data-ref="mode"]')!;
    this.modeTabs = new ChoiceTabs<ShapePropertiesMode>(modeHost, [
      { key: 'part', label: 'Part', title: 'A whole part: its final solids together, with the material its statement declares' },
      { key: 'solid', label: 'Solid', title: 'One solid: click a face or edge to pick it' },
    ], 'solid');
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  /** Part | Solid — which selection the panel measures. */
  get mode(): ShapePropertiesMode {
    return this.modeTabs.value;
  }

  /** The part the panel currently reads a material from (Part mode: the selection). */
  get selectedPart(): SceneObjectRender | null {
    return this.partRow;
  }

  setCentroidHandler(fn: (centroid: { x: number; y: number; z: number } | null) => void): void {
    this.centroidHandler = fn;
  }

  setOpenHandler(fn: () => void): void {
    this.openHandler = fn;
  }

  /** The current scene's rows — where a solid's part and a part's solids are looked up. */
  setSceneProvider(fn: () => SceneObjectRender[]): void {
    this.sceneProvider = fn;
  }

  /**
   * The timeline's selected part (`ActivePartTracker.selectedLocation`):
   * what Part mode shows until a viewport click picks another part.
   */
  setSelectedPartProvider(fn: () => SourceLocation | null): void {
    this.selectedPartProvider = fn;
  }

  /**
   * Part mode's selection changed (a viewport click, the timeline's part,
   * a re-render, or leaving Part mode with null) — the host highlights the
   * part's solids, or clears the highlight.
   */
  setPartSelectionHandler(fn: (part: SceneObjectRender | null) => void): void {
    this.partSelectionHandler = fn;
  }

  /**
   * What the Manage materials… link under the dropdown opens. The link
   * shows only with a handler and an editor-backed host (a read-only host
   * has no `fluidcad.json` to write).
   */
  setManageMaterialsHandler(fn: () => void): void {
    this.manageMaterialsHandler = fn;
    this.manageBtn.classList.toggle('hidden', this.client.editor === null);
  }

  private bindEvents(): void {
    this.btn.addEventListener('click', () => this.toggle());

    this.panel.querySelector('[data-action="panel-close"]')!.addEventListener('click', () => this.close());

    this.modeTabs.onChange = () => this.applyMode();

    this.selectEl.addEventListener('change', () => {
      this.transientMaterialId = this.selectEl.value || null;
      this.renderMaterial();
      this.renderResults();
    });

    this.lengthUnitEl.addEventListener('change', () => this.renderResults());
    this.massUnitEl.addEventListener('change', () => this.renderResults());

    this.calcBtn.addEventListener('click', () => void this.calculate());

    this.manageBtn.addEventListener('click', () => this.manageMaterialsHandler?.());
  }

  private toggle(): void {
    if (!this.panel.classList.contains('hidden')) {
      this.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    this.openHandler?.();
    this.panel.classList.remove('hidden');
    this.btn.className = 'btn btn-soft btn-primary btn-square btn-sm rounded-md absolute bottom-6 right-8 z-[100] panel-bg border border-base-content/10';
    if (this.mode === 'part' && this.partRow === null) {
      this.syncSelectedPart();
    }
  }

  private close(): void {
    this.panel.classList.add('hidden');
    this.btn.className = 'btn btn-ghost btn-square btn-sm rounded-md absolute bottom-6 right-8 z-[100] panel-bg border border-base-content/10 text-base-content/60';
  }

  private async loadMaterials(): Promise<void> {
    const materials = await this.client.getMaterials();
    if (!materials) {
      return;
    }
    this.applyMaterials(materials);
  }

  /**
   * Take a new merged list — after the Manage materials… dialog wrote
   * `fluidcad.json` — either the list its save answered, or a fresh fetch.
   * A transient pick that vanished from the list falls back to the first.
   */
  reloadMaterials(materials?: Material[]): Promise<void> {
    if (!materials) {
      return this.loadMaterials();
    }
    this.applyMaterials(materials);
    return Promise.resolve();
  }

  private applyMaterials(materials: Material[]): void {
    this.materials = materials;
    this.materialsById = new Map(materials.map((m) => [m.id, m]));
    this.fillMaterialSelect();
    if (this.transientMaterialId === null || !this.materialsById.has(this.transientMaterialId)) {
      this.transientMaterialId = materials[0]?.id ?? null;
    }
    this.renderMaterial();
    this.renderResults();
  }

  /** The dropdown for a solid outside any part: built-ins, then the project's own entries. */
  private fillMaterialSelect(): void {
    this.selectEl.innerHTML = '';
    const groups: { label: string; source: Material['source'] }[] = [
      { label: 'Built-in', source: 'builtin' },
      { label: 'Project', source: 'project' },
    ];
    for (const { label, source } of groups) {
      const entries = this.materials.filter((m) => m.source === source);
      if (entries.length === 0) {
        continue;
      }
      const group = document.createElement('optgroup');
      group.label = label;
      for (const mat of entries) {
        const opt = document.createElement('option');
        opt.value = mat.id;
        opt.textContent = mat.name;
        group.appendChild(opt);
      }
      this.selectEl.appendChild(group);
    }
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /**
   * Solid mode: the picked solid (null clears). Part mode: the part the
   * solid belongs to — the assembly measure selection and the highlight
   * messages arrive here whatever the mode.
   */
  setSelectedShape(shapeId: string | null): void {
    if (this.mode === 'part') {
      this.selectPartOfShape(shapeId);
      return;
    }
    if (shapeId === this.selectedShapeId) {
      return;
    }
    this.clearResults();
    this.selectedShapeId = shapeId;
    this.partRow = shapeId ? this.enclosingPartOfShape(shapeId) : null;
    this.renderSelection();
  }

  /**
   * Part mode: select the part the clicked shape belongs to. A click that
   * hits no shape, or a solid outside any part, falls back to the
   * timeline's selected part. Returns the part now selected (null: none).
   */
  selectPartOfShape(shapeId: string | null): SceneObjectRender | null {
    const part = (shapeId ? this.enclosingPartOfShape(shapeId) : null) ?? this.trackedPart();
    this.setSelectedPart(part);
    return this.partRow;
  }

  /**
   * Part mode follows the timeline: call after a part row click changed the
   * tracked part (its normal activate/step-out semantics are untouched).
   */
  syncSelectedPart(): void {
    if (this.mode !== 'part') {
      return;
    }
    this.setSelectedPart(this.trackedPart());
  }

  /**
   * A new scene: scene ids are minted per build, so the part in hand is
   * re-adopted by source identity. The material rows re-read the part row
   * (Set material… just re-rendered it); Part mode's numbers are re-fetched
   * when they were showing, Solid mode's mass follows the new density.
   */
  onSceneRendered(): void {
    const scene = this.sceneProvider();
    if (this.partRow) {
      this.partRow = findMatchingRow(this.partRow, scene) ?? null;
    }
    if (this.mode === 'part') {
      if (this.partRow === null) {
        this.partRow = this.trackedPart();
      }
      const hadResults = this.partProps !== null;
      this.partProps = null;
      this.renderSelection();
      this.partSelectionHandler?.(this.partRow);
      if (hadResults && this.partRow?.id) {
        void this.calculate();
      }
      return;
    }
    this.renderMaterial();
    this.renderResults();
  }

  private setSelectedPart(part: SceneObjectRender | null): void {
    const same = part === this.partRow || (part != null && this.partRow != null && part.id === this.partRow.id);
    if (!same) {
      this.clearResults();
      this.partRow = part;
    }
    this.renderSelection();
    this.partSelectionHandler?.(this.partRow);
  }

  /** The timeline's selected part as a row of the current scene. */
  private trackedPart(): SceneObjectRender | null {
    const loc = this.selectedPartProvider();
    if (!loc) {
      return null;
    }
    return this.sceneProvider().find((o) => o.type === 'part' && !o.parentId
      && o.sourceLocation?.filePath === loc.filePath && o.sourceLocation?.line === loc.line) ?? null;
  }

  /**
   * The part a shape belongs to: the owning row's nearest `part` ancestor
   * (an assembly's template rows included — an instance click carries the
   * template's shape id). Null for a shape outside any part.
   */
  private enclosingPartOfShape(shapeId: string): SceneObjectRender | null {
    const scene = this.sceneProvider();
    const owner = scene.find((o) => o.sceneShapes?.some((s) => s.shapeId === shapeId)
      || o.ownShapes?.some((s) => s.shapeId === shapeId));
    if (!owner) {
      return null;
    }
    if (owner.type === 'part') {
      return owner;
    }
    return findEnclosingPartRow(owner, scene) ?? null;
  }

  /**
   * The ids of a part's final solids — every non-meta `solid` scene shape
   * on rows whose nearest part ancestor is the part — what a Part-mode
   * highlight paints and the server sums.
   */
  static partSolidShapeIds(part: SceneObjectRender, scene: SceneObjectRender[]): string[] {
    const index = SceneIndex.of(scene);
    const ids: string[] = [];
    for (const row of scene) {
      const owner = row === part ? part : index.enclosing(row, 'part');
      if (owner !== part) {
        continue;
      }
      for (const shape of row.sceneShapes ?? []) {
        if (shape.shapeId && shape.shapeType === 'solid' && !shape.isMetaShape) {
          ids.push(shape.shapeId);
        }
      }
    }
    return ids;
  }

  private applyMode(): void {
    this.clearResults();
    if (this.mode === 'part') {
      this.partRow = this.trackedPart();
      this.renderSelection();
      this.partSelectionHandler?.(this.partRow);
      return;
    }
    this.partRow = this.selectedShapeId ? this.enclosingPartOfShape(this.selectedShapeId) : null;
    this.renderSelection();
    this.partSelectionHandler?.(null);
  }

  private clearResults(): void {
    this.rawProps = null;
    this.partProps = null;
    this.resultsEl.classList.add('hidden');
    this.errorEl.classList.add('hidden');
    this.centroidHandler?.(null);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private renderSelection(): void {
    const hasSelection = this.mode === 'part' ? this.partRow !== null : this.selectedShapeId !== null;
    if (hasSelection) {
      this.placeholderEl.classList.add('hidden');
      this.formEl.classList.remove('hidden');
    } else {
      this.placeholderEl.textContent = this.mode === 'part'
        ? 'Select a part: click one of its solids, or its timeline row'
        : 'Select a shape to view its properties';
      this.placeholderEl.classList.remove('hidden');
      this.formEl.classList.add('hidden');
    }
    this.renderMaterial();
  }

  /** The material in force for the selection, and whether it is part-owned. */
  private resolveMaterial(): ResolvedMaterial {
    const partMaterial = this.partRow?.object?.material;
    if (typeof partMaterial === 'string' && partMaterial !== '') {
      return { id: partMaterial, material: this.findMaterial(partMaterial), owner: 'part' };
    }
    if (this.mode === 'solid') {
      const id = this.transientMaterialId;
      return { id, material: id ? this.findMaterial(id) : undefined, owner: id ? 'transient' : 'none' };
    }
    return { id: null, material: undefined, owner: 'none' };
  }

  private findMaterial(id: string): Material | undefined {
    return this.materialsById.get(id);
  }

  /** The Material and Density rows: the dropdown only for a solid no part owns. */
  private renderMaterial(): void {
    const resolved = this.resolveMaterial();
    const editable = this.mode === 'solid' && resolved.owner !== 'part';
    this.materialSelectBlock.classList.toggle('hidden', !editable);
    this.materialRow.classList.toggle('hidden', editable);
    if (editable) {
      if (resolved.id !== null && this.selectEl.value !== resolved.id) {
        this.selectEl.value = resolved.id;
      }
    } else {
      this.materialVal.textContent = ShapePropertiesModal.materialLabel(resolved);
      this.materialVal.title = resolved.id ?? '';
    }
    const density = ShapePropertiesModal.densityLabel(resolved);
    this.densityVal.textContent = density;
  }

  private static materialLabel(resolved: ResolvedMaterial): string {
    if (resolved.id === null) {
      return 'None';
    }
    return resolved.material ? resolved.material.name : `Unknown material: ${resolved.id}`;
  }

  private static densityLabel(resolved: ResolvedMaterial): string {
    const material = resolved.material;
    if (!material) {
      return '—';
    }
    return `${ShapePropertiesModal.formatDensity(material.density)} ${material.densityUnit}`;
  }

  private static formatDensity(value: number): string {
    if (value === 0) {
      return '0';
    }
    return parseFloat(value.toPrecision(6)).toString();
  }

  /** The resolved material's density in g/cm³, or null when unknown. */
  private densityGcm3(): number | null {
    const material = this.resolveMaterial().material;
    if (!material) {
      return null;
    }
    return ShapePropertiesModal.densityToGcm3(material.density, material.densityUnit);
  }

  /** Convert density from its native material unit to canonical g/cm³. */
  private static densityToGcm3(value: number, unit: string): number {
    switch (unit) {
      case 'kg/m³': return value * 0.001;
      case 'g/mm³': return value * 1000;
      case 'lbs/in³': return value * 27.6799;
      default: return value; // g/cm³
    }
  }

  /**
   * cm³ contained in one cube of the given length unit — the bridge between
   * a g/cm³ density and a volume in any of the display units.
   */
  private static cm3PerUnit(lengthUnit: LengthUnit): number {
    const cmPerUnit = convertLength(1, lengthUnit, 'cm');
    return cmPerUnit * cmPerUnit * cmPerUnit;
  }

  private async calculate(): Promise<void> {
    if (this.mode === 'part') {
      await this.calculatePart();
      return;
    }
    if (!this.selectedShapeId) {
      return;
    }
    this.calcBtn.disabled = true;
    this.errorEl.classList.add('hidden');
    this.resultsEl.classList.add('hidden');
    try {
      this.rawProps = await this.client.getShapeProperties(this.selectedShapeId);
      if (!this.rawProps) {
        this.showError('Failed to calculate properties.');
        return;
      }
      this.renderResults();
    } catch {
      this.showError('Network error while fetching properties.');
    } finally {
      this.calcBtn.disabled = false;
    }
  }

  private async calculatePart(): Promise<void> {
    const partId = this.partRow?.id;
    if (!partId) {
      return;
    }
    if (!this.client.getPartProperties) {
      this.showError('Part properties are not available in this host.');
      return;
    }
    this.calcBtn.disabled = true;
    this.errorEl.classList.add('hidden');
    this.resultsEl.classList.add('hidden');
    try {
      this.partProps = await this.client.getPartProperties(partId);
      if (!this.partProps) {
        this.showError('Failed to calculate part properties.');
        return;
      }
      this.renderResults();
    } catch {
      this.showError('Network error while fetching properties.');
    } finally {
      this.calcBtn.disabled = false;
    }
  }

  /** The rows to show for the mode's last computation, or null before one. */
  private readout(): PropertiesReadout | null {
    if (this.mode === 'part') {
      const props = this.partProps;
      if (!props) {
        return null;
      }
      return {
        volume: props.volumeMm3,
        surfaceArea: props.surfaceAreaMm2,
        centroid: props.centroid,
        massG: typeof props.massG === 'number' ? props.massG : null,
        unit: props.unit && isLengthUnit(props.unit) ? props.unit : sceneUnit.current,
      };
    }
    const props = this.rawProps;
    if (!props) {
      return null;
    }
    // `volumeMm3` is a field NAME only — the value is in the document unit³.
    const unit = props.unit && isLengthUnit(props.unit) ? props.unit : sceneUnit.current;
    const density = this.densityGcm3();
    // Mass = volume in document unit³ × grams per document unit³.
    const massG = density === null ? null : props.volumeMm3 * density * ShapePropertiesModal.cm3PerUnit(unit);
    return { volume: props.volumeMm3, surfaceArea: props.surfaceAreaMm2, centroid: props.centroid, massG, unit };
  }

  private renderResults(): void {
    const readout = this.readout();
    if (!readout) {
      return;
    }

    const lengthUnit: LengthUnit = isLengthUnit(this.lengthUnitEl.value) ? this.lengthUnitEl.value : sceneUnit.current;
    const massUnit = this.massUnitEl.value;

    // Convert from the readout's own unit, not from mm.
    const f = convertLength(1, readout.unit, lengthUnit);
    const vol = formatVolume(readout.volume * f * f * f, lengthUnit, { decimals: 4 });
    const area = formatArea(readout.surfaceArea * f * f, lengthUnit, { decimals: 4 });

    let mass = '—';
    if (readout.massG !== null) {
      if (massUnit === 'kg') {
        mass = `${(readout.massG / 1000).toFixed(4)} kg`;
      } else if (massUnit === 'lbs') {
        mass = `${(readout.massG / 453.592).toFixed(4)} lbs`;
      } else {
        mass = `${readout.massG.toFixed(4)} g`;
      }
    }

    const { centroid } = readout;
    const coord = (v: number) => formatLength(v * f, lengthUnit, { decimals: 4, suffix: false });
    const centroidText = `(${coord(centroid.x)}, ${coord(centroid.y)}, ${coord(centroid.z)}) ${lengthUnit}`;

    this.volVal.textContent = vol;
    this.areaVal.textContent = area;
    this.massVal.textContent = mass;
    this.centroidVal.textContent = centroidText;
    this.resultsEl.classList.remove('hidden');
    this.centroidHandler?.(centroid);
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.classList.remove('hidden');
  }

  // kept for backward compat with WS message
  show(shapeId: string): void {
    this.setSelectedShape(shapeId);
    this.open();
  }
}
