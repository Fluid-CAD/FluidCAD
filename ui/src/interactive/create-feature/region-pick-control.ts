/** What the region row shows: the pick count, whether picking is live, and whether it can start. */
export type RegionPickState = {
  /** How many regions the dialog holds picked. */
  count: number;
  /** Region picking is live in the viewport. */
  active: boolean;
  /** A profile the regions can be read from is chosen — the link needs one. */
  available: boolean;
};

/**
 * The region row under a profile slot: a small right-aligned link that turns
 * region picking on in the viewport ("Pick regions", then "Done"), with the
 * pick count and its ✕ beside it once anything is picked. Pure DOM — the
 * service owns the picks, the overlay and the viewport mode, and repaints
 * this row through {@link setState}. Nothing shows until a profile is
 * chosen or a pick exists.
 */
export class RegionPickControl {
  /** The link was clicked — start picking, or finish. */
  onToggle?: () => void;
  /** The ✕ was clicked — drop every pick. */
  onClear?: () => void;

  private readonly countEl: HTMLSpanElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly hintEl: HTMLSpanElement;
  private readonly linkBtn: HTMLButtonElement;

  constructor(private readonly host: HTMLElement) {
    host.className = 'flex items-center justify-end gap-2 text-[11px] leading-none hidden';

    const picks = document.createElement('span');
    picks.className = 'flex items-center gap-0.5';
    this.countEl = document.createElement('span');
    this.countEl.className = 'text-base-content/70 tabular-nums';
    this.clearBtn = document.createElement('button');
    this.clearBtn.type = 'button';
    this.clearBtn.className = 'btn btn-ghost btn-xs btn-square h-4 w-4 min-h-0 text-[9px] text-base-content/50 hover:text-base-content';
    this.clearBtn.title = 'Clear the picked regions';
    this.clearBtn.textContent = '✕';
    this.clearBtn.addEventListener('click', () => this.onClear?.());
    picks.append(this.countEl, this.clearBtn);

    this.hintEl = document.createElement('span');
    this.hintEl.className = 'text-base-content/50';
    this.hintEl.textContent = 'Click regions in the view';

    this.linkBtn = document.createElement('button');
    this.linkBtn.type = 'button';
    this.linkBtn.className = 'text-primary hover:underline';
    this.linkBtn.addEventListener('click', () => this.onToggle?.());

    host.append(picks, this.hintEl, this.linkBtn);
    this.setState({ count: 0, active: false, available: false });
  }

  setState(state: RegionPickState): void {
    const hasPicks = state.count > 0;
    this.host.classList.toggle('hidden', !state.available && !hasPicks);
    this.countEl.textContent = `${state.count} ${state.count === 1 ? 'region' : 'regions'}`;
    this.countEl.parentElement!.classList.toggle('hidden', !hasPicks);
    this.hintEl.classList.toggle('hidden', !state.active || hasPicks);
    this.linkBtn.classList.toggle('hidden', !state.available);
    this.linkBtn.textContent = state.active ? 'Done' : 'Pick regions';
    this.linkBtn.title = state.active
      ? 'Stop picking regions'
      : 'Show the regions of the sketch in the viewport and click the ones to build';
  }
}
