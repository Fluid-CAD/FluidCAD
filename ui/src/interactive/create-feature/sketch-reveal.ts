import { sourceLocKey } from '../../helpers/scene-utils';
import type { SketchProfileOption } from './sketch-profiles';

/**
 * The consumed sketches open dialogs reveal in the viewport while they are
 * a slot's pick: a sketch its extrude hid draws nothing, so the dialog that
 * took it as the profile shows its wires for as long as it holds it. One
 * registry for every slot; the viewer takes the whole set (see
 * `Viewer.setRevealedSketches`).
 *
 * A slot's entry counts only while its host is on screen — the panels hide
 * rather than tear down between uses — so the shell's show/hide/destroy
 * refresh the set as well as the slots' own state changes.
 */
class SketchReveal {
  /** Receives the source-location keys to reveal whenever the set changes. */
  onChange?: (keys: string[]) => void;

  private readonly slots = new Map<object, { host: HTMLElement; option: SketchProfileOption | null }>();
  private lastKeys = '';

  /** A slot's pick changed: `null` for no pick (or a sketch that still renders). */
  set(slot: object, host: HTMLElement, option: SketchProfileOption | null): void {
    this.slots.set(slot, { host, option: option?.consumer ? option : null });
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
      if (!entry.option || entry.host.closest('.hidden')) {
        continue;
      }
      keys.add(sourceLocKey({ filePath: entry.option.filePath, line: entry.option.line, column: entry.option.column }));
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

export const sketchReveal = new SketchReveal();
