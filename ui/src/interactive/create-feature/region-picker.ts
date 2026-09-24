import { fetchSketchRegions, RegionPick, SketchRegionEntry } from '../../api';
import { Viewer } from '../../viewer';
import { RegionPickMode } from '../region-pick-mode';
import { RegionPickControl } from './region-pick-control';
import { RegionPickOverlay } from './region-pick-overlay';

/** The producing statement of the profile whose regions are picked. */
export type RegionProfileRef = { filePath: string; line: number };

/**
 * The region picks of a swept-feature dialog (extrude, revolve, sweep,
 * wrap): the regions the statement will name, the viewport mode that picks
 * them, and the row under the profile slot that shows them.
 *
 * The picks are dialog state like the scope chips — nothing is written
 * until Apply. "Pick regions" fetches every region of the chosen profile
 * from the server's side channel, draws them as a translucent overlay and
 * routes viewport clicks to it (the viewer's own picking is suspended for
 * the duration — a click on a region must not also land on the face behind
 * it); a click toggles the region, "Done" or arming another slot ends the
 * mode. A pick travels as the region's declared name when the sketch
 * already declares it, else as its boundary, which Apply declares. The
 * picks follow the profile: choosing a different sketch drops them (its
 * regions mean nothing there), and an edit session's seed — the statement's
 * own names — comes back when the slot returns to that sketch.
 */
export class RegionPicker {
  private picked: RegionPick[] = [];
  private profile: RegionProfileRef | null = null;
  private active = false;
  private regions: SketchRegionEntry[] = [];
  /** Edit mode: the statement's own picks, and the profile they belong to once known. */
  private seeded: { picks: RegionPick[]; profile: RegionProfileRef | null } | null = null;
  private overlay: RegionPickOverlay;
  private mode: RegionPickMode | null = null;
  private abort: AbortController | null = null;
  private seq = 0;

  constructor(
    private viewer: Viewer,
    private control: RegionPickControl,
    private hooks: {
      /** The profile the dialog currently consumes, or null while there is none to read. */
      profile: () => RegionProfileRef | null;
      /** The picks changed — the dialog re-previews. */
      onChange: () => void;
    },
  ) {
    this.overlay = new RegionPickOverlay(viewer);
    this.control.onToggle = () => this.toggle();
    this.control.onClear = () => this.clear();
  }

  /** The picks, in pick order — what the apply writes; empty writes no chain. */
  get picks(): RegionPick[] {
    return this.picked.map(pick => ({ ...pick, ...(pick.items ? { items: pick.items.map(item => ({ ...item })) } : {}) }));
  }

  /**
   * The picks for a ghost request. Absent while nothing is picked and the
   * mode is off (every region builds — what Apply writes). While picking is
   * live an empty list travels instead, so the ghost builds nothing until a
   * region is clicked: the overlay is the thing to look at, and a full
   * extrusion drawn over it would say the opposite of what the picks do.
   */
  ghostPicks(): RegionPick[] | undefined {
    return this.active || this.picked.length > 0 ? this.picks : undefined;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Edit mode: start from the statement's own region names. Their profile
   * is not known yet (the keep chip resolves it asynchronously); the first
   * profile {@link sync} sees is theirs.
   */
  seed(names: string[]): void {
    const picks = names.map(name => ({ name }));
    this.seeded = { picks, profile: this.profile };
    this.picked = picks.map(pick => ({ ...pick }));
    this.render();
  }

  /**
   * Re-read the dialog's profile. A move from one sketch to another drops
   * the picks (or restores the edit seed when the slot returns to its
   * sketch); the first profile an edit session resolves adopts the seed.
   * Live picking refetches for the new profile.
   */
  sync(): void {
    const next = this.hooks.profile();
    const prev = this.profile;
    if (sameProfile(prev, next)) {
      return;
    }
    this.profile = next;
    if (this.seeded && this.seeded.profile === null && prev === null && next) {
      this.seeded.profile = next;
    } else if (prev && next) {
      this.picked = this.seeded && sameProfile(this.seeded.profile, next) ? this.seeded.picks.map(pick => ({ ...pick })) : [];
    }
    this.regions = [];
    if (this.active) {
      if (next) {
        void this.fetch();
      } else {
        this.stop();
      }
    }
    this.render();
  }

  /** The scene re-rendered under the dialog — the drawn regions may be stale. */
  refresh(): void {
    if (this.active && this.profile) {
      void this.fetch();
    }
  }

  /** Turn viewport region picking on: fetch the regions and draw them. */
  start(): void {
    if (this.active || !this.profile) {
      return;
    }
    this.active = true;
    this.viewer.isRegionPicking = true;
    this.mode = new RegionPickMode(this.viewer.sceneContext, this.overlay.root, {
      onPick: (key) => this.togglePick(key, true),
      onRemove: (key) => this.togglePick(key, false),
    });
    this.mode.activate();
    void this.fetch();
    this.render();
    // The ghost reads the mode too (see ghostPicks) — re-preview.
    this.hooks.onChange();
  }

  /** Leave viewport region picking; the picks stay. */
  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.cancelFetch();
    this.mode?.deactivate();
    this.mode = null;
    this.overlay.clear();
    this.viewer.isRegionPicking = false;
    this.render();
    this.hooks.onChange();
  }

