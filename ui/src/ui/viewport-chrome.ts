type Listener = (dialogOpen: boolean) => void;

/**
 * Tracks whether a feature dialog is docked in the top-right corner of the
 * viewport. While one is open the settings / fit-to-view / parameters button
 * stack hides, so the dialog can sit directly under the viewport gizmo instead
 * of being pushed below the buttons.
 *
 * Dialogs register by id so overlapping open/close sequences (e.g. an edit
 * dialog handing off to another) can't leave the buttons hidden for good.
 */
type DialogsListener = (openIds: ReadonlySet<string>) => void;

class ViewportChrome {
  private openDialogs = new Set<string>();
  private listeners = new Set<Listener>();
  private dialogsListeners = new Set<DialogsListener>();

  get dialogOpen(): boolean {
    return this.openDialogs.size > 0;
  }

  /**
   * The open dialogs' root elements — for overlays that share screen space
   * with the mobile bottom sheet and need to measure clear of it.
   */
  get openDialogElements(): HTMLElement[] {
    return [...this.openDialogs]
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
  }

  setDialogOpen(id: string, open: boolean): void {
    const wasOpen = this.dialogOpen;
    const had = this.openDialogs.has(id);
    if (open) {
      this.openDialogs.add(id);
    } else {
      this.openDialogs.delete(id);
    }
    if (wasOpen !== this.dialogOpen) {
      for (const fn of this.listeners) {
        fn(this.dialogOpen);
      }
    }
    if (had !== open) {
      for (const fn of this.dialogsListeners) {
        fn(this.openDialogs);
      }
    }
  }

  /**
   * Subscribe to every change of the open set — which dialogs, not just
   * whether any is open — for a dialog that must step aside when another
   * one arrives.
   */
  subscribeDialogs(fn: DialogsListener): () => void {
    this.dialogsListeners.add(fn);
    return () => {
      this.dialogsListeners.delete(fn);
    };
  }

  /** Subscribe and receive the current state immediately. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.dialogOpen);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const viewportChrome = new ViewportChrome();
