/**
 * Keeps the open model current with the files it is built from: a change on
 * disk to any input of its render other than the model file itself — a
 * module it imports, directly or through another (a `*.feature.js`, a
 * helper, the part file an assembly inserts), `fluidcad.json`, a file the
 * engine read — re-renders it. One server-side rule for every host: saving
 * an imported module in VS Code, Neovim, the in-page editor or any other
 * program lands on disk, where the workspace watcher sees it, while no host
 * sends anything for a file that is not a model.
 *
 * The model file's own edits keep their existing paths (an editor host's
 * live update or save, the CLI watcher in `fluidcad serve`), so they are
 * never rendered twice. Changes are gathered over a short window, so a
 * burst — a `git checkout`, a save that touches several modules — renders
 * once, and whether the render is behind is asked when the window closes, so
 * a render something else already ran is not repeated.
 */
export class RenderInputChanges {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: {
    /** Whether a change to this file left the open model's render behind its inputs. */
    isRenderBehind: (absPath: string) => boolean;
    /** Render the open model again. */
    rerender: () => Promise<void>;
    /** How long changes are gathered before the check (default 50ms). */
    delayMs?: number;
  }) {}

  /** A workspace file was added, changed or removed on disk. */
  note(absPath: string): void {
    this.pending.add(absPath);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.deps.delayMs ?? 50);
    }
  }

  /**
   * Close the window: re-render once when any gathered change left the
   * render behind. Resolves whether it rendered. The timer calls this; a
   * test calls it directly.
   */
  async flush(): Promise<boolean> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const changed = [...this.pending];
    this.pending.clear();
    if (!changed.some(absPath => this.deps.isRenderBehind(absPath))) {
      return false;
    }
    try {
      await this.deps.rerender();
    } catch (err: any) {
      console.warn(`FluidCAD: re-rendering after a dependency change failed: ${err?.message ?? err}`);
    }
    return true;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }
}