  /** Back to nothing: no picks, no seed, no profile, no mode. */
  reset(): void {
    this.stop();
    this.picked = [];
    this.seeded = null;
    this.profile = null;
    this.regions = [];
    this.render();
  }

  private toggle(): void {
    if (this.active) {
      this.stop();
    } else {
      this.start();
    }
  }

  private clear(): void {
    if (this.picked.length === 0) {
      return;
    }
    this.picked = [];
    for (const region of this.regions) {
      region.selected = false;
    }
    this.redraw();
    this.render();
    this.hooks.onChange();
  }

  /**
   * A region was clicked. The new list is the regions currently lit plus or
   * minus that one — a seeded name that no longer resolves to a region
   * drops out the first time the user touches the set, exactly as the
   * kernel would have ignored it. A lit region travels by its declared name
   * when it has one, else by its boundary; a region whose boundary cannot
   * be written (no source locations) is left unpicked.
   */
  private togglePick(key: string, picked: boolean): void {
    for (const region of this.regions) {
      if (region.key === key) {
        region.selected = picked;
      }
    }
    this.picked = this.regions
      .filter(region => region.selected && (region.name !== null || region.items.length > 0))
      .map(region => ({
        ...(region.name !== null ? { name: region.name } : {}),
        ...(region.items.length > 0 ? { items: region.items } : {}),
      }));
    this.redraw();
    this.render();
    this.hooks.onChange();
  }

  private async fetch(): Promise<void> {
    const profile = this.profile;
    if (!profile) {
      return;
    }
    this.cancelFetch();
    const seq = ++this.seq;
    const abort = new AbortController();
    this.abort = abort;
    let regions: SketchRegionEntry[] | null;
    try {
      regions = await fetchSketchRegions({ profile, picks: this.picks }, abort.signal);
    } catch {
      return; // aborted
    }
    if (seq !== this.seq || !this.active) {
      return;
    }
    this.regions = regions ?? [];
    this.redraw();
  }

  private cancelFetch(): void {
    this.abort?.abort();
    this.abort = null;
    this.seq++;
  }

  private redraw(): void {
    if (!this.active) {
      return;
    }
    // The tinted mesh is about to be replaced; the mode must not restore a
    // color onto a disposed material.
    this.mode?.forgetHighlight();
    this.overlay.set(this.regions);
  }

  private render(): void {
    this.control.setState({
      count: this.picked.length,
      active: this.active,
      available: this.profile !== null,
    });
  }
}

function sameProfile(a: RegionProfileRef | null, b: RegionProfileRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.filePath === b.filePath && a.line === b.line;
}
