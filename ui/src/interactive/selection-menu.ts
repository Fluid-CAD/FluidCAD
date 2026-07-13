import { fetchSelectionGroups, SelectionBoundaryRef, SelectionGroup, SelectionGroupKind } from '../api';
import type { SelectedEntity } from '../viewer';

export type SelectionMenuHandlers = {
  /** Which server group kinds this pick mode offers, in menu order. */
  kinds: SelectionGroupKind[];
  /** A group item was clicked — select all of `members` (`seed` included for the seed's own groups). */
  onSelectGroup: (kind: SelectionGroupKind, seed: SelectedEntity, members: SelectedEntity[]) => void;
  /** Hover preview: what the hovered item would select; null when the hover ends. */
  onPreview: (members: SelectedEntity[] | null) => void;
  /**
   * Edit-session boundary provider: while a statement's sources are being
   * re-picked, the groups resolve against the scene before that statement.
   */
  boundary?: () => SelectionBoundaryRef | undefined;
};

const ITEM_CLASS = 'block w-full text-left px-3 py-1.5 hover:bg-base-200 cursor-pointer whitespace-nowrap';
const MUTED_CLASS = 'px-3 py-1.5 text-base-content/50 whitespace-nowrap select-none';

/**
 * Shared right-click menu for edge/face picking (neutral mode, fillet/
 * chamfer/shell, the sweep path): multi-select groups fetched from the
 * server — tangent chain, classified bucket ("Extrude End Edges"),
 * same-type and equal-measure edges — plus "Select other" listing the
 * producing feature's other classified buckets (a startEdges pick offers
 * End Edges, Side Edges, …). Hovering any item previews exactly what
 * clicking it would select.
 */
export class SelectionContextMenu {
  private el: HTMLDivElement;
  private openSeq = 0;

  constructor(
    private container: HTMLElement,
    id: string,
    private handlers: SelectionMenuHandlers,
  ) {
    this.el = document.createElement('div');
    this.el.id = id;
    this.el.className = 'hidden absolute z-[1002] min-w-44 bg-base-100 border border-base-300 rounded-lg shadow-lg py-1 text-xs';
    container.appendChild(this.el);
    this.el.addEventListener('mouseleave', () => this.handlers.onPreview(null));
    document.addEventListener('click', (e) => {
      if (this.isOpen && !this.el.contains(e.target as Node)) {
        this.hide();
      }
    });
    // Capture phase: an Escape that closes the menu must not also reach a
    // pick mode's own Escape handler (which would exit the whole mode).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    }, true);
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /**
   * Open at the cursor for `seed`. The items stream in when the server
   * responds; a menu hidden or re-opened in the meantime drops the stale
   * response, and a pick with nothing to offer closes silently.
   */
  async open(seed: SelectedEntity, clientX: number, clientY: number): Promise<void> {
    const seq = ++this.openSeq;
    this.el.replaceChildren(this.mutedRow('Loading…'));
    const rect = this.container.getBoundingClientRect();
    this.el.style.left = `${clientX - rect.left}px`;
    this.el.style.top = `${clientY - rect.top}px`;
    this.el.classList.remove('hidden');

    const result = await fetchSelectionGroups(seed, this.handlers.boundary?.());
    if (seq !== this.openSeq || !this.isOpen) {
      return;
    }
    const offered = ('groups' in result ? result.groups : [])
      .filter(g => this.handlers.kinds.includes(g.kind))
      .map(g => ({ ...g, members: g.members.map(m => ({ shapeId: m.shapeId, sub: m.sub })) }));
    const main = offered.filter(g => g.kind !== 'sibling');
    const siblings = offered.filter(g => g.kind === 'sibling');
    if (main.length === 0 && siblings.length === 0) {
      this.hide();
      return;
    }
    this.el.replaceChildren(
      ...main.map(g => this.item(seed, g)),
      ...this.siblingsSection(seed, siblings, main.length > 0),
    );
  }

  hide(): void {
    if (!this.isOpen) {
      return;
    }
    this.openSeq++;
    this.el.classList.add('hidden');
    this.handlers.onPreview(null);
  }

  /** The producing feature's other buckets, under a "Select other" header. */
  private siblingsSection(seed: SelectedEntity, siblings: SelectionGroup[], divide: boolean): HTMLElement[] {
    if (siblings.length === 0) {
      return [];
    }
    const header = this.mutedRow('Select other');
    header.className = `${MUTED_CLASS} text-[10px] uppercase tracking-wide pt-2 ${divide ? 'border-t border-base-300 mt-1' : ''}`;
    return [header, ...siblings.map(g => this.item(seed, g))];
  }

  private item(seed: SelectedEntity, group: SelectionGroup): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = ITEM_CLASS;
    button.textContent = `${group.label} (${group.members.length})`;
    button.addEventListener('mouseenter', () => this.handlers.onPreview(group.members));
    button.addEventListener('click', () => {
      this.hide();
      this.handlers.onSelectGroup(group.kind, seed, group.members);
    });
    return button;
  }

  /** A non-interactive row; hovering it ends any item preview. */
  private mutedRow(text: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = MUTED_CLASS;
    row.textContent = text;
    row.addEventListener('mouseenter', () => this.handlers.onPreview(null));
    return row;
  }
}
