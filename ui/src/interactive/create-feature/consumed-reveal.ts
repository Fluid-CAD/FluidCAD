import { sourceLocKey } from '../../helpers/scene-utils';
import type { SourceLocation } from '../../types';

/**
 * The consumed objects open dialogs reveal in the viewport while they are a
 * slot's pick: a sketch its extrude hid, a plane its sketch took, an axis its
 * revolve turned around draw nothing, so the dialog that took one as its pick
 * shows it for as long as it holds it. One registry for every slot; the
 * viewer takes the whole set (see `Viewer.setRevealed`).
 *
 * A slot's entry counts only while its host is on screen — the panels hide
 * rather than tear down between uses — so the shell's show/hide/destroy
 * refresh the set as well as the slots' own state changes.
 */
class ConsumedReveal {
  /** Receives the source-location keys to reveal whenever the set changes. */
  onChange?: (keys: string[]) => void;

  private readonly slots = new Map<object, { host: HTMLElement; loc: SourceLocation | null }>();
  private lastKeys = '';

  /**
   * A slot's pick changed: the source location of a consumed pick, or `null`
   * for no pick and for one that still renders.
   */
  set(slot: object, host: HTMLElement, loc: SourceLocation | null): void {
    this.slots.set(slot, { host, loc });
    this.refresh();
  }

  /** Recompute the set from the slots still on screen and notify on a change. */
  refresh(): void {
    const keys = new Set<string>();
    for (const [slot, entry] of this.slots) {
      if (!entry.host.isConnected) {
        this.slots.delete(slot);
        continue;
      }
      if (!entry.loc || entry.host.closest('.hidden')) {
        continue;
      }
      keys.add(sourceLocKey(entry.loc));
    }
    const list = [...keys].sort();
    const signature = list.join('|');
    if (signature === this.lastKeys) {
      return;
    }
    this.lastKeys = signature;
    this.onChange?.(list);
  }
}

export const consumedReveal = new ConsumedReveal();
