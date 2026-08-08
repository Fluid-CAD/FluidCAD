import { SelectedEntity, Viewer } from '../viewer';

/**
 * Whole-solid pick selection: any face or edge click selects the owning
 * shape, highlighted in full — the shape-properties panel's picker (single
 * mode) and the copy dialog's targets picker (multiple mode) share it. The
 * class owns the picked shape ids and the whole-shape highlight; callers
 * that combine the highlight with other selections (a picked axis edge, an
 * axis statement's dashed line) pass those through {@link refreshHighlight}.
 * Shape ids die with every render — owners re-{@link set} them from the
 * fresh scene.
 */
export class SolidPickSelection {
  private ids: string[] = [];

  constructor(
    private viewer: Viewer,
    private opts: { multiple?: boolean } = {},
  ) {}

  get selection(): readonly string[] {
    return this.ids;
  }

  /** The single-mode selection, or the first pick. */
  get first(): string | null {
    return this.ids[0] ?? null;
  }

  has(shapeId: string): boolean {
    return this.ids.includes(shapeId);
  }

  /**
   * Route a viewport click: a shape click selects the whole shape — in
   * multiple mode it toggles membership instead. An empty-space click clears
   * a single selection but keeps a multiple one (mid-composition misses
   * shouldn't wipe the set). Returns whether the selection changed.
   */
  handleClick(shapeId: string | null): boolean {
    if (!shapeId) {
      if (this.opts.multiple || this.ids.length === 0) {
        return false;
      }
      this.clear();
      return true;
    }
    if (this.opts.multiple) {
      this.ids = this.has(shapeId) ? this.ids.filter(id => id !== shapeId) : [...this.ids, shapeId];
    } else {
      if (this.ids.length === 1 && this.ids[0] === shapeId) {
        return false;
      }
      this.ids = [shapeId];
    }
    this.refreshHighlight();
    return true;
  }

  /** Replace the selection (an owner re-syncing after a render). No repaint. */
  set(shapeIds: string[]): void {
    this.ids = [...shapeIds];
  }

  clear(): void {
    this.ids = [];
    this.viewer.clearHighlight();
  }

  /**
   * Repaint the whole-shape highlight, optionally combined with the owner's
   * other picks in the same pass (the viewer replaces the previous highlight
   * wholesale) — picked entities, axis/wire lines, and construction-plane
   * quads (the mirror dialog's chosen plane feature).
   */
  refreshHighlight(
    extras: { entities?: SelectedEntity[]; wireIds?: string[]; planeQuadIds?: string[] } = {},
  ): void {
    const entities = extras.entities ?? [];
    const wireIds = extras.wireIds ?? [];
    const planeQuadIds = extras.planeQuadIds ?? [];
    if (this.ids.length === 0 && entities.length === 0 && wireIds.length === 0
      && planeQuadIds.length === 0) {
      this.viewer.clearHighlight();
      return;
    }
    this.viewer.highlightEntities(entities, wireIds, this.ids, planeQuadIds);
  }
}
